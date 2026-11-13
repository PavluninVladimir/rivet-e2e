import { expect, test } from '@playwright/test'
import { createAssessedEpic, createEpic, createProject, login } from './helpers'

// The positive fixture must not turn into a global model/gate auto-healer.
// After its scope ends, a raw Epic still exercises the real missing-model gate.
test('positive architecture fixture restores Ada and raw missing-model Epic remains gated', async ({
  page
}) => {
  await login(page)
  const ada = async () =>
    (await (await page.request.get('/api/v1/team')).json()).agents.find((agent: any) => agent.id === 'ada')
  const editable = (agent: any) => ({
    name: agent.name,
    role_id: agent.role_id,
    agent: agent.agent,
    connection_id: agent.connection_id,
    model: agent.model,
    instruction_extra: agent.instruction_extra,
    enabled: agent.enabled,
    position: agent.position
  })
  const before = editable(await ada())
  const planner = await (await page.request.get('/api/v1/system/planner')).json()
  expect(before.connection_id, 'fresh stand has no explicit Ada model').toBe('')
  expect(before.model).toBe('')
  expect(planner.source).not.toBe('catalog')
  const stamp = Date.now()
  await createProject(page, `Architecture fixture ${stamp}`)
  await createAssessedEpic(page, `Assessed ${stamp}`)
  expect(editable(await ada())).toEqual(before)
  expect(await (await page.request.get('/api/v1/system/planner')).json()).toEqual(planner)
  const connections = await (await page.request.get('/api/v1/system/connections')).json()
  expect(connections.filter((connection: { id: string }) => connection.id.startsWith('arch-e2e-'))).toEqual(
    []
  )

  await page.locator('#sidebar').getByRole('button', { name: 'Epic’и', exact: true }).click()
  await createEpic(page, `Raw missing model ${stamp}`)
  await expect(page.getByRole('button', { name: 'Добавить задачу', exact: true })).toBeDisabled()
  const epicId = /\/epic\/([^/?]+)/.exec(page.url())![1]
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/v1/epics/${epicId}/architecture-assessment`)
        expect(response.ok()).toBeTruthy()
        const view = await response.json()
        expect(view.required).toBe(true)
        return { status: view.assessment?.status, error: view.assessment?.error }
      },
      { timeout: 60_000 }
    )
    .toEqual({ status: 'waiting', error: 'оценка ждёт доступной модели Архитектора' })
  await expect(page.getByRole('button', { name: 'Добавить задачу', exact: true })).toBeDisabled()
  expect(editable(await ada())).toEqual(before)
})
