import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node, projectFromURL } from './helpers'
import { STAND } from './stand'

// Поток событий и перечитывания консоли (fix-console-rivetd-tails, спеки
// observability «Поток событий проекта», web «Перечитывания по потоку
// событий»). Поток без Last-Event-ID начинается с момента подключения и
// историю не проигрывает: состояние консоль читает запросами и
// перечитывает после любого подключения. События, пришедшие пачкой,
// перечитывают каждый источник не чаще раза в секунду. Раньше каждое
// task.status из журнала давало четыре запроса, и проект с 2000 событий
// открывался восемью тысячами.

// Число переходов статуса в истории проекта до открытия консоли.
const HISTORY = 150
// Запросов к API за первые секунды на дашборде Epic'а. Своих запросов у
// экрана и стора около двадцати, реплей истории дал бы больше 600.
const MAX_REQUESTS = 80
// Пачка живых переходов статуса в открытую консоль. Со склейкой каждый
// адрес перечитывается не чаще раза в секунду, поэтому порог считается от
// длительности пачки, а не от числа событий: без склейки по четыре запроса
// на событие (больше 400).
const BURST = 100

// Задача в Epic'е и её отмена: событие task.status в журнале проекта.
async function addCancelled(request: APIRequestContext, epicId: string, title: string): Promise<string> {
  const r = await request.post(`/api/v1/epics/${epicId}/tasks`, { data: { title, criteria: ['e2e'] } })
  expect(r.ok()).toBeTruthy()
  const task = await r.json() as { ID: string }
  const c = await request.post(`/api/v1/tasks/${task.ID}/cancel`)
  expect(c.ok()).toBeTruthy()
  return task.ID
}

// Запросы страницы к API, кроме самого потока: всего и по адресам
// (идентификаторы в пути заменены на :id).
function countRequests(page: Page): { reset: () => void; get: () => number; byPath: () => Map<string, number> } {
  let n = 0
  let paths = new Map<string, number>()
  page.on('request', r => {
    const path = new URL(r.url()).pathname
    if (!path.startsWith('/api/') || path === '/api/v1/stream') return
    n++
    const key = path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')
    paths.set(key, (paths.get(key) ?? 0) + 1)
  })
  return { reset: () => { n = 0; paths = new Map() }, get: () => n, byPath: () => paths }
}

test('проект с длинным журналом открывается без лавины запросов, пачка живых событий склеивается', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  await createProject(page, `Журнал ${stamp}`)
  await createEpic(page, `Журнал ${stamp}`)
  const epicURL = page.url()
  const epicId = /\/epic\/([^/?]+)/.exec(epicURL)?.[1]
  expect(epicId).toBeTruthy()

  // История собирается через API, пока консоль закрыта: сотню отмен руками
  // через UI не набрать, а открытая консоль получила бы их вживую.
  await page.goto('about:blank')
  for (let i = 0; i < HISTORY; i++) await addCancelled(page.request, epicId!, `История ${i}`)

  const requests = countRequests(page)
  await page.goto(epicURL)
  await expect(node(page, 'История 0')).toBeVisible()
  await page.waitForTimeout(6_000)
  expect(requests.get(), 'запросов к API после открытия дашборда').toBeLessThan(MAX_REQUESTS)

  // Пачка живых переходов в открытую консоль: каждый адрес перечитывается
  // не чаще раза в секунду (запас — на явные перечитывания и повтор
  // занятости агентов), итоговое состояние видно без перезагрузки.
  requests.reset()
  const started = Date.now()
  for (let i = 0; i < BURST; i++) await addCancelled(page.request, epicId!, `Пачка ${stamp} ${i}`)
  await expectNodeStatus(page, `Пачка ${stamp} ${BURST - 1}`, 'CANCELLED', 20_000)
  await page.waitForTimeout(3_000)
  const seconds = Math.ceil((Date.now() - started) / 1000)
  for (const [path, n] of requests.byPath()) {
    expect(n, `${path}: ${n} запросов за ${seconds} с пачки из ${BURST} переходов`).toBeLessThanOrEqual(2 * seconds + 3)
  }
})

