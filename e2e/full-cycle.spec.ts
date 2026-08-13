import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Полный цикл (2.3): запуск Epic, fake-runner доводит задачу до review,
// merge кнопкой в UI, done и 100% без перезагрузки страницы (SSE).
test('задача проходит конвейер до merge кнопкой', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Полный цикл ${stamp}`

  await createProject(page, `Cycle ${stamp}`)
  await createEpic(page, `Epic cycle ${stamp}`)
  await addTask(page, taskTitle)

  await page.getByRole('button', { name: 'Запустить' }).click()

  // Конвейер едет сам, страница не перезагружается: статусы приходят по SSE.
  await expectNodeStatus(page, taskTitle, 'REVIEW')

  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await drawer.getByRole('button', { name: 'Merge' }).click()

  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
  await expect(page.locator('.epic-meta-row .pct')).toHaveText('100%')
})
