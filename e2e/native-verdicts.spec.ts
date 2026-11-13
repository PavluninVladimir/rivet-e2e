import { expect, test, type Page } from '@playwright/test'
import { addTask, createAssessedEpic, createProject, login, node } from './helpers'

// Вердикты агента Rivet на шагах test и review (add-native-agent, задача
// 3.3). Тестировщик и ревьюер — тот же агентский цикл runner'а, что и
// разработчик, вердикт changes они возвращают инструментом finish. Метки
// fake-llm (rivet-service/cmd/fake-llm/native.go):
//   [e2e-tester-changes] — тестировщик просит доработку, пока в изменениях
//     задачи нет строк тестов (первый проход);
//   [e2e-native-changes] — ревьюер просит доработку, пока в задаче меньше
//     двух строк «work» (первый проход). Ревьюер получает заголовок,
//     критерии и diff PR, но не описание задачи (reviewPrompt в
//     rivet-service/internal/runner/stage.go), поэтому метка стоит в
//     заголовке.
// Задача уходит на исправление, второй проход одобряется, merge кнопкой.
// Процесс проекта задаётся явно: тестировщик на шаге test и ревьюер на
// шаге review не зависят от того, что другие сценарии сохранили в
// процессе установки.

interface Verdict { verdict?: string; agent_verdict?: string; model?: string; role?: { id: string } }
interface StepEvent { Payload: { step?: string; outcome?: string; next?: string; verdicts?: Verdict[] } }

async function projectWithRoles(page: Page, name: string): Promise<string> {
  await createProject(page, name)
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const pid = projects.find((p) => p.Name === name)?.ID
  expect(pid).toBeTruthy()
  const r = await page.request.put(`/api/v1/projects/${pid}/policy`, { data: { process: { steps: [
    { id: 'code', kind: 'code', participants: [{ agent: { role: 'developer' } }] },
    { id: 'test', kind: 'test', participants: [{ agent: { role: 'tester' } }] },
    { id: 'review', kind: 'review', participants: [{ agent: { role: 'reviewer' } }] },
    { id: 'merge', kind: 'merge' },
  ] } } })
  expect(r.ok(), `процесс проекта: ${r.status()}`).toBeTruthy()
  return pid!
}

// Пустая лента — пустой список: null от старого rivetd тоже, ожидание
// продолжается, а не падает на поиске.
async function stepEvents(page: Page, pid: string): Promise<StepEvent[]> {
  const body: StepEvent[] | null = await (await page.request.get(`/api/v1/events?project=${pid}&type=task.step&limit=200`)).json()
  return body ?? []
}

// Первое событие шага с этим исходом: переход и вердикт участника.
async function waitStep(page: Page, pid: string, step: string, outcome: string, timeout = 120_000) {
  let found: StepEvent | undefined
  await expect.poll(async () => {
    found = (await stepEvents(page, pid)).find((e) => e.Payload.step === step && e.Payload.outcome === outcome)
    return !!found
  }, { timeout, message: `шаг ${step}: ${outcome}` }).toBe(true)
  return found!
}

// Сессии стадии в деталке: проходы, исполнитель каждого — агент Rivet.
async function expectStagePasses(page: Page, stage: string, passes: number) {
  const rows = page.locator('#drawer .sess-row', { hasText: stage })
  await expect.poll(() => rows.count(), { message: `сессии ${stage}` }).toBeGreaterThanOrEqual(passes)
  for (let i = 0; i < passes; i++) await expect(rows.nth(i).locator('.sess-agent')).toContainText('rivet')
}

test('тестировщик Rivet возвращает задачу с changes, второй проход доходит до done', async ({ page }) => {
  test.setTimeout(300_000)
  await login(page)
  const stamp = Date.now()
  const pid = await projectWithRoles(page, `Tester ${stamp}`)
  const taskTitle = `Тестировщик changes ${stamp}`
  await createAssessedEpic(page, `Epic tester ${stamp}`)
  await addTask(page, taskTitle, 'Тесты по критериям [e2e-tester-changes]')
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Первый проход: вердикт changes вынес сам тестировщик (agent_verdict),
  // а не упавшая проверка; задача уходит на исправление в шаг code.
  const changes = await waitStep(page, pid, 'test', 'changes')
  expect(changes.Payload.next).toBe('code')
  expect(changes.Payload.verdicts?.[0]).toMatchObject({ verdict: 'changes', agent_verdict: 'changes', role: { id: 'tester' } })

  // Второй проход: тесты уже в изменениях задачи, тестировщик одобряет,
  // review тоже.
  const ok = await waitStep(page, pid, 'test', 'ok')
  expect(ok.Payload.verdicts?.[0]).toMatchObject({ verdict: 'ok', agent_verdict: 'ok', role: { id: 'tester' } })
  await waitStep(page, pid, 'review', 'ok')

  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expectStagePasses(page, 'TESTING', 2)
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})

test('ревьюер Rivet возвращает задачу с changes через finish, второй review доходит до done', async ({ page }) => {
  test.setTimeout(300_000)
  await login(page)
  const stamp = Date.now()
  const pid = await projectWithRoles(page, `Reviewer ${stamp}`)
  const taskTitle = `Ревьюер changes ${stamp} [e2e-native-changes]`
  await createAssessedEpic(page, `Epic reviewer ${stamp}`)
  await addTask(page, taskTitle, 'Ревью в два прохода')
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Первый review: одна строка work в ветке задачи — ревьюер просит
  // доработку.
  const changes = await waitStep(page, pid, 'review', 'changes')
  expect(changes.Payload.next).toBe('code')
  expect(changes.Payload.verdicts?.[0]).toMatchObject({ verdict: 'changes', role: { id: 'reviewer' } })
  // Второй review после исправления: две строки work — одобрено.
  const ok = await waitStep(page, pid, 'review', 'ok')
  expect(ok.Payload.verdicts?.[0]).toMatchObject({ verdict: 'ok', role: { id: 'reviewer' } })

  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expectStagePasses(page, 'REVIEW', 2)
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})
