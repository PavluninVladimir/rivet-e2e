import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Процесс проекта (add-process-model): владелец задаёт через API шаг review с
// двумя агентами-ревьюерами разных моделей, задача проходит конвейер по
// этому процессу, в событиях один переход с двумя вердиктами, merge кнопкой.
test('процесс с двумя ревьюерами доводит задачу до merge', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Два ревьюера ${stamp}`

  await createProject(page, `Process ${stamp}`)
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const projectId = projects.find((p) => p.Name === `Process ${stamp}`)?.ID
  expect(projectId).toBeTruthy()

  const resp = await page.request.put(`/api/v1/projects/${projectId}/policy`, {
    data: {
      process: {
        steps: [
          { id: 'code', kind: 'code', participants: [{ agent: {} }] },
          { id: 'test', kind: 'test', participants: [{ agent: {} }] },
          {
            id: 'review', kind: 'review', mode: 'parallel', require: 'all',
            participants: [
              { agent: { kind: 'fake', model: 'fake-small' } },
              { agent: { kind: 'fake', model: 'fake-large' } },
            ],
          },
          { id: 'merge', kind: 'merge' },
        ],
      },
    },
  })
  expect(resp.ok()).toBeTruthy()
  expect(await resp.json()).toMatchObject({ process_source: 'project' })

  await createEpic(page, `Epic process ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Оба ревьюера одобряют, задача ждёт подтверждения merge.
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await expect.poll(async () => {
    const events: Array<{ Type: string; Payload: Record<string, unknown> }> =
      await (await page.request.get(`/api/v1/events?project=${projectId}&type=task.step&limit=100&latest=1`)).json()
    const passed = events.find((e) => e.Payload.step === 'review' && e.Payload.outcome === 'ok')
    return passed ? (passed.Payload.verdicts as unknown[]).length : 0
  }, { timeout: 90_000 }).toBe(2)
  const sessions = await (await page.request.get(`/api/v1/events?project=${projectId}&type=task.step&limit=100&latest=1`)).json()
  const review = sessions.find((e: { Payload: Record<string, unknown> }) => e.Payload.step === 'review' && e.Payload.outcome === 'ok')
  const models = (review.Payload.verdicts as Array<{ model: string; verdict: string }>).map((v) => v.model).sort()
  expect(models).toEqual(['fake-large', 'fake-small'])

  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})
