import { expect, test } from '@playwright/test'
import { addTask, createAssessedEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Глубина данных агента Rivet (add-native-agent): все runner'ы стенда ведут
// агентский цикл Rivet поверх fake-llm, у всех глубина full. Timeline
// показывает шаги инструментов с файлами, сессии coding и review — глубину
// full: у разработчика накоплены затронутые файлы, у ревьюера (он только
// читает) их нет, но это «нет», а не «недоступно для подключения».
test('полная глубина: шаги инструментов с файлами у разработчика и ревьюера', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Глубина ${stamp}`

  await createProject(page, `Depth ${stamp}`)
  await createAssessedEpic(page, `Epic depth ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')

  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  // Review завершён: обе сессии в истории (она перечитывается на SSE).
  await expect(drawer.locator('.tl')).toContainText('review пройден', { timeout: 60_000 })

  // Timeline: шаг write_file с чипом инструмента и относительным путём файла.
  // Перед чипом инструмента стоит плашка роли исполнителя (add-agent-roles).
  const writeStep = drawer.locator('.tl-row', { hasText: 'e2e-result.txt' }).filter({ hasText: 'write_file' })
  await expect(writeStep.first()).toBeVisible()
  await expect(writeStep.first().locator('.chip:not(.role-chip)')).toHaveText('write_file')
  await expect(writeStep.first().locator('.role-chip')).toContainText('Разработчик')
  // Команда агента в рабочей копии — шаг run с командой.
  const runStep = drawer.locator('.tl-row', { hasText: 'test -s e2e-result.txt' })
  await expect(runStep.first().locator('.chip:not(.role-chip)')).toHaveText('run')

  // Сессия coding: глубина full, агент rivet, файлы сессии накоплены.
  const codingRow = drawer.locator('.sess-row', { hasText: 'CODING' }).first()
  await expect(codingRow.locator('.chip')).toHaveText('full')
  await expect(codingRow.locator('.sess-agent')).toContainText('rivet')
  await codingRow.click()
  await expect(drawer.locator('.sess-files')).toContainText('e2e-result.txt')
  // Usage — из ответов провайдера модели, без маркеров в выводе.
  await expect(codingRow.locator('.mono').last()).not.toHaveText('—')

  // Review тоже ведёт агент Rivet: глубина full, файлов ревьюер не менял.
  const reviewRow = drawer.locator('.sess-row', { hasText: 'REVIEW' }).first()
  await expect(reviewRow.locator('.chip')).toHaveText('full')
  await reviewRow.click()
  await expect(drawer.locator('.sess-files')).toHaveText('файлы: нет')
})
