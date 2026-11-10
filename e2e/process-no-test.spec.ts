import { expect, test, type Page } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Процесс без шага проверок (fix-pr-without-test-step): шаг test отключён,
// а PR всё равно создаётся перед первым шагом, которому он нужен. Ревьюер
// получает diff, merge мержит настоящий PR, и только после этого задача
// done. Без review PR создаётся при входе в merge.

type Ev = { Type: string; Text: string; TaskID: string; Payload: Record<string, unknown> }

async function projectId(page: Page, name: string): Promise<string> {
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const id = projects.find((p) => p.Name === name)?.ID
  expect(id).toBeTruthy()
  return id!
}

async function stepEvents(page: Page, project: string): Promise<Ev[]> {
  return (await page.request.get(`/api/v1/events?project=${project}&type=task.step&limit=100&latest=1`)).json()
}

// Переход с шага code: событие называет пропущенные шаги.
async function codeStepEvent(page: Page, project: string): Promise<Ev> {
  let found: Ev | undefined
  await expect.poll(async () => {
    found = (await stepEvents(page, project)).find((e) => e.Payload.step === 'code' && e.Payload.outcome === 'ok')
    return Boolean(found)
  }, { timeout: 90_000 }).toBe(true)
  return found!
}

async function taskPR(page: Page, taskId: string): Promise<string> {
  const body: { task: { PRURL: string } } = await (await page.request.get(`/api/v1/tasks/${taskId}`)).json()
  return body.task.PRURL
}

test('процесс без проверок создаёт PR перед review и мержит его', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const name = `No test ${stamp}`
  const taskTitle = `Без проверок ${stamp}`

  await createProject(page, name)
  const project = await projectId(page, name)
  const resp = await page.request.put(`/api/v1/projects/${project}/policy`, {
    data: {
      process: {
        steps: [
          { id: 'code', kind: 'code', participants: [{ agent: {} }] },
          { id: 'test', kind: 'test', enabled: false, participants: [{ agent: {} }] },
          { id: 'review', kind: 'review', participants: [{ agent: {} }] },
          { id: 'merge', kind: 'merge' },
        ],
      },
    },
  })
  expect(resp.ok()).toBeTruthy()

  await createEpic(page, `Epic no test ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()

  const code = await codeStepEvent(page, project)
  expect(code.Payload.next).toBe('review')
  expect(code.Payload.skipped).toEqual(['test'])
  expect(code.Text).toContain('шаг test пропущен как отключённый')

  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.getByText('реализация готова, PR создан — ожидание review')).toBeVisible({ timeout: 30_000 })
  await expect(drawer.getByText('review пройден — ожидание подтверждения merge')).toBeVisible({ timeout: 90_000 })

  const pr = await taskPR(page, code.TaskID)
  expect(pr).toMatch(/^https:\/\/fake\.local\/.+\/pull\/\d+$/)
  await expect(drawer.getByRole('link', { name: 'Открыть PR' })).toHaveAttribute('href', pr)

  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
  expect(await taskPR(page, code.TaskID)).toBe(pr)
})

test('процесс без проверок и review мержит PR автоматически', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const name = `No review ${stamp}`
  const taskTitle = `Без review ${stamp}`

  await createProject(page, name)
  const project = await projectId(page, name)
  const resp = await page.request.put(`/api/v1/projects/${project}/policy`, {
    data: {
      auto_merge: true,
      process: {
        steps: [
          { id: 'code', kind: 'code', participants: [{ agent: {} }] },
          { id: 'test', kind: 'test', enabled: false, participants: [{ agent: {} }] },
          { id: 'review', kind: 'review', enabled: false, participants: [{ agent: {} }] },
          { id: 'merge', kind: 'merge' },
        ],
      },
    },
  })
  expect(resp.ok()).toBeTruthy()

  await createEpic(page, `Epic no review ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()

  const code = await codeStepEvent(page, project)
  expect(code.Payload.next).toBe('merge')
  expect(code.Payload.skipped).toEqual(['test', 'review'])

  await expectNodeStatus(page, taskTitle, 'DONE')
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.getByText('реализация готова, PR создан — ожидание подтверждения merge')).toBeVisible()
  await expect(drawer.getByText(/PR смержен автоматически по политике/)).toBeVisible()
  expect(await taskPR(page, code.TaskID)).toMatch(/^https:\/\/fake\.local\/.+\/pull\/\d+$/)
})
