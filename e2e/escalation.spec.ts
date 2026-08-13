import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Эскалация (2.4): fake-агент блокируется вопросом, карточка attention
// появляется, ответ через деталку возвращает задачу в работу до done.
test('blocked-задача эскалируется и возвращается в работу после ответа', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Эскалация ${stamp}`

  await createProject(page, `Esc ${stamp}`)
  await createEpic(page, `Epic esc ${stamp}`)
  await addTask(page, taskTitle, 'Сценарий эскалации [e2e-block]: без ответа человека не продолжать.')

  await page.getByRole('button', { name: 'Запустить' }).click()

  // Агент выводит BLOCKED, на дашборде появляется карточка attention.
  const attCard = page.locator('.att-card', { hasText: 'BLOCKED' })
  await expect(attCard).toBeVisible({ timeout: 90_000 })
  await attCard.click()

  const drawer = page.locator('#drawer')
  await expect(drawer.getByText('вопрос от e2e-агента').first()).toBeVisible()
  await drawer.getByPlaceholder(/Ответ/).fill('Подтверждаю, работай по описанию.')
  await drawer.getByRole('button', { name: 'Ответить и вернуть в работу' }).click()

  // Эскалация закрыта, задача едет дальше до review.
  await expect(page.locator('.att-card')).toHaveCount(0, { timeout: 30_000 })
  await expectNodeStatus(page, taskTitle, 'REVIEW')

  await node(page, taskTitle).click()
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})
