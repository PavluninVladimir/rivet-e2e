import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node, openProjectSettings, openSection } from './helpers'
import { SERVICE_DIR, STAND, runnerSandbox } from './stand'

// Агент Rivet (add-native-agent): единственный агент установки, агентский
// цикл ведёт сам runner. Вкладка «Агент» правит модель по умолчанию из
// каталога подключений и лимиты сессии, сторонних агентов нет ни в консоли,
// ни в API. Runner'ы стенда показывают агента и модели каталога, участник
// процесса — только агент Rivet с моделью каталога. Модель по умолчанию и
// явная модель участника доходят до назначения, проект переопределяет
// модель по умолчанию на вкладке «Политики».

// Служебное подключение стенда к fake-llm (scripts/e2e-stand.sh) и его ключ.
const CONN = process.env.E2E_LLM_CONNECTION ?? 'e2e-llm'
const PROVIDER_KEY = 'fake-key'
// Песочница команд агента: стенд запускает runner'ы с
// RIVET_RUNNER_UNSANDBOXED=1, то есть разрешает работать без песочницы,
// если её нет (macOS, Docker с seccomp по умолчанию, Linux без user
// namespaces). Где проба песочницы проходит, команды агента всё равно идут
// в песочнице без сети. Ожидание по каждому runner'у берётся из его пробы в
// журнале стенда (runnerSandbox в stand.ts), а не из того же GET /runners,
// который рисует консоль: иначе ошибка флага при регистрации осталась бы
// незамеченной.
// Runner'ы агента Rivet на стенде; e2e-deployer — runner выкатки без агента.
const AGENT_RUNNERS = ['e2e-reviewer', 'e2e-reviewer2', 'e2e-worker', 'e2e-worker2']

interface ModelRef { connection_id: string; model: string }
interface AgentProfile {
  id: string; name: string; secrets: string; enabled: boolean
  default_model: ModelRef | null
  limits?: { max_turns?: number; max_tokens?: number; max_minutes?: number }
}
interface Runner { ID: string; Agent: string; NetworkIsolated?: boolean }

async function projectId(page: Page, name: string): Promise<string> {
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const id = projects.find((p) => p.Name === name)?.ID
  expect(id).toBeTruthy()
  return id!
}

// Каталог агентов: в нём ровно один профиль — агент Rivet.
async function rivetAgent(page: Page): Promise<AgentProfile> {
  const r = await page.request.get('/api/v1/system/agents')
  expect(r.ok()).toBeTruthy()
  const body: { agents: AgentProfile[] } = await r.json()
  expect(body.agents.map((a) => a.id)).toEqual(['rivet'])
  return body.agents[0]
}

