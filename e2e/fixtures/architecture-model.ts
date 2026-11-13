import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { expect, type Page } from '@playwright/test'
import { LLM_URL } from '../stand'

const MODEL = 'fake-architect-assessment'

export interface ReportedArchitectureUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface FakeArchitectOptions {
  // null deliberately omits usage; absence of the option means known usage.
  reportedUsage?: ReportedArchitectureUsage | null
}

const DEFAULT_USAGE: ReportedArchitectureUsage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15
}

interface TeamAgent {
  id: string
  name: string
  role_id: string
  agent: string
  connection_id: string
  model: string
  instruction_extra: string
  enabled: boolean
  position: number
  updated_at: string
  busy: boolean
}

const editable = (agent: TeamAgent) => ({
  name: agent.name,
  role_id: agent.role_id,
  agent: agent.agent,
  connection_id: agent.connection_id,
  model: agent.model,
  instruction_extra: agent.instruction_extra,
  enabled: agent.enabled,
  position: agent.position
})

// The baseline fake-llm predates Epic assessment. This local model adapter
// supplies that one deterministic response; native tool/review requests still
// use the stand's original fake-llm. Browser/API requests are never mocked.
async function assessmentProvider(options: FakeArchitectOptions) {
  const usage = options.reportedUsage === undefined ? DEFAULT_USAGE : options.reportedUsage
  const seen = new Set<string>()
  const upstream = new URL(LLM_URL).origin
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    try {
      if (request.headers.authorization !== 'Bearer fake-key') {
        response.writeHead(401).end(JSON.stringify({ error: { message: 'invalid fixture key' } }))
        return
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: MODEL, object: 'model' }] }))
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end('{}')
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 1024 * 1024) {
          response.writeHead(413).end('{}')
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      const raw = Buffer.concat(chunks)
      const body = JSON.parse(raw.toString())
      const prompt = (body.messages ?? [])
        .map((message: { content?: unknown }) => (typeof message.content === 'string' ? message.content : ''))
        .find((text: string) => text.startsWith('[rivet:epic_architecture_assessment]'))
      if (prompt && !body.tools?.length) {
        const input = JSON.parse(
          prompt.slice(prompt.lastIndexOf('\nВХОДНЫЕ ДАННЫЕ:\n') + '\nВХОДНЫЕ ДАННЫЕ:\n'.length)
        )
        if (typeof input.epic_id !== 'string' || !Number.isInteger(input.revision))
          throw new Error('invalid assessment input')
        seen.add(input.epic_id)
        response.end(
          JSON.stringify({
            id: 'e2e-architecture-completion',
            model: body.model,
            ...(usage === null ? {} : { usage }),
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    decision: 'no_change',
                    summary:
                      'Тестовая работа использует существующий конвейер. Код и продукт независимо не проверялись.',
                    impact: [],
                    constraints: ['Сохранить действующие guards, review и отдельный Start'],
                    documentation: [],
                    risks: []
                  })
                }
              }
            ]
          })
        )
        return
      }
      const result = await fetch(upstream + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-key' },
        body: raw
      })
      response.statusCode = result.status
      response.end(await result.text())
    } catch {
      response.writeHead(500).end(JSON.stringify({ error: { message: 'architecture fixture failed' } }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('architecture fixture did not bind')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    seen,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}

let lease = Promise.resolve()

// Explicit positive-fixture opt-in. Ops model selection currently has no
// project role override, so Ada is borrowed serially and restored in finally.
// Planner, role defaults and all gates remain unchanged. Raw createEpic can
// still test missing-model/waiting behaviour without invoking this fixture.
export async function withFakeArchitect<T>(
  page: Page,
  body: (connection: string, seen: Set<string>) => Promise<T>,
  options: FakeArchitectOptions = {}
): Promise<T> {
  const previous = lease
  let release!: () => void
  lease = new Promise<void>(resolve => {
    release = resolve
  })
  await previous
  let provider: Awaited<ReturnType<typeof assessmentProvider>> | undefined
  const connection = 'arch-e2e-' + randomUUID()
  let before: TeamAgent | undefined
  let assigned = false
  let created = false
  let canDelete = true
  try {
    provider = await assessmentProvider(options)
    const team = await page.request.get('/api/v1/team')
    expect(team.ok()).toBeTruthy()
    before = (await team.json()).agents.find((agent: TeamAgent) => agent.id === 'ada')
    expect(before, 'positive fixture requires the existing Ada').toBeTruthy()
    expect(before!.role_id).toBe('architect')
    expect(before!.enabled, 'disabled architect is a negative fixture, not auto-enabled').toBe(true)
    expect(before!.busy, 'do not reconfigure an in-flight architect job').toBe(false)
    let response = await page.request.put(`/api/v1/system/connections/${connection}`, {
      data: {
        name: 'E2E scoped architect',
        kind: 'local',
        api: 'openai',
        base_url: provider.url,
        key: 'fake-key'
      }
    })
    expect(response.ok()).toBeTruthy()
    created = true
    response = await page.request.post(`/api/v1/system/connections/${connection}/discover`)
    expect(response.ok()).toBeTruthy()
    // Synthetic fixture rates, not a real provider price. Persist them before
    // model assignment/call so control-plane metering can snapshot the catalog.
    response = await page.request.put(`/api/v1/system/connections/${connection}/models`, {
      data: {
        models: [
          {
            id: MODEL,
            label: 'E2E deterministic architect',
            input_price: 1_000_000,
            output_price: 1_000_000,
            source: 'manual'
          }
        ]
      }
    })
    expect(response.ok()).toBeTruthy()
    // Treat the mutation as uncertain before sending: a lost HTTP response
    // must still reconcile and restore an assignment that reached the server.
    assigned = true
    canDelete = false
    response = await page.request.put('/api/v1/system/team/ada', {
      data: {
        ...editable(before!),
        agent: 'rivet',
        connection_id: connection,
        model: MODEL,
        updated_at: before!.updated_at
      }
    })
    expect(response.ok()).toBeTruthy()
    return await body(connection, provider.seen)
  } finally {
    try {
      if (assigned && before) {
        const current = (await (await page.request.get('/api/v1/team')).json()).agents.find(
          (agent: TeamAgent) => agent.id === 'ada'
        ) as TeamAgent
        canDelete = current?.connection_id !== connection
        const owned =
          current?.connection_id === connection &&
          current.model === MODEL &&
          current.agent === 'rivet' &&
          current.name === before.name &&
          current.role_id === before.role_id &&
          current.instruction_extra === before.instruction_extra &&
          current.enabled === before.enabled &&
          current.position === before.position
        expect.soft(owned, 'scoped Ada assignment is still owned by this fixture').toBeTruthy()
        if (owned) {
          const response = await page.request.put('/api/v1/system/team/ada', {
            data: { ...editable(before), updated_at: current.updated_at }
          })
          expect.soft(response.ok(), 'Ada configuration restored after the positive fixture').toBeTruthy()
          canDelete = response.ok()
        }
      }
      // Always reread references immediately before deleting the owned
      // connection, including failed/uncertain assignment and restore paths.
      // An unavailable read is not evidence that deletion is safe.
      if (created) {
        try {
          const references = await page.request.get('/api/v1/team')
          if (!references.ok()) canDelete = false
          else {
            const agents = (await references.json()).agents as TeamAgent[]
            canDelete = Array.isArray(agents) && !agents.some(agent => agent.connection_id === connection)
          }
        } catch {
          canDelete = false
        }
      }
      if (created && canDelete) {
        const response = await page.request.delete(`/api/v1/system/connections/${connection}`)
        expect.soft(response.ok(), 'scoped architect connection removed').toBeTruthy()
      } else if (created) {
        expect
          .soft(
            false,
            'scoped connection retained because Ada may still reference it; no concurrent configuration is overwritten'
          )
          .toBeTruthy()
      }
    } finally {
      try {
        await provider?.close()
      } finally {
        release()
      }
    }
  }
}

export async function waitForEpicAssessment(page: Page, connection?: string, seen?: Set<string>) {
  const epicId = /#\/p\/[^/]+\/epic\/([^/?]+)/.exec(page.url())?.[1]
  if (!epicId) throw new Error('assessment fixture requires the Epic dashboard')
  let view: any
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/v1/epics/${epicId}/architecture-assessment`)
        expect(response.ok()).toBeTruthy()
        view = await response.json()
        return view.assessment?.status
      },
      { timeout: 60_000, message: 'real Ada assessment completes before task creation/Start' }
    )
    .toBe('passed')
  expect(view.required).toBe(true)
  expect(view.assessment.revision).toBe(view.revision)
  expect(view.assessment.agent_id).toBe('ada')
  expect(view.assessment.result.decision).toBe('no_change')
  if (connection) expect(view.assessment.connection_id).toBe(connection)
  if (seen) expect(seen.has(epicId), 'the model provider processed this exact Epic').toBe(true)
  await expect(page.getByRole('region', { name: 'Архитектурная оценка Epic' })).toContainText(
    'Архитектурная оценка пройдена'
  )
  await expect(page.getByRole('button', { name: 'Добавить задачу', exact: true })).toBeEnabled()
}
