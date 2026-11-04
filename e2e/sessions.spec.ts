import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node, openProjectSettings } from './helpers'

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
  const projectName = `NoTranscript ${stamp}`
  const taskTitle = `Без транскрипта ${stamp}`

  await createProject(page, projectName)
  // С тестировщиком (add-agent-roles) у TESTING есть его сессия с
  // транскриптом. Участник шага test без роли выполняет только проверки
  // проекта, как до появления ролей. Процесс проекта, а не флаг
  // tester_agent: флаг действует только на процесс по умолчанию, а
  // предыдущие сценарии могли сохранить процесс установки явно.
  await openProjectSettings(page, projectName, 'Процесс')
  await page.locator('.pg-node[data-step="test"]').click()
  const dlg = page.getByRole('dialog')
  await dlg.locator('[data-participant]').first().getByLabel('роль', { exact: true }).selectOption({ label: 'без роли' })
  await dlg.getByRole('button', { name: 'Готово' }).click()
  await page.getByRole('button', { name: 'Сохранить процесс' }).click()
  await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')

  await page.goto('/#/epics')
  await createEpic(page, `Epic nt ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()

  const drawer = page.locator('#drawer')
  // TESTING без роли и без настроенных проверок не пишет транскрипт.
  const testing = drawer.locator('.sess-row', { hasText: 'TESTING' }).first()
  await testing.click()
  await expect(drawer.locator('.sess-term')).toHaveText('транскрипт недоступен')
})
