import { expect, test } from '@playwright/test'
import { createAssessedEpic, createProject, login, node } from './helpers'
import { LLM_URL } from './stand'

// Подключения к моделям (add-model-connections): подключение к fake-провайдеру
// стенда, обнаружение моделей, ручная модель с ценой, выбор модели
// декомпозиции, декомпозиция Epic этой моделью, отключение убирает модели
// из выбора, неверный ключ подсвечивается. Служебное подключение стенда
// e2e-llm (модели агента Rivet) сценарий не трогает. Подключения сценариев
// удаляются в finally: те же fake-small и fake-large во втором подключении
// сделали бы модель участника в других сценариях неоднозначной.

// Пресеты провайдеров (add-native-agent): готовые карточки продукта.
// Fake-провайдера среди них нет, он только тестовая инфраструктура.
const PRESETS = ['deepseek', 'openai', 'anthropic', 'openrouter', 'ollama', 'lmstudio']

test('пресеты провайдеров показаны карточками, fake-провайдера среди них нет', async ({ page }) => {
  await login(page)
  await page.goto('/#/app-management/connections')
  await expect(page.getByRole('heading', { name: 'Подключения' })).toBeVisible()

  const cards = page.locator('.preset-card')
  await expect(cards).toHaveCount(PRESETS.length)
  for (const id of PRESETS) await expect(page.locator(`.preset-card[data-preset="${id}"]`)).toBeVisible()
  await expect(cards.filter({ hasText: /fake|e2e/i })).toHaveCount(0)

  // Служебное подключение стенда на месте и в порядке: на нём работают runner'ы.
  const stand = page.locator('.conn-card[data-connection="e2e-llm"]')
  await expect(stand).toContainText('в порядке')
  await expect(stand).toContainText('fake-small')

  // Пресет открывает окно подключения с готовыми полями: идентификатор и
  // адрес из пресета, остаётся ключ.
  await page.locator('.preset-card[data-preset="openrouter"]').click()
  const dlg = page.getByRole('dialog')
  await expect(dlg.locator('[data-preset-hint]')).toContainText('OpenRouter')
  await expect(dlg.getByLabel('Идентификатор')).toHaveValue('openrouter')
  await expect(dlg.getByLabel('Base URL')).toHaveValue('https://openrouter.ai/api/v1')
  await dlg.getByRole('button', { name: 'Отмена' }).click()
  await expect(dlg).toHaveCount(0)
})

// Сохранение подключения из пресета (add-native-agent, задача 3.4). Внешней
// сети на стенде нет, поэтому адрес пресета Ollama в форме меняется на
// fake-llm стенда (у пресета без своих моделей адрес можно менять, пресет
// всё равно уходит серверу), а ключ — fake-key: fake-llm принимает только
// его. PUT с пресетом сам запрашивает список моделей у провайдера, без
// кнопки «Обновить список» и без второго запроса discover из консоли, и
// модели подключения становятся моделями агента Rivet.
test('подключение из пресета сохраняется, модели приходят сразу и доступны агенту Rivet', async ({ page }) => {
  await login(page)
  await page.goto('/#/app-management/connections')
  await page.locator('.preset-card[data-preset="ollama"]').click()
  const dlg = page.getByRole('dialog')
  await expect(dlg.locator('[data-preset-hint]')).toContainText('Ollama')
  await expect(dlg.getByLabel('Base URL')).toHaveValue('http://localhost:11434/v1')
  await expect(dlg.getByLabel('Вид')).toHaveValue('local')
  // Идентификатор из пресета; если ollama уже занят прошлым прогоном, консоль
  // предлагает ollama-2.
  const id = await dlg.getByLabel('Идентификатор').inputValue()
  expect(id).toMatch(/^ollama(-\d+)?$/)
  await dlg.getByLabel('Base URL').fill(LLM_URL)
  await dlg.getByPlaceholder('API-ключ').fill('fake-key')

  const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/system/connections/${id}`))
  let discovers = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/system/connections/${id}/discover`)) discovers++
  })
  await dlg.getByRole('button', { name: 'Создать и проверить' }).click()
  try {
    expect(JSON.parse((await put).postData() ?? '{}')).toMatchObject({ preset: 'ollama', kind: 'local', api: 'openai', base_url: LLM_URL })
    await expect(dlg).toHaveCount(0)
    // Итог сохранения на вкладке и карточка: в порядке, модели получены
    // ещё в PUT, консоль discover не повторяет.
    await expect(page.locator('[data-connection-saved]')).toContainText(`подключение ${id} в порядке`)
    await expect(page.locator('[data-connection-saved]')).toContainText('моделей получено от провайдера: 3')
    expect(discovers, 'discover после PUT с пресетом').toBe(0)
    const card = page.locator(`.conn-card[data-connection="${id}"]`)
    await expect(card).toContainText('в порядке')
    await expect(card).toContainText('моделей: 3')
    await expect(card).toContainText('fake-planner')
    await card.getByRole('button', { name: 'Модели…' }).click()
    await expect(dlg.locator('.model-row[data-model="fake-small"] .src')).toHaveText('обнаружена')
    await dlg.getByRole('button', { name: 'Отмена' }).click()

    // Модели подключения — модели агента Rivet: видны в карточке агента и
    // в выборе модели по умолчанию.
    await page.goto('/#/app-management/agents')
    const card2 = page.locator('.conn-card[data-agent="rivet"] [data-agent-models]')
    await expect(card2).toContainText(`${id}/fake-large`)
    await expect(page.getByLabel('Модель по умолчанию').locator('option', { hasText: `${id} / fake-small` })).toHaveCount(1)
  } finally {
    const r = await page.request.delete(`/api/v1/system/connections/${id}`)
    expect.soft(r.status(), `удаление подключения ${id}`).toBe(204)
  }
})

