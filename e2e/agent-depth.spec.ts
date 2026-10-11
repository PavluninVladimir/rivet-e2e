import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Нативный адаптер Claude Code (add-claude-code-adapter): worker стенда
// работает через fake-claude с полной глубиной, ревьюер — через обёртку с
// минимальной. Деталка различает «нет данных» и «недоступно для подключения».
test('полная глубина: шаги с инструментом и файлами, у обёртки — «недоступно»', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Глубина ${stamp}`

  await createProject(page, `Depth ${stamp}`)
  await createEpic(page, `Epic depth ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')

  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')

  // Timeline: шаг PostToolUse с чипом инструмента и относительным путём файла.
  const editStep = drawer.locator('.tl-row', { hasText: 'e2e-result.txt' }).filter({ hasText: 'Edit' })
  await expect(editStep.first()).toBeVisible()
  await expect(editStep.first().locator('.chip')).toHaveText('Edit')

  // Сессия coding (fake-claude): глубина full, файлы сессии накоплены.
  const codingRow = drawer.locator('.sess-row', { hasText: 'CODING' }).first()
  await expect(codingRow.locator('.chip')).toHaveText('full')
  await codingRow.click()
  await expect(drawer.locator('.sess-files')).toContainText('e2e-result.txt')
  // Usage нативного адаптера — без маркера USAGE: (токены из result).
  await expect(codingRow.locator('.mono').last()).not.toHaveText('—')

  // Review выполняет обёртка: файлы недоступны для этого подключения.
  await drawer.locator('.sess-row', { hasText: 'REVIEW' }).click()
  await expect(drawer.locator('.sess-files')).toContainText('недоступно для этого подключения')
})
