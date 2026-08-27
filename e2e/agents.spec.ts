import { expect, test, type Page } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node, openProjectSettings } from './helpers'

// Каталог агентов (add-agent-profiles): профиль fake с привязками моделей
// из подключения к fake-провайдеру, runner'ы получают модели профиля,
// участник процесса выбирает агента и модель из каталога, назначение
// приносит агенту модель и окружение (секрет замаскирован в транскрипте),
// переопределение модели в проекте меняет модель назначения.

const LLM_URL = `http://localhost:${process.env.E2E_LLM_PORT ?? '8283'}/v1`

async function projectId(page: Page, name: string): Promise<string> {
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const id = projects.find((p) => p.Name === name)?.ID
  expect(id).toBeTruthy()
  return id!
}

test('профиль агента: модели из подключения, окружение в назначении, переопределение в проекте', async ({ page }) => {
  test.setTimeout(240_000)
  await login(page)
  const stamp = Date.now()

  // Подключение к fake-провайдеру через API (сценарий подключений покрыт отдельно).
  const conn = `llm${stamp}`
  let r = await page.request.put(`/api/v1/system/connections/${conn}`, { data: { name: 'Fake LLM', kind: 'local', api: 'openai', base_url: LLM_URL, key: 'fake-key' } })
  expect(r.ok()).toBeTruthy()
  r = await page.request.post(`/api/v1/system/connections/${conn}/discover`)
  expect(r.ok()).toBeTruthy()

  try {
    // Профиль fake на вкладке «Агенты»: обёртка без своей команды (runner'ы
    // стенда запускают fake-агента флагом -cmd), две привязки, окружение
    // с ключом и адресом, секреты всегда.
    await page.goto('/#/app-management/agents')
    await page.getByRole('button', { name: 'Новый агент' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Идентификатор').fill('fake')
    await dlg.getByLabel('Название', { exact: true }).fill('Fake')
    await dlg.getByLabel('Режим секретов').selectOption('always')
    await dlg.getByLabel('Команда запуска').fill('')
    await dlg.getByLabel('подключение', { exact: true }).selectOption(conn)
    await dlg.getByLabel('модель подключения').selectOption('fake-small')
    await dlg.getByRole('button', { name: '+ привязать' }).click()
    await dlg.getByLabel('модель подключения').selectOption('fake-large')
    await dlg.getByRole('button', { name: '+ привязать' }).click()
    // Шаблон окружения: ключ и адрес подключения; неизвестная подстановка — ошибка у поля.
    const names = dlg.getByLabel('имя переменной')
    const values = dlg.getByLabel('значение переменной')
    await names.nth(0).fill('FAKE_KEY'); await values.nth(0).fill('{{key}}')
    await names.nth(1).fill('FAKE_BASE_URL'); await values.nth(1).fill('{{oops}}')
    await dlg.getByRole('button', { name: 'Создать' }).click()
    await expect(dlg.getByRole('alert')).toContainText('неизвестная подстановка')
    await values.nth(1).fill('{{base_url}}')
    await dlg.getByRole('button', { name: 'Создать' }).click()
    const card = page.locator('.conn-card[data-agent="fake"]')
    await expect(card).toContainText(`${conn}/fake-small · по умолчанию`)
    await expect(card).toContainText(`${conn}/fake-large`)

    // Runner'ы с агентом fake теперь в каталоге с моделями профиля.
    await page.goto('/#/runners')
    const reviewer = page.locator('tr', { hasText: 'e2e-reviewer2' })
    await expect(reviewer).toContainText('Fake')
    await expect(reviewer).toContainText('fake-small, fake-large')
    await expect(reviewer).not.toContainText('вне каталога')

    // Процесс проекта: участник review — агент fake из каталога, модель вне
    // привязок отклоняется у поля, «по умолчанию» проходит.
    const project = `Agents ${stamp}`
    await createProject(page, project)
    const pid = await projectId(page, project)
    r = await page.request.put(`/api/v1/projects/${pid}/policy`, { data: { process: { steps: [
      { id: 'code', kind: 'code', participants: [{ agent: {} }] },
      { id: 'review', kind: 'review', participants: [{ agent: { kind: 'fake', model: 'fake-nope' } }] },
      { id: 'merge', kind: 'merge' },
    ] } } })
    expect(r.status()).toBe(422)
    expect(await r.json()).toMatchObject({ step: 'review', field: 'participants[0].agent.model' })

    await openProjectSettings(page, project, 'Процесс')
    await page.locator('.pg-node[data-step="review"]').click()
    await dlg.getByLabel('агент').selectOption('fake')
    await expect(dlg.getByLabel('модель')).toContainText('по умолчанию (fake-small)')
    await dlg.getByRole('button', { name: 'Готово' }).click()
    await page.getByRole('button', { name: 'Сохранить процесс' }).click()
    await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')

    // Задача: review идёт на модели по умолчанию, агент получил окружение,
    // ключ в транскрипте замаскирован.
    await page.goto('/#/epics')
    await createEpic(page, `Epic agents ${stamp}`)
    const taskTitle = `Профиль агента ${stamp}`
    await addTask(page, taskTitle)
    await page.getByRole('button', { name: 'Запустить' }).click()
    await expectNodeStatus(page, taskTitle, 'REVIEW')
    // Исход шага review в event log: вердикт участника с моделью назначения.
    await expect.poll(async () => {
      const events: Array<{ Payload: { step?: string; outcome?: string; verdicts?: Array<{ model: string }> } }> =
        await (await page.request.get(`/api/v1/events?project=${pid}&type=task.step&limit=100&latest=1`)).json()
      const ev = events.find((e) => e.Payload.step === 'review' && e.Payload.outcome === 'ok')
      return ev?.Payload.verdicts?.[0]?.model ?? ''
    }, { timeout: 60_000 }).toBe('fake-small')
    // Транскрипт review: агент видел модель и адрес, ключ замаскирован.
    await node(page, taskTitle).click()
    const drawer = page.locator('#drawer')
    await drawer.locator('.sess-row', { hasText: 'REVIEW' }).first().click()
    const term = drawer.locator('.sess-term')
    await expect(term).toContainText('AGENT_MODEL=fake-small')
    await expect(term).toContainText(`FAKE_BASE_URL=${LLM_URL}`)
    await expect(term).toContainText('FAKE_KEY=***')
    expect(await term.textContent()).not.toContain('fake-key')

    // Переопределение модели агента в проекте на вкладке «Политики».
    await openProjectSettings(page, project, 'Политики')
    const row = page.locator('.set-row[data-agent-model="fake"]')
    await expect(row).toContainText('наследуется')
    await row.getByLabel(/переопределить/).check()
    await row.getByLabel('модель агента fake').selectOption(`${conn}/fake-large`)
    await page.getByRole('button', { name: 'Сохранить версию' }).click()
    await expect(row).toContainText('переопределено')
    await expect(row).toContainText(`${conn}/fake-large`)
  } finally {
    // Профиль отключается: runner'ы стенда возвращаются к объявленным моделям
    // для остальных сценариев.
    const a = await (await page.request.get('/api/v1/system/agents')).json().catch(() => null)
    const fake = a?.agents?.find((x: { id: string }) => x.id === 'fake')
    if (fake) await page.request.put('/api/v1/system/agents/fake', { data: { ...fake, enabled: false } })
  }
})

