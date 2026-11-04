import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Конфликт при merge (change add-merge-conflict-recovery): fake-хостинг
// отклоняет первый merge PR задачи с меткой [e2e-conflict]. Подтверждение
// человека отвечает понятной ошибкой, задача сама уходит агенту на
// разрешение конфликта, проходит проверки и review заново и мержится.
test('конфликт при merge возвращает задачу агенту и она доходит до done', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Конфликт [e2e-conflict] ${stamp}`

  await createProject(page, `Conflict ${stamp}`)
  await createEpic(page, `Epic conflict ${stamp}`)
  await addTask(page, taskTitle, 'Сценарий конфликта при merge: правка общего файла.')
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Review пройден, задача ждёт подтверждения merge человеком.
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  const waitingMerge = drawer.getByText('review пройден — ожидание подтверждения merge')
  await expect(waitingMerge).toHaveCount(1, { timeout: 90_000 })

  // Merge: хостинг отвечает конфликтом, задача возвращается агенту.
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.getByText('задача возвращена агенту на разрешение конфликта')).toBeVisible()
  await expect(drawer.getByText(/PR конфликтует с main — возврат на разрешение конфликта \(1\/\d+\)/)).toBeVisible()

  // Исправление, проверки и review заново, затем снова ожидание merge.
  await expect(waitingMerge).toHaveCount(2, { timeout: 90_000 })
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})