// Граница ошибок (P2-1 ревью add-native-agent): ответ API, который вкладка
// не умеет отрисовать (models: null вместо списка), роняет только эту
// вкладку. Сайдбар и другие вкладки раздела работают, после исправленного
// ответа вкладка открывается снова.
test('сломанный ответ API роняет только вкладку, консоль продолжает работать', async ({ page }) => {
  await login(page)
  const broken = '**/api/v1/system/connections'
  await page.route(broken, (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: [{ id: 'broken', name: 'Broken', kind: 'vendor', api: 'openai', base_url: 'http://broken.invalid',
      key_prefix: '', has_key: false, headers: null, models: null, enabled: true, state: 'ok', checked_at: null,
      check_detail: '', updated_at: '', updated_by: 'e2e' }] })
    : route.fallback())
  await page.goto('/#/app-management/connections')
  const fallback = page.locator('[data-error-boundary]')
  await expect(fallback).toContainText('Не удалось отрисовать вкладку «Подключения»')
  await expect(page.locator('#sidebar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()

  // Другая вкладка раздела открывается: граница вкладки сбрасывается.
  await page.locator('.tabs').getByRole('button', { name: 'Пользователи', exact: true }).click()
  await expect(fallback).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Новый пользователь' })).toBeVisible()
  // Другой экран тоже жив.
  await page.locator('#sidebar').getByRole('button', { name: 'Runner’ы' }).click()
  await expect(page.getByRole('heading', { name: 'Runner’ы' })).toBeVisible()

  // Ответ исправлен: «Повторить» на вкладке рисует её заново.
  await page.goto('/#/app-management/connections')
  await expect(fallback).toBeVisible()
  await page.unroute(broken)
  await fallback.getByRole('button', { name: 'Повторить' }).click()
  await expect(page.locator('.conn-card[data-connection="e2e-llm"]')).toBeVisible()
  await expect(fallback).toHaveCount(0)
})

test('подключение к провайдеру, модели и декомпозиция Epic через каталог', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const id = `fake${stamp}`
  await page.goto('/#/app-management/connections')
  await expect(page.getByRole('heading', { name: 'Подключения' })).toBeVisible()
  try {
    // Создание с неверным ключом: сохраняется как «ключ отклонён».
    await page.getByRole('button', { name: 'Новое подключение' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByLabel('Идентификатор').fill(id)
    await dlg.getByLabel('Название', { exact: true }).fill('Fake LLM')
    await dlg.getByLabel('Вид').selectOption('local')
    await dlg.getByLabel('Base URL').fill(LLM_URL)
    await dlg.getByPlaceholder('API-ключ').fill('wrong-key')
    await dlg.getByRole('button', { name: 'Создать и проверить' }).click()
    const card = page.locator(`.conn-card[data-connection="${id}"]`)
    await expect(card).toContainText('ключ отклонён')

    // Правильный ключ: состояние «в порядке», обнаружение находит модели.
    await card.getByRole('button', { name: 'Изменить' }).click()
    await dlg.getByPlaceholder('API-ключ').fill('fake-key')
    await dlg.getByRole('button', { name: 'Сохранить' }).click()
    await expect(card).toContainText('в порядке')
    await card.getByRole('button', { name: 'Обновить список' }).click()
    await expect(card).toContainText('fake-planner')
    await expect(card).toContainText('моделей: 3')

    // Ручная модель с ценой и скрытие обнаруженной.
    await card.getByRole('button', { name: 'Модели…' }).click()
    await dlg.getByRole('button', { name: '+ модель вручную' }).click()
    const manual = dlg.locator('.model-row').last()
    await manual.getByLabel('идентификатор модели').fill('fake-manual')
    await manual.getByLabel('цена входа').fill('1.5')
    await dlg.locator('.model-row[data-model="fake-large"]').getByRole('checkbox').check()
    await dlg.getByRole('button', { name: 'Сохранить' }).click()
    await expect(card).toContainText('fake-manual')
    await expect(card).toContainText('моделей: 3 (+1 скрытых или пропавших)')

    // Модель декомпозиции из каталога.
    const plannerBlock = page.locator('.dw-sec', { hasText: 'Модель для декомпозиции Epic' })
    await plannerBlock.getByLabel('Подключение', { exact: true }).selectOption(id)
    const modelSelect = plannerBlock.getByLabel('Модель', { exact: true })
    await expect(modelSelect.locator('option', { hasText: 'fake-planner' })).toHaveCount(1)
    await expect(modelSelect.locator('option', { hasText: 'fake-large' })).toHaveCount(0)
    await modelSelect.selectOption('fake-planner')
    await plannerBlock.getByRole('button', { name: 'Сохранить' }).click()
    await expect(plannerBlock).toContainText(`из каталога: ${id}/fake-planner`)
    await expect(card).toContainText('декомпозиция')

    // Декомпозиция Epic идёт этой моделью: fake-llm отдаёт план из двух задач.
    const project = `Conn ${stamp}`
    await createProject(page, project)
    const epic = `Epic conn ${stamp}`
    await createAssessedEpic(page, epic)
    await page.getByRole('button', { name: 'Декомпозировать' }).click()
    await expect(node(page, `Подготовка: ${epic}`)).toBeVisible({ timeout: 30_000 })
    await expect(node(page, `Завершение: ${epic}`)).toBeVisible()

    // Отключение подключения: модели уходят из выбора, планировщик помечен недоступным.
    await page.goto('/#/app-management/connections')
    await card.getByRole('button', { name: 'Отключить' }).click()
    await expect(card).toContainText('отключено')
    await expect(plannerBlock).toContainText('недоступна')
    await expect(plannerBlock.getByLabel('Подключение', { exact: true }).locator('option', { hasText: id })).toHaveCount(0)

    // Удалить нельзя, пока планировщик ссылается; после сброса — можно.
    await card.getByRole('button', { name: 'Удалить', exact: true }).click()
    await card.getByRole('button', { name: 'Удалить?' }).click()
    await expect(page.getByText('подключение используется')).toBeVisible()
    await plannerBlock.getByRole('button', { name: 'Сбросить на окружение' }).click()
    await expect(plannerBlock).toContainText('не настроена')
    await card.getByRole('button', { name: 'Удалить?' }).click()
    await expect(card).toHaveCount(0)
  } finally {
    // Сценарий упал на середине: модель декомпозиции и подключение не
    // остаются другим сценариям. Если сценарий дошёл до конца, их уже нет.
    const planner: { source?: string; connection_id?: string } = await (await page.request.get('/api/v1/system/planner')).json()
    if (planner.source === 'catalog' && planner.connection_id === id) {
      const r = await page.request.put('/api/v1/system/planner', { data: {} })
      expect.soft(r.ok(), 'сброс модели декомпозиции').toBeTruthy()
    }
    const r = await page.request.delete(`/api/v1/system/connections/${id}`)
    expect.soft([204, 404], `удаление подключения ${id}`).toContain(r.status())
  }
})