test('агент Rivet: модель по умолчанию и лимиты, runner’ы, участник процесса, переопределение в проекте', async ({ page }) => {
  test.setTimeout(240_000)
  await login(page)
  const stamp = Date.now()
  const initial = await rivetAgent(page)
  // Модель по умолчанию стенд задаёт до старта runner'ов.
  expect(initial.default_model).toMatchObject({ connection_id: CONN, model: 'fake-small' })

  try {
    // Сторонних агентов нет: другой профиль не создаётся, агент Rivet не удаляется.
    // Ошибки в общем конверте {"error":{"code","message"}}.
    let r = await page.request.put('/api/v1/system/agents/claude-code', { data: { name: 'Claude Code' } })
    expect(r.status()).toBe(422)
    expect(await r.json()).toMatchObject({ error: { code: 'agent_unsupported', message: expect.any(String) } })
    r = await page.request.delete('/api/v1/system/agents/rivet')
    expect(r.status()).toBe(422)
    expect(await r.json()).toMatchObject({ error: { code: 'agent_preset', message: expect.any(String) } })

    // Runner'ы стенда зарегистрированы (они стартуют фоном после rivetd).
    let agentRunners: Runner[] = []
    await expect.poll(async () => {
      const list: Runner[] = await (await page.request.get('/api/v1/runners')).json()
      agentRunners = list.filter((x) => x.Agent === 'rivet')
      return agentRunners.map((x) => x.ID).sort()
    }, { timeout: 30_000 }).toEqual(AGENT_RUNNERS)
    // Флаг каждого runner'а совпадает с пробой песочницы из его журнала.
    const sandboxed: Record<string, boolean> = {}
    for (const id of AGENT_RUNNERS) {
      await expect.poll(async () => {
        const v = await runnerSandbox(id)
        if (v !== undefined) sandboxed[id] = v
        return v
      }, { message: `проба песочницы в журнале runner'а ${id}`, timeout: 10_000 }).not.toBeUndefined()
    }
    for (const x of agentRunners) expect(x.NetworkIsolated ?? false, `NetworkIsolated у ${x.ID}`).toBe(sandboxed[x.ID])
    const isolated = AGENT_RUNNERS.filter((id) => sandboxed[id]).length

    // Вкладка «Агент»: одна карточка без создания агентов, модели — из
    // подключения стенда, счётчик runner'ов без runner'а выкатки.
    await page.goto('/#/app-management/agents')
    const card = page.locator('.conn-card[data-agent="rivet"]')
    await expect(card).toContainText('Агент Rivet')
    await expect(card).toContainText('встроенный')
    await expect(page.getByRole('button', { name: 'Новый агент' })).toHaveCount(0)
    const models = card.locator('[data-agent-models]')
    await expect(models).toContainText(`${CONN}/fake-small · по умолчанию`)
    await expect(models).toContainText(`${CONN}/fake-large`)
    const runnersNote = card.locator('[data-agent-runners]')
    await expect(runnersNote).toContainText(`runner’ов: ${AGENT_RUNNERS.length}`)
    await expect(runnersNote).toContainText(`в песочнице без сети ${isolated} из ${AGENT_RUNNERS.length}`)

    // Нечисловой ввод («-») браузер не отдаёт в value: поле отмечается
    // ошибкой, а «Отменить правки» снимает и отметку, и сам ввод в поле.
    const turns = page.getByLabel('Ходов')
    const reset = page.getByRole('button', { name: 'Отменить правки' })
    await expect(reset).toBeDisabled()
    await turns.fill('40')
    await turns.press('ControlOrMeta+a')
    await turns.pressSequentially('-')
    await expect(page.locator('[data-agent-limits] [role="alert"]').first()).toContainText('целое число больше нуля')
    await expect(reset).toBeEnabled()
    await reset.click()
    await expect(page.locator('[data-agent-limits] [role="alert"]')).toHaveCount(0)
    await expect(reset).toBeDisabled()
    await expect(turns).toHaveValue(initial.limits?.max_turns ? String(initial.limits.max_turns) : '')
    expect(await turns.evaluate((el) => (el as HTMLInputElement).validity.badInput), 'ввод «-» снят').toBe(false)

    // Модель по умолчанию — из моделей каталога; неверный лимит не даёт
    // сохранить, верные лимиты сохраняются вместе с моделью.
    const defModel = page.getByLabel('Модель по умолчанию')
    await expect(defModel.locator('option', { hasText: `${CONN} / fake-large` })).toHaveCount(1)
    await defModel.selectOption(`${CONN}/fake-large`)
    const save = page.getByRole('button', { name: 'Сохранить', exact: true })
    await page.getByLabel('Ходов').fill('0')
    await expect(page.locator('[data-agent-limits] [role="alert"]').first()).toContainText('целое число больше нуля')
    await expect(save).toBeDisabled()
    await page.getByLabel('Ходов').fill('40')
    await page.getByLabel('Токенов').fill('500000')
    await page.getByLabel('Минут').fill('20')
    await save.click()
    await expect(page.getByText('настройки агента сохранены')).toBeVisible()
    await expect(models).toContainText(`${CONN}/fake-large · по умолчанию`)

    // Настройки переживают перезагрузку и видны в API.
    await page.reload()
    await expect(page.getByLabel('Модель по умолчанию')).toHaveValue(`${CONN}/fake-large`)
    await expect(page.getByLabel('Ходов')).toHaveValue('40')
    await expect(page.getByLabel('Токенов')).toHaveValue('500000')
    await expect(page.getByLabel('Минут')).toHaveValue('20')
    const saved = await rivetAgent(page)
    expect(saved.default_model).toMatchObject({ connection_id: CONN, model: 'fake-large' })
    expect(saved.limits).toEqual({ max_turns: 40, max_tokens: 500000, max_minutes: 20 })

    // Список runner'ов: у агентских — агент Rivet, модели каталога и полная
    // глубина; предупреждение о сети — ровно у runner'ов без песочницы
    // (ожидание — проба из журнала runner'а, см. sandboxed).
    await page.goto('/#/runners')
    const runnerRow = (id: string) => page.locator('tr', { has: page.locator(`[data-runner-name="${id}"]`) })
    const reviewer = runnerRow('e2e-reviewer2')
    const agentCell = reviewer.locator('td[data-runner-agent]')
    await expect(agentCell).toHaveAttribute('data-runner-agent', 'rivet')
    await expect(agentCell).toContainText('Агент Rivet')
    await expect(agentCell).toContainText('fake-small')
    await expect(agentCell).toContainText('fake-large')
    await expect(agentCell).not.toContainText('агент не поддерживается')
    await expect(reviewer).toContainText('full')
    for (const id of AGENT_RUNNERS) {
      await expect(runnerRow(id).locator('[data-network-open]')).toHaveCount(sandboxed[id] ? 0 : 1)
    }
    // Runner выкатки: агента нет, предупреждения о сети тоже.
    const deployer = runnerRow('e2e-deployer')
    await expect(deployer.locator('td[data-runner-agent="deploy"]')).toContainText('runner выкатки')
    await expect(deployer.locator('[data-network-open]')).toHaveCount(0)

    // Процесс проекта: сторонний агент участником не принимается, модель
    // вне каталога подключений отклоняется у поля модели.
    const project = `Agents ${stamp}`
    await createProject(page, project)
    const pid = await projectId(page, project)
    const withReviewer = (agent: Record<string, string>) => ({ process: { steps: [
      { id: 'code', kind: 'code', participants: [{ agent: {} }] },
      { id: 'review', kind: 'review', participants: [{ agent }] },
      { id: 'merge', kind: 'merge' },
    ] } })
    r = await page.request.put(`/api/v1/projects/${pid}/policy`, { data: withReviewer({ kind: 'claude-code' }) })
    expect(r.status()).toBe(422)
    expect(await r.json()).toMatchObject({ step: 'review', field: 'participants[0].agent.kind' })
    r = await page.request.put(`/api/v1/projects/${pid}/policy`, { data: withReviewer({ kind: 'rivet', model: 'fake-nope' }) })
    expect(r.status()).toBe(422)
    expect(await r.json()).toMatchObject({ step: 'review', field: 'participants[0].agent.model' })

    // Окно шага: агент один — агент Rivet, модель по умолчанию берётся из
    // вкладки «Агент». Ревьюеру задаётся явная модель.
    await openProjectSettings(page, project, 'Процесс')
    await page.locator('.pg-node[data-step="review"]').click()
    const dlg = page.getByRole('dialog')
    const part = dlg.locator('[data-participant]').first()
    await expect(part.getByLabel('агент', { exact: true }).locator('option')).toHaveText(['агент Rivet'])
    const partModel = part.getByLabel('модель', { exact: true })
    await expect(partModel).toContainText('по умолчанию (fake-large)')
    await partModel.selectOption('fake-small')
    await dlg.getByRole('button', { name: 'Готово' }).click()
    await page.getByRole('button', { name: 'Сохранить процесс' }).click()
    await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')

    // Задача: review идёт на явной модели участника, coding — на модели
    // агента по умолчанию.
    await openSection(page, 'Epic’и')
    await createEpic(page, `Epic agents ${stamp}`)
    const taskTitle = `Агент Rivet ${stamp}`
    await addTask(page, taskTitle)
    await page.getByRole('button', { name: 'Запустить' }).click()
    await expectNodeStatus(page, taskTitle, 'REVIEW')
    // Исход шага review в event log: вердикт участника с моделью назначения.
    await expect.poll(async () => {
      const events: Array<{ Payload: { step?: string; outcome?: string; verdicts?: Array<{ model: string }> } }> =
        await (await page.request.get(`/api/v1/events?project=${pid}&type=task.step&limit=100&latest=1`)).json()
      const ev = events.find((e) => e.Payload.step === 'review' && e.Payload.outcome === 'ok')
      return ev?.Payload.verdicts?.[0]?.model ?? ''
    }, { timeout: 60_000 }).toBe('fake-small')
    await node(page, taskTitle).click()
    const drawer = page.locator('#drawer')
    await expect(drawer.locator('.sess-row', { hasText: 'CODING' }).first().locator('.sess-agent'))
      .toContainText('rivet · fake-large')

    // Ключ подключения уходит runner'у по режиму секретов (endpoint
    // назначения) и нигде не всплывает: ни в транскриптах coding и review,
    // ни в событиях задачи, ни в ответах API runner'ов, агента и подключений.
    const taskId = /\/epic\/[^/]+\/task\/([^/?]+)/.exec(page.url())?.[1]
    expect(taskId, 'адрес деталки задачи').toBeTruthy()
    let withTranscript: Array<{ id: string; stage: string; has_transcript: boolean }> = []
    await expect.poll(async () => {
      const sessions: typeof withTranscript = await (await page.request.get(`/api/v1/tasks/${taskId}/sessions`)).json()
      withTranscript = sessions.filter((x) => x.has_transcript)
      return withTranscript.map((x) => x.stage)
    }, { timeout: 30_000 }).toEqual(expect.arrayContaining(['coding', 'review']))
    for (const x of withTranscript) {
      const text = await (await page.request.get(`/api/v1/sessions/${x.id}/transcript`)).text()
      expect(text.length, `транскрипт ${x.stage}`).toBeGreaterThan(0)
      expect(text, `транскрипт ${x.stage}`).not.toContain(PROVIDER_KEY)
    }
    for (const url of [`/api/v1/tasks/${taskId}`, `/api/v1/events?project=${pid}&limit=500`, '/api/v1/runners',
      '/api/v1/system/agents', '/api/v1/system/connections', '/api/v1/models/choices']) {
      const res = await page.request.get(url)
      expect(res.ok(), url).toBeTruthy()
      expect(await res.text(), url).not.toContain(PROVIDER_KEY)
    }

    // Переопределение модели агента в проекте на вкладке «Политики».
    await openProjectSettings(page, project, 'Политики')
    const row = page.locator('.set-row[data-agent-model="rivet"]')
    await expect(row).toContainText('наследуется')
    await expect(row).toContainText(`действует: ${CONN}/fake-large`)
    await row.getByLabel(/переопределить/).check()
    await row.getByLabel('модель агента rivet').selectOption(`${CONN}/fake-small`)
    await page.locator('.set-row', { hasText: 'создаёт новую версию политики проекта' })
      .getByRole('button', { name: 'Сохранить версию' }).click()
    await expect(page.getByText(/сохранена версия проекта/)).toBeVisible()
    await expect(row).toContainText('переопределено')
    await expect(row.getByLabel('модель агента rivet')).toHaveValue(`${CONN}/fake-small`)
    const pol: { agent_models?: Record<string, { source: string; effective: ModelRef | null }> } =
      await (await page.request.get(`/api/v1/projects/${pid}/policy`)).json()
    expect(pol.agent_models?.rivet).toMatchObject({ source: 'project', effective: { connection_id: CONN, model: 'fake-small' } })
  } finally {
    // Агент возвращается к настройкам стенда: модель по умолчанию и лимиты
    // действуют на все остальные сценарии. Неудачный откат виден отдельной
    // ошибкой и не подменяет исходную.
    const r = await page.request.put('/api/v1/system/agents/rivet', { data: {
      name: initial.name, default_model: initial.default_model, secrets: initial.secrets,
      enabled: initial.enabled, limits: initial.limits ?? {},
    } })
    expect.soft(r.ok(), `откат агента Rivet: ${r.status()} ${await r.text()}`).toBeTruthy()
  }
})

