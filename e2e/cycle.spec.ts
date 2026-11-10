import { expect, test, type Page } from '@playwright/test'
import { addInterviewText, createProject, login, openProject, openSection, withFakeModel } from './helpers'

// Цикл разработки (add-sdlc-cycle, fix-cycle-phase-data, add-user-feedback):
// фазы «Исследование» и «Архитектура» показывают данные проекта, а не «нет
// данных». Проект подключён к репозиторию стенда e2e/arch: на его основной
// ветке лежит описание архитектуры демо-CRM, снимок строится при
// подключении. Исследование наполняется интервью и анализом Аналитика на
// fake-llm. Отзыв пользователя возвращается в исследование: участник
// добавляет его на экране цикла, следующий анализ его учитывает.

function phaseNode(page: Page, id: string) {
  return page.locator(`.cycle-ring [data-phase-node="${id}"]`)
}

function phasePanel(page: Page, title: string) {
  return page.getByRole('complementary', { name: `Фаза ${title}` })
}

async function openCycle(page: Page) {
  await openSection(page, 'Цикл разработки')
  await expect(page.getByRole('heading', { name: 'Цикл разработки', exact: true })).toBeVisible()
}

test('фазы «Исследование» и «Архитектура» показывают интервью, анализ, снимок и решения ADR', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  await createProject(page, `Cycle ${stamp}`, 'e2e/arch')
  await openCycle(page)

  // Интервью ещё нет: исследование без данных с подсказкой.
  const discovery = phaseNode(page, 'discovery')
  await expect(discovery).toHaveAttribute('aria-label', /нет данных/)

  // Снимок архитектуры строится при подключении проекта, экран цикла
  // перечитывает агрегат по событию снимка без перезагрузки.
  const architecture = phaseNode(page, 'architecture')
  await expect(architecture).not.toHaveAttribute('aria-label', /нет данных/, { timeout: 30_000 })
  await expect(architecture).not.toContainText('нет данных')
  await architecture.click()
  const archPanel = phasePanel(page, 'Архитектура')
  await expect(archPanel.getByRole('button', { name: /Снимок архитектуры · CRM/ })).toBeVisible()
  await expect(archPanel.getByRole('button', { name: /ADR-0002 · Node\.js без внешних зависимостей/ })).toBeVisible()
  await expect(archPanel.getByRole('link', { name: 'Архитектура →' })).toBeVisible()
  // Решение ведёт на вкладку решений «Архитектуры» с выбранным номером и
  // реестром всех статусов: заменённое решение тоже видно слева.
  await archPanel.getByRole('button', { name: /ADR-0001 · Хранилище в JSON-файле/ }).click()
  await expect(page).toHaveURL(/\/architecture\/decisions\/1\?status=all$/)
  await expect(page.locator('article.arch-decision[data-adr="1"]')).toBeVisible()

  // Интервью: фаза исследования получает материал, который ждёт анализа.
  const title = `Менеджер ${stamp}`
  await openSection(page, 'Исследование')
  await addInterviewText(page, title, 'Менеджер по продажам', [
    `**И:** Расскажите о своей работе. Интервью ${stamp}.`,
    '**Р:** Сделки веду в таблице, статусы теряются.',
    '**И:** А что ещё?',
    '**Р:** Не видно, на каком этапе сделка.',
  ].join('\n') + '\n')
  await openCycle(page)
  await expect(discovery).toHaveAttribute('aria-label', /в работе 0, ждут 1, нужен человек 0/)
  await discovery.click()
  const discPanel = phasePanel(page, 'Исследование')
  await expect(discPanel.getByRole('button', { name: new RegExp(`ждёт.*Интервью · ${title}`) })).toBeVisible()
  await expect(discPanel.locator('.dw-sec', { has: page.getByRole('heading', { name: 'Материалы' }) })
    .getByRole('button', { name: new RegExp(`интервью\\s*${title}`) })).toBeVisible()

  // Анализ Аналитика: интервью учтено, бэклог ждёт утверждения владельцем,
  // потребности — артефакты фазы.
  await withFakeModel(page, stamp, async () => {
    await openSection(page, 'Исследование')
    await page.getByRole('button', { name: 'Запустить анализ' }).click()
    await expect(page.locator('.disc-status .st').first()).toHaveText('готова', { timeout: 60_000 })
  })
  await openCycle(page)
  await expect(discovery).toHaveAttribute('aria-label', /в работе 0, ждут 0, нужен человек 1/)
  await discovery.click()
  await expect(discPanel.getByRole('button', { name: /нужен человек.*Бэклог исследования · версия 1 ждёт утверждения/ })).toBeVisible()
  await expect(discPanel.locator('.cp-items .chip', { hasText: 'потребность' }).first()).toBeVisible()
  await expect(discPanel.locator('.cyc-card', { hasText: 'Вера' })).toBeVisible()
})

