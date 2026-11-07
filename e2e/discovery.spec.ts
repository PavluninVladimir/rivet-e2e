import { expect, test, type Page } from '@playwright/test'
import { addInterviewText, createProject, expectNodeStatus, login, node, openProject, withFakeModel } from './helpers'

// Исследование продукта (add-product-discovery): интервью, анализ
// Аналитиком на fake-llm, персоны и потребности с цитатами, бэклог с
// правкой и утверждением, зависимость Epic'ов в планировании, раздел
// отброшенного и просмотр без прав владельца.
//
// Fake-llm строит ответ Аналитика из самого задания: находка на каждую из
// первых трёх реплик «**Р:**», цитата из первых 60 символов реплики, два
// Epic'а, второй зависит от первого. Метки в названии интервью:
// [e2e-slow] задерживает ответы на 3 секунды, чтобы был виден ход анализа,
// [e2e-bad-quote] искажает цитату первой потребности интервью.

const SLOW = '[e2e-slow]'
const BAD_QUOTE = '[e2e-bad-quote]'

async function projectId(page: Page, name: string): Promise<string> {
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const id = projects.find((p) => p.Name === name)?.ID
  expect(id).toBeTruthy()
  return id!
}

async function openDiscovery(page: Page) {
  await page.locator('#sidebar').getByRole('button', { name: 'Исследование', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Исследование', exact: true })).toBeVisible()
}

function section(page: Page, heading: RegExp) {
  return page.locator('.dw-sec', { has: page.getByRole('heading', { name: heading }) })
}

// Запуск анализа и ожидание готовой версии.
async function analyse(page: Page) {
  await page.getByRole('button', { name: 'Запустить анализ' }).click()
  await expect(page.locator('.disc-status .st').first()).toHaveText('готова', { timeout: 60_000 })
}

// Реплики респондента короче 60 символов: цитата fake-llm равна реплике целиком.
const MANAGER = [
  'Сделки веду в таблице, статусы теряются.',
  'Не видно, на каком этапе сделка.',
  'Напоминания о звонках ставлю в телефоне.',
]
const HEAD = [
  'Мне нужна сводка по воронке на каждое утро.',
  'Собираю отчёт руками из таблиц менеджеров.',
  'Хочу видеть сделки, которые зависли.',
]

function interview(stamp: number, replies: string[], heading = ''): string {
  const lines = heading ? [`# ${heading}`, ''] : []
  lines.push(`**И:** Расскажите о своей работе. Интервью ${stamp}.`)
  replies.forEach((r, i) => {
    if (i > 0) lines.push('**И:** А что ещё?')
    lines.push(`**Р:** ${r}`)
  })
  return lines.join('\n') + '\n'
}

test('владелец загружает интервью, видит ход анализа, персоны и потребности, цитата ведёт в интервью', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  await withFakeModel(page, stamp, async () => {
    await createProject(page, `Discovery ${stamp}`)
    await openDiscovery(page)
    await expect(page.getByText('Интервью пока нет.')).toBeVisible()

    // Файлом: без названия в форме берётся первый заголовок «# …».
    await page.getByRole('button', { name: 'Добавить интервью' }).click()
    const modal = page.locator('.modal', { has: page.getByRole('heading', { name: 'Новое интервью' }) })
    await modal.getByLabel('Роль респондента').fill('Менеджер по продажам')
    await modal.getByLabel('Дата интервью').fill('2026-10-20')
    await modal.getByLabel('Файл').setInputFiles({
      name: 'manager.md', mimeType: 'text/markdown',
      buffer: Buffer.from(interview(stamp, MANAGER, 'Менеджер по продажам')),
    })
    await modal.getByRole('button', { name: 'Добавить' }).click()
    await expect(modal).toHaveCount(0)
    // Текстом, с меткой [e2e-slow]: ответы по нему приходят с задержкой.
    const slowTitle = `Руководитель отдела ${SLOW}`
    await addInterviewText(page, slowTitle, 'Руководитель отдела продаж', interview(stamp, HEAD))

    const ivs = section(page, /^Интервью · /)
    await expect(ivs.getByRole('heading')).toHaveText('Интервью · 2')
    const manager = ivs.locator('tr', { hasText: 'Менеджер по продажам' })
    await expect(manager).toContainText('2026-10-20')
    await expect(manager).toContainText('8 стр.')
    await expect(manager).toContainText('e2e-admin')

    // Ход: быстрое интервью законспектировано, медленное ещё нет, затем синтез.
    await page.getByRole('button', { name: 'Запустить анализ' }).click()
    const status = page.locator('.disc-status')
    await expect(status).toContainText('Аналитик Вера конспектирует: 1 из 2')
    await expect(status).toContainText('Аналитик Вера синтезирует результат')
    await expect(status.locator('.st')).toHaveText('готова', { timeout: 30_000 })
    await expect(status).toContainText('Вера')
    await expect(status).toContainText('fake-planner')

    // Персона на интервью, по три потребности с цитатами.
    await expect(section(page, /^Персоны · /).getByRole('heading')).toHaveText('Персоны · 2')
    await expect(page.locator('.persona-card', { hasText: 'Менеджер по продажам' })).toBeVisible()
    await expect(page.locator('.persona-card', { hasText: 'Руководитель отдела продаж' })).toBeVisible()
    await expect(section(page, /^Потребности · /).getByRole('heading')).toHaveText('Потребности · 6')
    for (const q of [...MANAGER, ...HEAD]) {
      await expect(page.locator('.need-card .quote-text', { hasText: q })).toHaveText(`«${q}»`)
    }
    // Раздела отброшенного нет: все цитаты дословные.
    await expect(section(page, /^Отброшено при проверке/)).toHaveCount(0)

    // Цитата ведёт в интервью: строка 6 «# заголовок, пустая, И, Р, И, Р».
    const need = page.locator('.need-card', { has: page.locator('.quote-text', { hasText: MANAGER[1] }) })
    const src = need.locator('.quote-src a')
    await expect(src).toHaveText('интервью «Менеджер по продажам», строка 6')
    await src.click()
    const viewer = page.locator('.iv-modal')
    await expect(viewer.getByRole('heading', { name: 'Менеджер по продажам' })).toBeVisible()
    const hl = viewer.locator('.iv-line.hl')
    await expect(hl).toHaveCount(1)
    await expect(hl.locator('.iv-n')).toHaveText('6')
    await expect(hl.locator('mark')).toHaveText(MANAGER[1])
    await viewer.getByRole('button', { name: 'закрыть' }).click()
    await expect(viewer).toHaveCount(0)

    // История версий: первая версия готова, Аналитик и модель видны.
    const history = section(page, /^История версий$/)
    await expect(history.locator('tbody tr')).toHaveCount(1)
    await expect(history.locator('tbody tr')).toContainText('v1')
    await expect(history.locator('tbody tr')).toContainText('Аналитик Вера')
  })
})

test('бэклог правится и утверждается с декомпозицией, зависимый Epic ждёт первый и стартует после него', async ({ page }) => {
  test.setTimeout(300_000)
  await login(page)
  const stamp = Date.now()
  await withFakeModel(page, stamp, async () => {
    const project = `Backlog ${stamp}`
    await createProject(page, project)
    const pid = await projectId(page, project)
    await openDiscovery(page)
    await addInterviewText(page, 'Менеджер по продажам', 'Менеджер по продажам', interview(stamp, MANAGER))
    await analyse(page)

    // Предложение fake-llm: e1 и e2, второй зависит от первого.
    const backlog = section(page, /^Бэклог · /)
    await expect(backlog.getByRole('heading')).toHaveText('Бэклог · 2')
    // Строка по ключу в первой ячейке: «e1 · новый». Ключи есть и в
    // вариантах зависимостей соседних строк, поэтому ищется только там.
    const row = (key: string) => backlog.locator('tbody tr', {
      has: page.locator('td:first-child > div.mono', { hasText: new RegExp(`^${key} · `) }),
    })
    const base = `Сделки и воронка ${stamp}`
    const dependent = `Сводка руководителя ${stamp}`
    await row('e1').getByLabel('название').fill(base)
    await row('e1').getByLabel('цель').fill('Дать менеджерам видеть этап каждой сделки и не терять статусы между звонками клиентам.')
    await row('e2').getByLabel('название').fill(dependent)
    await row('e2').getByLabel('приоритет').selectOption('must')
    await row('e2').getByLabel('размер').selectOption('M')
    // Epic, добавленный человеком, и его удаление.
    await backlog.getByRole('button', { name: 'Добавить Epic' }).click()
    await expect(backlog.getByRole('heading')).toHaveText('Бэклог · 3')
    await backlog.getByRole('button', { name: 'убрать h1' }).click()
    await expect(backlog.getByRole('heading')).toHaveText('Бэклог · 2')
    await expect(backlog).toContainText('есть несохранённые правки')
    await backlog.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await expect(backlog).not.toContainText('есть несохранённые правки')
    await expect(row('e2').getByLabel('зависимости')).toHaveValues(['e1'])

    // Утверждение со сразу декомпозицией: строки ведут к Epic'ам, Тимлид
    // строит планы по очереди.
    await expect(backlog.getByLabel('сразу декомпозировать')).toBeChecked()
    await backlog.getByRole('button', { name: 'Создать Epic’и' }).click()
    await expect(backlog.getByRole('heading')).toHaveText('Бэклог · 2 · утверждён')
    await expect(page.locator('.disc-status .st').first()).toHaveText('утверждена')
    await expect(row('e1')).toContainText(base)
    await expect(row('e1')).toContainText('план готов', { timeout: 60_000 })
    await expect(row('e2')).toContainText('план готов', { timeout: 60_000 })

    // Зависимый Epic: обоснование с потребностями и цитатами, зависимость
    // на первый, план Тимлида из двух задач.
    await row('e2').getByText('открыть Epic →').click()
    await expect(page.getByRole('heading', { name: dependent })).toBeVisible()
    const dependentURL = page.url()
    const why = page.locator('.epic-why')
    await expect(why).toContainText('приоритет must')
    await expect(why).toContainText('исследование, версия 1')
    await expect(why.locator('.quote-text', { hasText: MANAGER[2] })).toBeVisible()
    await expect(why).toContainText('Менеджер по продажам · интервью «Менеджер по продажам», строка 6')
    await expect(why.locator('.dw-sec', { hasText: 'Зависит от' })).toContainText(base)
    const prep = `Подготовка: ${dependent}`
    await expect(node(page, prep)).toBeVisible()
    await expect(node(page, `Завершение: ${dependent}`)).toBeVisible()

    // Запуск зависимого Epic'а: задачи ждут первый Epic. Что назначений до
    // его завершения не было, ниже проверяет event log.
    await page.getByRole('button', { name: 'Запустить' }).click()
    const wait = page.locator('.deps-wait')
    await expect(wait).toContainText(`Ждёт Epic «${base}»`)
    const dependentID = dependentURL.split('/').pop()!
    await expect.poll(async () => {
      const events: Array<{ Payload: { epic_id?: string } }> | null =
        await (await page.request.get(`/api/v1/events?project=${pid}&type=epic.waiting_deps&limit=100&latest=1`)).json()
      return (events ?? []).some((e) => e.Payload.epic_id === dependentID)
    }, { timeout: 30_000 }).toBe(true)
    await expect(node(page, prep).locator('.st')).toHaveText('READY')

    // Первый Epic доводится до конца кнопками Merge.
    await wait.getByText(`«${base}»`).click()
    await expect(page.getByRole('heading', { name: base })).toBeVisible()
    await page.getByRole('button', { name: 'Запустить' }).click()
    const drawer = page.locator('#drawer')
    for (const t of [`Подготовка: ${base}`, `Завершение: ${base}`]) {
      await expectNodeStatus(page, t, 'REVIEW')
      await node(page, t).click()
      await drawer.getByRole('button', { name: 'Merge' }).click()
      await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
      await drawer.locator('button.close').click()
    }
    await expect(page.locator('.epic-title-row .st')).toHaveText('DONE', { timeout: 30_000 })

    // Зависимость выполнена: ожидание снято, задачи зависимого Epic'а пошли.
    await page.goto(dependentURL)
    await expect(page.getByRole('heading', { name: dependent })).toBeVisible()
    await expectNodeStatus(page, prep, 'REVIEW')
    await expect(page.locator('.deps-wait')).toHaveCount(0)
    // По event log: ожидание объявлено и снято, а задачи зависимого Epic'а
    // ушли в работу только после снятия.
    type Ev = { ID: number; Type: string; TaskID: string; Payload: { status?: string } | null }
    const events: Ev[] = (await (await page.request.get(`/api/v1/events?project=${pid}&epic=${dependentID}&limit=500`)).json()) ?? []
    const first = (type: string) => Math.min(...events.filter((e) => e.Type === type).map((e) => e.ID))
    const running = events.filter((e) => e.Type === 'task.status' && e.TaskID && e.Payload?.status === 'running').map((e) => e.ID)
    expect(running.length).toBeGreaterThan(0)
    expect(first('epic.waiting_deps')).toBeLessThan(first('epic.deps_ready'))
    expect(Math.min(...running)).toBeGreaterThan(first('epic.deps_ready'))
  })
})

test('искажённая цитата уходит в отброшенное, участник member видит исследование без действий', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  await withFakeModel(page, stamp, async () => {
    const project = `Dropped ${stamp}`
    await createProject(page, project)
    const pid = await projectId(page, project)
    await openDiscovery(page)
    const replies = ['Оплаты сверяю вручную по выписке.', 'Акты подписываю с опозданием.', 'Нужна сверка с банком раз в день.']
    await addInterviewText(page, `Бухгалтер ${BAD_QUOTE}`, 'Бухгалтер', interview(stamp, replies))
    // Владелец видит удаление интервью: та же проверка у участника ниже
    // ждёт ноль.
    await expect(page.getByRole('button', { name: /^удалить /i })).toHaveCount(1)
    await analyse(page)

    // Первая потребность пришла с цитатой, которой нет в интервью. Цитата
    // отброшена, потребность без цитат тоже, а Epic e1 потерял ссылку на
    // неё. Остальные две потребности приняты.
    await expect(section(page, /^Потребности · /).getByRole('heading')).toHaveText('Потребности · 2')
    await expect(page.locator('.need-card .quote-text', { hasText: replies[0] })).toHaveCount(0)
    const dropped = section(page, /^Отброшено при проверке · /)
    await expect(dropped.getByRole('heading')).toHaveText('Отброшено при проверке · 3')
    await expect(dropped).toContainText('цитата 1 · потребность 2')
    await dropped.getByRole('button', { name: 'Показать' }).click()
    await expect(dropped.locator('tbody tr')).toHaveCount(3)
    const cells = (i: number) => dropped.locator('tbody tr').nth(i).locator('td')
    await expect(cells(0)).toHaveText(['цитата', `n1: «${replies[0]} (искажено fake-llm)»`, 'цитата не найдена в интервью'])
    await expect(cells(1)).toHaveText(['потребность', `n1: Респондент говорит: ${replies[0]}`, 'нет подтверждённых цитат'])
    await expect(cells(2)).toHaveText(['потребность', 'e1 → n1', 'потребность не найдена или отброшена'])

    // Участник member: тот же проект только для чтения.
    const member = `analyst${stamp}`
    let r = await page.request.post('/api/v1/users', { data: { login: member, name: 'Участник', password: 'member-pass-1', admin: false } })
    expect(r.ok()).toBeTruthy()
    r = await page.request.post(`/api/v1/projects/${pid}/members`, { data: { login: member, role: 'member' } })
    expect(r.ok()).toBeTruthy()

    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    try {
      const mp = await ctx.newPage()
      await mp.goto('/')
      await mp.getByPlaceholder('Логин').fill(member)
      await mp.getByPlaceholder('Пароль').fill('member-pass-1')
      await mp.getByRole('button', { name: 'Войти' }).click()
      // Установка может требовать смены пароля при первом входе.
      const gate = mp.getByPlaceholder('Текущий пароль')
      await expect(mp.getByRole('button', { name: 'Выйти' }).or(gate)).toBeVisible()
      if (await gate.isVisible()) {
        await gate.fill('member-pass-1')
        await mp.getByPlaceholder(/Новый пароль/).fill('member-pass-2')
        await mp.getByRole('button', { name: 'Сменить пароль' }).click()
      }
      await expect(mp.getByRole('button', { name: 'Выйти' })).toBeVisible()

      // Роль в проекте консоль узнаёт отдельным запросом участников. Пока
      // ответа нет, кнопок нет ни у кого, поэтому отрицательные проверки
      // идут после него. Разделы проекта видны только в проекте: участник
      // входит в него из списка «Проекты», и обзор проекта спрашивает
      // участников своим запросом. Его ответ дожидается отдельно, чтобы
      // ожидание ниже поймало именно запрос «Исследования».
      const isMembers = (resp: { url(): string; ok(): boolean }) => resp.url().endsWith(`/api/v1/projects/${pid}/members`) && resp.ok()
      const overviewMembers = mp.waitForResponse(isMembers)
      await openProject(mp, project)
      await overviewMembers
      const members = mp.waitForResponse(isMembers)
      await openDiscovery(mp)
      await members
      await expect(mp.locator('.page-head .sub')).toHaveText(`${project} · только просмотр`)
      // Результаты видны: интервью, потребности, отброшенное, бэклог.
      await expect(section(mp, /^Интервью · /).getByRole('heading')).toHaveText('Интервью · 1')
      await expect(section(mp, /^Потребности · /).getByRole('heading')).toHaveText('Потребности · 2')
      await expect(section(mp, /^Отброшено при проверке · /).getByRole('heading')).toHaveText('Отброшено при проверке · 3')
      const backlog = section(mp, /^Бэклог · /)
      await expect(backlog.getByRole('heading')).toHaveText('Бэклог · 2')
      await expect(backlog).toContainText('Основа по интервью')
      // Действий владельца нет: ни загрузки и запуска, ни удаления, ни правки бэклога.
      for (const name of ['Добавить интервью', 'Запустить анализ', 'Добавить Epic', 'Сохранить', 'Создать Epic’и']) {
        await expect(mp.getByRole('button', { name, exact: true })).toHaveCount(0)
      }
      // У кнопки удаления интервью имя «удалить <название>».
      await expect(mp.getByRole('button', { name: /^удалить /i })).toHaveCount(0)
      await expect(backlog.locator('input, textarea, select')).toHaveCount(0)
      // Цитата открывается и участнику.
      await mp.locator('.need-card .quote-src a').first().click()
      await expect(mp.locator('.iv-modal .iv-line.hl mark')).toHaveText(replies[1])
      // Запуск анализа в обход консоли отклоняется ошибкой доступа.
      const denied = await mp.request.post(`/api/v1/projects/${pid}/discovery/analyses`)
      expect(denied.status()).toBe(403)
    } finally {
      await ctx.close()
    }
  })
})
