import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Видимость сессий (add-session-visibility): в деталке завершённой стадии
// открывается сохранённый транскрипт, секрет из вывода агента замаскирован.
test('транскрипт завершённой стадии открывается, секрет замаскирован', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Транскрипт ${stamp}`

  await createProject(page, `Sessions ${stamp}`)
  await createEpic(page, `Epic sessions ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Стадия CODING завершена, задача дошла до review.
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()

  const drawer = page.locator('#drawer')
  await expect(drawer.getByRole('heading', { name: 'Сессии', exact: true })).toBeVisible()

  // История сессий: открываем транскрипт стадии CODING.
  const coding = drawer.locator('.sess-row', { hasText: 'CODING' }).first()
  await coding.click()
  const term = drawer.locator('.sess-term')
  await expect(term).toContainText('Реализую задачу')

  // Секрет fake-агента (export GH_TOKEN=ghp_…) заменён маской и не утёк.
  await expect(term).toContainText('***')
  expect(await term.textContent()).not.toContain('ghp_')

  // Повторный клик сворачивает транскрипт.
  await coding.click()
  await expect(term).toHaveCount(0)
})

// Сессия без сохранённого транскрипта показывается с явным состоянием,
// а не как ошибка (сценарий «Сессия без транскрипта в деталке»).
test('сессия без транскрипта показывает «транскрипт недоступен»', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Без транскрипта ${stamp}`

  await createProject(page, `NoTranscript ${stamp}`)
  await createEpic(page, `Epic nt ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()

  const drawer = page.locator('#drawer')
  // TESTING в e2e-проекте без настроенных проверок не пишет транскрипт.
  const testing = drawer.locator('.sess-row', { hasText: 'TESTING' }).first()
  await testing.click()
  await expect(drawer.locator('.sess-term')).toHaveText('транскрипт недоступен')
})
