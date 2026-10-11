import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Бюджет Epic (add-cost-transparency): маленький бюджет исчерпывается первой
// же coding-стадией (fake-claude отчитывается ~100k токенов) — review не
// назначается, дашборд показывает плашку; поднятие бюджета возобновляет.
test('бюджет Epic останавливает назначения и снимается поднятием', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Бюджет ${stamp}`

  await createProject(page, `EpicBudget ${stamp}`)
  await createEpic(page, `Epic budget ${stamp}`)
  await addTask(page, taskTitle)

  // Бюджет 1000 токенов до запуска.
  await page.locator('.epic-meta-row').getByRole('button', { name: 'изменить бюджет' }).click()
  await page.locator('.epic-meta-row input[type="number"]').fill('1000')
  await page.locator('.epic-meta-row').getByRole('button', { name: 'OK' }).click()
  // Дождаться выхода из режима редактирования (PATCH прошёл).
  await expect(page.locator('.epic-meta-row input[type="number"]')).toHaveCount(0)
  await expect(page.locator('.epic-meta-row')).toContainText('бюджет:')

  await page.getByRole('button', { name: 'Запустить' }).click()
  // Coding проходит (бюджет проверяется до появления usage), задача доезжает
  // до статуса review, но ревьюер не назначается — бюджет исчерпан.
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await expect(page.locator('.budget-pause', { hasText: 'Бюджет Epic исчерпан' }))
    .toBeVisible({ timeout: 20_000 })

  // Человек поднимает бюджет — review выполняется, плашка исчезает.
  await page.locator('.epic-meta-row').getByRole('button', { name: 'изменить бюджет' }).click()
  await page.locator('.epic-meta-row input[type="number"]').fill('100000000')
  await page.locator('.epic-meta-row').getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.epic-meta-row input[type="number"]')).toHaveCount(0)
  await expect(page.locator('.budget-pause', { hasText: 'Бюджет Epic исчерпан' })).toHaveCount(0)

  // Review пройден: в деталке появляется кнопка Merge (review завершён).
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.locator('.tl')).toContainText('review пройден', { timeout: 60_000 })
})