test('участник добавляет отзыв на экране цикла, счётчик растёт без перезагрузки, анализ учитывает отзыв', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  const project = `Feedback ${stamp}`
  await createProject(page, project)
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const pid = projects.find((p) => p.Name === project)?.ID
  expect(pid).toBeTruthy()

  // Владелец держит экран цикла открытым: отзыв участника приходит к нему
  // событием потока.
  await openCycle(page)
  const discovery = phaseNode(page, 'discovery')
  await expect(discovery).toHaveAttribute('aria-label', /нет данных/)

  // Участник member без прав владельца.
  const member = `fb${stamp}`
  let r = await page.request.post('/api/v1/users', { data: { login: member, name: 'Участник', password: 'member-pass-1', admin: false } })
  expect(r.ok()).toBeTruthy()
  r = await page.request.post(`/api/v1/projects/${pid}/members`, { data: { login: member, role: 'member' } })
  expect(r.ok()).toBeTruthy()
  const source = `менеджер Анна ${stamp}`
  const text = 'После импорта Excel пропали телефоны у половины контактов.'
  const second = 'Нет выгрузки сделок в Excel для отчёта.'
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL })
  try {
    const mp = await ctx.newPage()
    await mp.goto('/')
    await mp.getByPlaceholder('Логин').fill(member)
    await mp.getByPlaceholder('Пароль').fill('member-pass-1')
    await mp.getByRole('button', { name: 'Войти' }).click()
    const gate = mp.getByPlaceholder('Текущий пароль')
    await expect(mp.getByRole('button', { name: 'Выйти' }).or(gate)).toBeVisible()
    if (await gate.isVisible()) {
      await gate.fill('member-pass-1')
      await mp.getByPlaceholder(/Новый пароль/).fill('member-pass-2')
      await mp.getByRole('button', { name: 'Сменить пароль' }).click()
    }
    await expect(mp.getByRole('button', { name: 'Выйти' })).toBeVisible()
    await openProject(mp, project)
    await openCycle(mp)
    await phaseNode(mp, 'discovery').click()
    const panel = phasePanel(mp, 'Исследование')
    // Пустой отзыв: ошибка у поля, отзыв не сохраняется.
    await panel.getByLabel('Источник').fill(source)
    await panel.getByRole('button', { name: 'Добавить отзыв' }).click()
    await expect(panel.locator('.f-field', { hasText: 'Отзыв' }).first().locator('.f-error')).toBeVisible()
    await panel.getByLabel('Отзыв', { exact: true }).fill(text)
    await panel.getByRole('button', { name: 'Добавить отзыв' }).click()
    await expect(panel.getByText('Отзыв сохранён')).toBeVisible()
    await expect(phaseNode(mp, 'discovery')).toHaveAttribute('aria-label', /ждут 1, нужен человек 0, 1 отзыв не учтён/)
    await expect(panel.locator('.cp-feedback')).toHaveText('1 отзыв не учтён')
    await expect(panel.getByRole('button', { name: new RegExp(`ждёт.*Отзыв · ${source}`) })).toBeVisible()

    // Второй отзыв участник добавляет в «Исследовании»: отзыв в списке,
    // неучтённых два, удалять отзывы участник не может.
    await openSection(mp, 'Исследование')
    const mfb = mp.locator('.dw-sec', { has: mp.getByRole('heading', { name: /^Отзывы пользователей · / }) })
    await expect(mfb.getByRole('heading')).toHaveText('Отзывы пользователей · 1')
    await mfb.getByLabel('Отзыв', { exact: true }).fill(second)
    await mfb.getByLabel('Источник').fill('РОП Олег')
    await mfb.getByRole('button', { name: 'Добавить отзыв' }).click()
    await expect(mfb.getByRole('heading')).toHaveText('Отзывы пользователей · 2')
    await expect(mfb).toContainText('2 отзыва не учтены')
    await expect(mfb.locator('tbody tr').first()).toContainText('РОП Олег')
    await expect(mfb.locator('tbody tr').first()).toContainText(second)
    await expect(mfb.getByRole('button', { name: /^удалить отзыв/i })).toHaveCount(0)
  } finally {
    await ctx.close()
  }

  // У владельца счётчик вырос без перезагрузки.
  await expect(discovery).toHaveAttribute('aria-label', /2 отзыва не учтены/)
  await expect(discovery.locator('.cn-feedback')).toHaveText('2 отзыва не учтены')

  // «Исследование»: отзывы в списке, анализ по отзывам без интервью.
  await withFakeModel(page, stamp, async () => {
    await openSection(page, 'Исследование')
    const fb = page.locator('.dw-sec', { has: page.getByRole('heading', { name: /^Отзывы пользователей · / }) })
    await expect(fb.getByRole('heading')).toHaveText('Отзывы пользователей · 2')
    await expect(fb).toContainText('2 отзыва не учтены')
    await expect(fb.locator('tbody tr')).toHaveCount(2)
    await expect(fb.locator('tbody tr').nth(1)).toContainText(source)
    await expect(fb.getByRole('button', { name: /^удалить отзыв/i })).toHaveCount(2)
    await page.getByRole('button', { name: 'Запустить анализ' }).click()
    await expect(page.locator('.disc-status .st').first()).toHaveText('готова', { timeout: 60_000 })
    await expect(fb).toContainText('Все отзывы учтены последней версией исследования.')
    // Потребность с цитатой из отзыва прошла проверку цитат и ведёт в отзыв.
    const src = page.locator('.need-card .quote-src', { hasText: `отзыв «${source}», строка 1` }).first()
    await expect(src).toBeVisible()
    await src.getByRole('button').click()
    await expect(page.locator('.iv-modal .iv-line.hl mark')).toHaveText(text)
    await page.locator('.iv-modal').getByRole('button', { name: 'закрыть' }).click()
    await expect(page.locator('.iv-modal')).toHaveCount(0)
  })
  await openCycle(page)
  await expect(discovery).toHaveAttribute('aria-label', /в работе 0, ждут 0, нужен человек 1$/)
  await expect(discovery.locator('.cn-feedback')).toHaveCount(0)
})
