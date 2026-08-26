import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Участники-люди (add-process-humans): на шаге review агент и владелец
// проекта; владелец видит запуск в «Моих шагах», одобряет, задача готова к
// merge. Второй сценарий: возврат с замечаниями переводит задачу в FIXING.

async function projectWithHumanReview(page: import('@playwright/test').Page, stamp: number) {
  await createProject(page, `Humans ${stamp}`)
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const projectId = projects.find((p) => p.Name === `Humans ${stamp}`)?.ID
  expect(projectId).toBeTruthy()
  const resp = await page.request.put(`/api/v1/projects/${projectId}/policy`, {
    data: {
      process: {
        steps: [
          { id: 'code', kind: 'code', participants: [{ agent: {} }] },
          { id: 'test', kind: 'test', participants: [{ agent: {} }] },
          { id: 'review', kind: 'review', participants: [{ agent: {} }, { user: { role: 'owner' } }] },
          { id: 'merge', kind: 'merge' },
        ],
      },
    },
  })
  expect(resp.ok()).toBeTruthy()
  return projectId!
}

test('владелец одобряет шаг review из «Моих шагов»', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Человек-ревьюер ${stamp}`
  await projectWithHumanReview(page, stamp)
  await createEpic(page, `Epic humans ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')

  // Счётчик и карточка в «Моих шагах».
  const navItem = page.getByRole('button', { name: /Мои шаги/ })
  await expect(navItem.locator('.count')).toHaveText('1', { timeout: 30_000 })
  await navItem.click()
  const card = page.locator('.step-card', { hasText: taskTitle })
  await expect(card).toBeVisible()
  await expect(card).toContainText('REVIEW')
  await card.getByRole('button', { name: 'Одобрить' }).click()
  await expect(card).toHaveCount(0)
  await expect(navItem.locator('.count')).toHaveCount(0)

  // Задача ждёт merge, деталка показывает вердикт человека.
  await page.getByRole('button', { name: 'Epic’и' }).click()
  await page.locator('tr', { hasText: `Epic humans ${stamp}` }).click()
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.locator('.step-run', { hasText: 'человек' })).toContainText('ok')
  await expect(drawer.getByText('review пройден').first()).toBeVisible({ timeout: 30_000 })
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})

test('возврат с замечаниями требует текста и переводит задачу в FIXING', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Замечания человека ${stamp}`
  const projectId = await projectWithHumanReview(page, stamp)
  await createEpic(page, `Epic remarks ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')

  await page.getByRole('button', { name: /Мои шаги/ }).click()
  const card = page.locator('.step-card', { hasText: taskTitle })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: 'Вернуть с замечаниями' }).click()
  await expect(card.locator('.err')).toContainText('обязательны')
  await card.locator('textarea').fill('Переименуй функцию')
  await card.getByRole('button', { name: 'Вернуть с замечаниями' }).click()
  await expect(card).toHaveCount(0)

  // Исправление уходит агенту: в событиях переход review → code с
  // замечаниями человека, задача снова доезжает до review.
  await expect.poll(async () => {
    const events: Array<{ Type: string; Payload: Record<string, unknown> }> =
      await (await page.request.get(`/api/v1/events?project=${projectId}&type=task.step&limit=100&latest=1`)).json()
    return events.some((e) => e.Payload.step === 'review' && e.Payload.outcome === 'changes')
  }, { timeout: 30_000 }).toBe(true)
  await page.getByRole('button', { name: 'Epic’и' }).click()
  await page.locator('tr', { hasText: `Epic remarks ${stamp}` }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')
})
