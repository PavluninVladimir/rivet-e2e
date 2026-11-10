import { expect, test } from '@playwright/test'
import { createProject, login, openProjectSettings, projectFromURL } from './helpers'

// Живая политика (fix-web-console-tails, спека web «Живое обновление
// политик», access-policy «Версионирование и аудит решений»): активация
// политики установки приходит в поток проекта. Открытые настройки проекта
// показывают новое унаследованное значение, вторая вкладка политик
// установки показывает новую версию, обе без перезагрузки. Несохранённую
// правку во второй вкладке фоновое перечитывание не затирает, а вкладка
// сообщает о вышедшей версии. Политика
// меняется мимо обоих окон, запросом API, и в конце возвращается: остальные
// сценарии ждут стенд с прежними значениями.
test('смена политики установки видна в открытой консоли без перезагрузки', async ({ page, context }) => {
  await login(page)
  const stamp = Date.now()
  const name = `LivePolicy ${stamp}`
  await createProject(page, name)
  const pid = projectFromURL(page.url())
  const original = (await (await page.request.get('/api/v1/system/policy')).json()).presets
  const effective = (await (await page.request.get(`/api/v1/projects/${pid}/policy`)).json()).effective
  const next = effective.attempt_limit + 4

  // Окно 1: политики проекта, лимит попыток наследуется.
  await openProjectSettings(page, name, 'Политики')
  const projectRow = page.locator('.set-row', { hasText: 'Лимит попыток' })
  await expect(projectRow).toContainText('наследуется')
  await expect(projectRow).toContainText(`действует: ${effective.attempt_limit}`)
  await expect(page.getByText('Подключено')).toBeVisible()

  // Окно 2: вкладка политик установки.
  const admin = await context.newPage()
  try {
    await admin.goto('/#/app-management/policies')
    await expect(admin.getByRole('heading', { name: 'Политики конвейера' })).toBeVisible()
    await expect(admin.getByText('Подключено')).toBeVisible()
    const adminLimit = admin.locator('.set-row', { hasText: 'Лимит попыток' }).getByRole('spinbutton')
    await expect(adminLimit).toHaveValue(String(effective.attempt_limit))

    const r = await page.request.put('/api/v1/system/policy', { data: { ...original, attempt_limit: next } })
    expect(r.ok()).toBeTruthy()
    const saved = await r.json()

    await expect(projectRow).toContainText(`действует: ${next}`)
    await expect(page.getByText(`установка v${saved.version.version}`)).toBeVisible()
    await expect(adminLimit).toHaveValue(String(next))
    const activeVersion = admin.locator('.set-row', { hasText: 'Активная версия' })
    await expect(activeVersion).toContainText(`v${saved.version.version}`)

    // Несохранённая правка во втором окне: следующая версия её не затирает,
    // а настройки проекта по-прежнему обновляются.
    const adminReview = admin.locator('.set-row', { hasText: 'Лимит отказов review' }).getByRole('spinbutton')
    const edited = String(Number(await adminReview.inputValue()) + 3)
    await adminReview.fill(edited)
    const r2 = await page.request.put('/api/v1/system/policy', { data: { ...original, attempt_limit: next + 1 } })
    expect(r2.ok()).toBeTruthy()
    const saved2 = await r2.json()
    await expect(projectRow).toContainText(`действует: ${next + 1}`)
    // Событие дошло до второго окна: заметка о новой версии вместо значений.
    const newer = admin.locator('[data-policy-newer]')
    await expect(newer).toContainText(`Вышла версия v${saved2.version.version}`)
    await expect(newer).toContainText(`основаны на v${saved.version.version}`)
    await expect(adminReview).toHaveValue(edited)
    await expect(adminLimit).toHaveValue(String(next))
    await expect(activeVersion).toContainText(`v${saved.version.version}`)
    await expect(admin.getByRole('button', { name: 'Сохранить версию' })).toBeEnabled()
  } finally {
    const r = await page.request.put('/api/v1/system/policy', { data: original })
    expect.soft(r.ok(), 'политика установки возвращена').toBeTruthy()
    await admin.close()
  }
})