// Сторонний агент (add-native-agent, задача 3.5): rivet-runner с другим
// агентом не стартует вовсе, поэтому регистрацию с агентом claude-code
// делает тестовый gRPC-клиент стенда (rivet-service/scripts/e2e-register)
// с токеном регистрации стенда. Control plane отвечает FAILED_PRECONDITION,
// пишет runner.rejected в журнал установки, и runner в список не попадает.
test('регистрация runner’а со сторонним агентом отклоняется с событием runner.rejected', async ({ page }) => {
  // go run компилирует клиент: на холодном кеше это дольше обычного шага.
  test.setTimeout(240_000)
  await login(page)
  const id = `e2e-cc-${Date.now()}`
  const status: { protocol_version: string } = await (await page.request.get('/api/v1/system/status')).json()
  expect(status.protocol_version).toBeTruthy()

  const { stdout } = await promisify(execFile)('go', ['run', './scripts/e2e-register',
    '-addr', `localhost:${STAND.grpcPort}`, '-token-file', path.join(STAND.dir, 'runner-token'),
    '-id', id, '-agent', 'claude-code', '-protocol', status.protocol_version,
  ], { cwd: SERVICE_DIR, timeout: 200_000 })
  const res = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
  expect(res).toMatchObject({ accepted: false, code: 'FailedPrecondition' })

  // Событие в журнале установки: кто и с каким агентом пытался войти.
  let rejected: { Text: string; Payload: Record<string, unknown> } | undefined
  await expect.poll(async () => {
    const events: Array<{ Text: string; Payload: Record<string, unknown> }> | null =
      await (await page.request.get('/api/v1/events?scope=installation&type=runner.rejected&latest=1&limit=100')).json()
    rejected = (events ?? []).find((e) => e.Payload.runner_id === id)
    return !!rejected
  }, { timeout: 15_000 }).toBe(true)
  expect(rejected!.Payload).toMatchObject({ agent: 'claude-code', token_name: 'e2e-runners' })
  const runners: Runner[] = await (await page.request.get('/api/v1/runners')).json()
  expect(runners.map((x) => x.ID)).not.toContain(id)

  // То же событие видно администратору на вкладке «Аудит».
  await page.goto('/#/app-management/audit')
  await page.getByLabel('тип события').selectOption('runner.rejected')
  await expect(page.locator('.act-row', { hasText: id })).toContainText('отклонена')
})