// Обратный прокси к стенду: консоль открывается через него, тест рвёт
// соединения потока и на время разрыва не пускает новые, как при потере
// сети. Прокси видит, с каким Last-Event-ID браузер переподключается и что
// сервер отдаёт в ответ.
interface StreamSeen { url: string; lastEventId: string | undefined; body: string }
async function streamProxy(): Promise<{ origin: string; streams: StreamSeen[]; cut: () => void; restore: () => void; close: () => Promise<void> }> {
  const open = new Set<{ up: http.ClientRequest; res: http.ServerResponse }>()
  const streams: StreamSeen[] = []
  let blocked = false
  const server = http.createServer((req, res) => {
    const isStream = (req.url ?? '').startsWith('/api/v1/stream')
    if (isStream && blocked) { res.socket?.destroy(); return }
    const seen: StreamSeen = { url: req.url ?? '', lastEventId: req.headers['last-event-id'] as string | undefined, body: '' }
    const up = http.request({ host: '127.0.0.1', port: Number(STAND.httpPort), method: req.method, path: req.url, headers: req.headers }, u => {
      res.writeHead(u.statusCode ?? 502, u.headers)
      if (isStream) u.on('data', (c: Buffer) => { seen.body += c.toString('utf-8') })
      u.pipe(res)
    })
    // Поток записывается при запросе, а не при ответе: обрыв достаёт и
    // поток, который ещё ждёт заголовков от rivetd.
    if (isStream) {
      streams.push(seen)
      const entry = { up, res }
      open.add(entry)
      res.on('close', () => open.delete(entry))
    }
    up.on('error', () => res.destroy())
    req.pipe(up)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `http://localhost:${port}`,
    streams,
    cut: () => {
      blocked = true
      for (const s of open) { s.res.socket?.destroy(); s.up.destroy() }
      open.clear()
    },
    restore: () => { blocked = false },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

// Курсоры потока по порядку: первое сообщение без данных и события журнала.
function cursors(body: string): string[] {
  return [...body.matchAll(/^id: (\d+)$/gm)].map(m => m[1])
}

test('разрыв потока: браузер переподключается с курсором первого сообщения, сервер доигрывает пропущенное пачкой', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  await createProject(page, `Разрыв ${stamp}`)
  const pid = projectFromURL(page.url())
  await createEpic(page, `Разрыв ${stamp}`)
  const epicId = /\/epic\/([^/?]+)/.exec(page.url())![1]

  const proxy = await streamProxy()
  const ctx = await browser.newContext({ baseURL: proxy.origin })
  try {
    const p = await ctx.newPage()
    await login(p)
    const requests = countRequests(p)
    await p.goto(`/#/p/${pid}/epic/${epicId}`)
    await expect(p.getByRole('heading', { name: `Разрыв ${stamp}` })).toBeVisible()

    // Поток этого проекта (до перехода консоль могла открыть поток другого
    // проекта): подключение без курсора, первое сообщение — курсор без
    // данных. Разрыв — только когда поток проекта уже ответил.
    const ofProject = (s: StreamSeen) => new URL(s.url, proxy.origin).searchParams.get('project') === pid
    const firstOfProject = () => proxy.streams.filter(s => ofProject(s) && !s.lastEventId && cursors(s.body).length > 0).at(-1)
    await expect.poll(() => firstOfProject() !== undefined).toBe(true)
    const first = firstOfProject()!
    expect(first.body).toMatch(/^id: \d+\n\n/)

    // Потеря сети: соединение рвётся, новые не проходят. За разрыв в журнале
    // появляется пачка событий проекта.
    proxy.cut()
    const seenBefore = cursors(first.body)
    const r = await page.request.patch(`/api/v1/epics/${epicId}`, { data: { due_at: '2030-01-01T09:00:00Z' } })
    expect(r.ok()).toBeTruthy()
    let last = ''
    for (let i = 0; i < 60; i++) last = await addCancelled(page.request, epicId, `За разрыв ${i}`)

    // Сеть вернулась: браузер шлёт курсор, который видел последним (без
    // событий до разрыва это курсор первого сообщения), сервер доигрывает
    // всё записанное за разрыв, консоль склеивает перечитывания.
    requests.reset()
    const restored = Date.now()
    proxy.restore()
    const replayed = () => proxy.streams.find(s => ofProject(s) && s.lastEventId && s.body.includes(`"TaskID":"${last}"`))
    await expect.poll(() => replayed() !== undefined, { timeout: 30_000 }).toBe(true)
    const again = replayed()!
    // Браузер возвращается с курсором, который видел в потоке проекта: без
    // событий до разрыва это курсор первого сообщения без данных. Событие,
    // которое прокси успел принять, но не донёс до браузера в момент обрыва,
    // допускается: тогда курсор — одно из предыдущих.
    expect(seenBefore).toContain(again.lastEventId)
    if (seenBefore.length === 1) expect(again.lastEventId).toBe(seenBefore[0])
    expect(again.body).toMatch(new RegExp(`^id: ${again.lastEventId}\\n\\n`))
    expect(again.body).toContain('event: epic.due_changed')
    await expectNodeStatus(p, 'За разрыв 59', 'CANCELLED', 20_000)
    await p.waitForTimeout(3_000)
    // Перечитывание после подключения плюс склейка доигранной пачки: каждый
    // адрес не чаще раза в секунду, а не по запросу на событие.
    const seconds = Math.ceil((Date.now() - restored) / 1000)
    for (const [path, n] of requests.byPath()) {
      expect(n, `${path}: ${n} запросов за ${seconds} с после доигрывания 121 события`).toBeLessThanOrEqual(2 * seconds + 3)
    }
  } finally {
    await ctx.close()
    await proxy.close()
  }
})

test('после перехода в другой проект консоль перечитывает его: пауза по бюджету видна без перезагрузки', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  // Проект B: Epic с задачей и дневной бюджет токенов в один токен.
  const nameB = `Бюджет B ${stamp}`
  await createProject(page, nameB)
  const pidB = projectFromURL(page.url())
  const epicB = `Epic B ${stamp}`
  await createEpic(page, epicB)
  const epicId = /\/epic\/([^/?]+)/.exec(page.url())![1]
  await addTask(page, `Задача B ${stamp}`)
  let r = await page.request.put(`/api/v1/projects/${pidB}/policy`, { data: { daily_token_budget: 1 } })
  expect(r.ok()).toBeTruthy()

  // Консоль уходит в проект A: поток событий теперь его.
  await createProject(page, `Бюджет A ${stamp}`)
  await page.evaluate(() => { (window as unknown as { __same: boolean }).__same = true })

  // B запускается в обход консоли, первая стадия тратит токены, и
  // планирование B встаёт на паузу.
  r = await page.request.post(`/api/v1/epics/${epicId}/start`)
  expect(r.ok()).toBeTruthy()
  await expect.poll(async () => {
    const ps: Array<{ ID: string; budget?: { paused_until: string | null } }> = await (await page.request.get('/api/v1/projects')).json()
    const until = ps.find(x => x.ID === pidB)?.budget?.paused_until
    return !!until && Date.parse(until) > Date.now()
  }, { timeout: 90_000 }).toBe(true)

  // Переход в B внутри консоли: переключатель проекта и ссылка на Epic.
  await page.locator('#sidebar').getByLabel('Проект', { exact: true }).selectOption(pidB)
  await expect(page).toHaveURL(new RegExp(`#/p/${pidB}/epics$`))
  await page.getByRole('link', { name: epicB, exact: true }).click()
  await expect(page.getByRole('heading', { name: epicB })).toBeVisible()
  await expect(page.locator('.budget-pause', { hasText: 'Планирование на паузе' })).toBeVisible({ timeout: 15_000 })
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true)
})