// Переопределение модели агента, которого больше нет в каталоге (до
// add-native-agent проект мог задать модель агенту claude-code), и модели
// роли без строки в форме. Форма шлёт переопределения целиком, поэтому с
// невидимыми ключами сервер не принял бы ни одной новой версии. Консоль
// показывает их с действием «снять». Такой документ политики нельзя
// создать через API (сервер его отклоняет), поэтому ответ GET подменяется.
test('устаревшие переопределения политики проекта видны и снимаются', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const project = `Stale ${stamp}`
  await createProject(page, project)
  const pid = await projectId(page, project)

  const policyURL = `**/api/v1/projects/${pid}/policy`
  let stale = true
  await page.route(policyURL, async (route) => {
    if (route.request().method() !== 'GET' || !stale) return route.fallback()
    const response = await route.fetch()
    const body = await response.json()
    body.overrides = {
      ...body.overrides,
      agent_models: { ...(body.overrides.agent_models ?? {}), 'claude-code': { connection_id: 'anthropic', model: 'claude-sonnet-legacy' } },
      role_models: { ...(body.overrides.role_models ?? {}), 'e2e-ghost': { agent: 'claude-code', connection_id: 'anthropic', model: 'claude-sonnet-legacy' } },
    }
    await route.fulfill({ response, json: body })
  })

  await openProjectSettings(page, project, 'Политики')
  const agentRow = page.locator('[data-stale-override="agent_models.claude-code"]')
  const roleRow = page.locator('[data-stale-override="role_models.e2e-ghost"]')
  await expect(agentRow).toContainText('агент удалён')
  await expect(agentRow).toContainText('anthropic/claude-sonnet-legacy')
  await expect(roleRow).toContainText('роль недоступна')

  await agentRow.getByRole('button', { name: 'снять' }).click()
  await roleRow.getByRole('button', { name: 'снять' }).click()
  await expect(agentRow).toHaveCount(0)
  await expect(roleRow).toHaveCount(0)
  // Дальше ответы сервера настоящие: правки владельца уже в черновике.
  stale = false

  // Новая версия сохраняется, в теле нет снятых ключей.
  const limit = page.locator('.set-row', { hasText: 'Лимит попыток' })
  await limit.getByLabel(/переопределить/).check()
  const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/projects/${pid}/policy`))
  await page.locator('.set-row', { hasText: 'создаёт новую версию политики проекта' })
    .getByRole('button', { name: 'Сохранить версию' }).click()
  const sent = JSON.parse((await put).postData() ?? '{}')
  expect(sent.agent_models?.['claude-code']).toBeUndefined()
  expect(sent.role_models?.['e2e-ghost']).toBeUndefined()
  await expect(page.getByText(/сохранена версия проекта/)).toBeVisible()
  const pol: { overrides: { attempt_limit: number | null; agent_models?: Record<string, unknown> | null } } =
    await (await page.request.get(`/api/v1/projects/${pid}/policy`)).json()
  expect(pol.overrides.attempt_limit).not.toBeNull()
  expect(pol.overrides.agent_models?.['claude-code']).toBeUndefined()
})

// Участник процесса со сторонним агентом из старого документа (до
// add-native-agent kind мог быть claude-code). Сохранить такой процесс
// через API нельзя, поэтому ответ GET подменяется: окно шага показывает
// агента с пометкой «не поддерживается», после сброса остаётся только
// агент Rivet.
test('участник процесса со сторонним агентом помечен «не поддерживается»', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const project = `Legacy kind ${stamp}`
  await createProject(page, project)
  const pid = await projectId(page, project)
  const proc = { steps: [
    { id: 'code', kind: 'code', participants: [{ agent: {} }] },
    { id: 'review', kind: 'review', participants: [{ agent: { kind: 'claude-code' } }] },
    { id: 'merge', kind: 'merge' },
  ] }
  await page.route(`**/api/v1/projects/${pid}/policy`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: {
      ...body, process_source: 'project',
      effective: { ...body.effective, process: proc }, overrides: { ...body.overrides, process: proc },
    } })
  })

  await openProjectSettings(page, project, 'Процесс')
  await page.locator('.pg-node[data-step="review"]').click()
  const agent = page.getByRole('dialog').locator('[data-participant]').first().getByLabel('агент', { exact: true })
  await expect(agent).toHaveValue('claude-code')
  await expect(agent.locator('option:checked')).toHaveText('claude-code (не поддерживается)')
  await agent.selectOption('')
  await expect(agent.locator('option')).toHaveText(['агент Rivet'])
})
