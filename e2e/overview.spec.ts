import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { addTask, createAssessedEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Обзор проекта для руководителя (add-project-lead-view): прогон Epic'а на
// агенте Rivet поверх fake-llm даёт прогресс, пропускную способность и
// расход, просроченная целевая дата переводит Epic в «под риском»,
// эскалация попадает в «Нужны решения», отчёт за период скачивается тем же
// текстом, что в предпросмотре.

async function openOverview(page: Page) {
  await page.locator('#sidebar').getByRole('button', { name: 'Обзор', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор проекта' })).toBeVisible()
}

// Merge задачи кнопкой из деталки: задача в REVIEW ждёт подтверждения человека.
async function mergeTask(page: Page, title: string) {
  await node(page, title).click()
  const drawer = page.locator('#drawer')
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
}

async function projectId(page: Page, name: string): Promise<string> {
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const id = projects.find((p) => p.Name === name)?.ID
  expect(id).toBeTruthy()
  return id!
}

interface SpendAmount {
  tokens_in: number | null
  tokens_out: number | null
  cost_usd: number | null
  partial_cost: boolean
}

interface MoneyOverview {
  summary: { spend: SpendAmount }
  money: { period: SpendAmount; by_model: Array<{ key: string; amount: SpendAmount }> }
}

async function readMoney(page: Page, pid: string): Promise<MoneyOverview> {
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const response = await page.request.get(`/api/v1/projects/${pid}/overview?${new URLSearchParams({ period: '7d', tz })}`)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function expectArchitectConnectionRemoved(page: Page) {
  const epicId = /#\/p\/[^/]+\/epic\/([^/?]+)/.exec(page.url())?.[1]
  expect(epicId).toBeTruthy()
  const assessment = await page.request.get(`/api/v1/epics/${epicId}/architecture-assessment`)
  expect(assessment.ok()).toBeTruthy()
  const connection = (await assessment.json()).assessment.connection_id
  expect(connection).toMatch(/^arch-e2e-/)
  const catalog = await page.request.get('/api/v1/system/connections')
  expect(catalog.ok()).toBeTruthy()
  expect((await catalog.json()).some((entry: { id: string }) => entry.id === connection)).toBe(false)
}

function modelSpend(data: MoneyOverview, model: string): SpendAmount {
  const row = data.money.by_model.find(entry => entry.key === model)
  expect(row, `persisted usage for ${model}`).toBeTruthy()
  return row!.amount
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Дата в поясе браузера (стенд и браузер на одной машине): YYYY-MM-DD.
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

test('обзор показывает прогресс, пропускную способность и расход, просроченная дата даёт риск', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  const epic = `Epic обзора ${stamp}`
  const first = `Обзор первая ${stamp}`
  const second = `Обзор вторая ${stamp}`

  await createProject(page, `Overview ${stamp}`)
  const pid = await projectId(page, `Overview ${stamp}`)
  await createAssessedEpic(page, epic)
  await expectArchitectConnectionRemoved(page)
  await addTask(page, first)
  await addTask(page, second)
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Обе задачи доходят до review, первая мержится. Epic в работе: одна
  // задача сделана, вторая ждёт подтверждения merge.
  await expectNodeStatus(page, first, 'REVIEW')
  await expectNodeStatus(page, second, 'REVIEW')
  await mergeTask(page, first)

  await openOverview(page)
  const data = await readMoney(page, pid)
  const architecture = modelSpend(data, 'fake-architect-assessment')
  // 10 input + 5 output at synthetic $1/M each, persisted before the
  // scoped connection is deleted. No current-catalog fallback can price it.
  expect(architecture.tokens_in).toBe(10)
  expect(architecture.tokens_out).toBe(5)
  expect(architecture.cost_usd).toBe(0.000015)
  expect(architecture.partial_cost).toBe(false)
  const coding = modelSpend(data, 'fake-small')
  expect(coding.cost_usd).toBeGreaterThan(0)
  expect(coding.partial_cost).toBe(false)
  expect(data.summary.spend.partial_cost).toBe(false)
  expect(data.money.period.partial_cost).toBe(false)
  expect(data.summary.spend.cost_usd).toBe(Number((coding.cost_usd! + 0.000015).toFixed(6)))
  expect(data.money.period.cost_usd).toBe(data.summary.spend.cost_usd)
  const stat = (label: string) => page.locator('.mini-stat', { hasText: label }).locator('.v')
  await expect(stat('Активные Epic’и')).toHaveText('1')
  await expect(stat('Задач завершено')).toHaveText('1')
  // Одна задача за 7 суток: 0,14 в сутки, на экране с одним знаком.
  await expect(stat('Пропускная способность')).toHaveText('0,1/сут')
  // У моделей стенда есть цены в каталоге (e2e-stand.sh), агент Rivet
  // считает стоимость сессий: расход в долларах, не ноль.
  await expect(stat('Расход за период')).toHaveText(/^\$\d+\.\d{2}$/)
  await expect(stat('Расход за период')).not.toHaveText('$0.00')

  const card = page.locator('.ov-epic', { hasText: epic })
  await expect(card).toHaveAttribute('data-risk', 'on_track')
  await expect(card.locator('.ov-risk')).toHaveText('в графике')
  await expect(card).toContainText('50%')
  await expect(card).toContainText('1 / 2 задач')
  await expect(card).toContainText('1 / 2 ед.')
  // В проекте меньше трёх задач за 14 суток: темп берётся по Epic'у.
  await expect(card).toContainText(/прогноз: .+ по Epic’у/)
  await expect(card).toContainText('срок: не задан')
  await expect(card.locator('.ov-reasons')).toHaveCount(0)

  const team = page.locator('.panel', { has: page.getByRole('heading', { name: 'Команда' }) })
  await expect(team).toContainText('1 задач · 1 ед.')
  await expect(team.locator('tr[data-role="developer"] td').nth(3)).not.toHaveText('0')
  const money = page.locator('.panel', { has: page.getByRole('heading', { name: 'Деньги' }) })
  await expect(money.locator('tr', { hasText: 'Разработчик' })).toContainText('$')
  // Все сессии проекта идут на модели агента по умолчанию.
  await expect(money.locator('tr', { hasText: 'fake-small' })).toContainText('$')

  // Целевая дата вчера: прогноз позже неё, Epic под риском с причиной late.
  const due = new Date(Date.now() - 24 * 3600_000)
  const dueInput = `${localDate(due)}T${pad(due.getHours())}:00`
  await card.getByRole('button', { name: 'изменить целевую дату' }).click()
  await card.getByLabel('целевая дата').fill(dueInput)
  await card.getByRole('button', { name: 'OK' }).click()
  await expect(card).toHaveAttribute('data-risk', 'at_risk')
  await expect(card.locator('.ov-risk')).toHaveText('под риском')
  const late = card.locator('li[data-reason="late"]')
  await expect(late).toHaveText(
    new RegExp(`^прогноз \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d позже целевой даты ${dueInput.replace('T', ' ')}$`))
  await expect(card.locator('.ov-reasons li')).toHaveCount(1)

  // Причина ведёт на дашборд Epic'а: это ссылка с адресом.
  await late.getByRole('link').click()
  await expect(page.getByRole('heading', { name: epic })).toBeVisible()
})

test('неполный расход сохраняет известную coding-сумму и обязательную пометку без architecture usage', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  const project = `Partial cost ${stamp}`
  const task = `Known coding ${stamp}`
  await createProject(page, project)
  const pid = await projectId(page, project)
  // The gate still runs normally. Only the provider's usage field is absent;
  // catalog prices remain known and coding uses the usual priced fake-small.
  await createAssessedEpic(page, `Partial Epic ${stamp}`, { reportedUsage: null })
  await expectArchitectConnectionRemoved(page)
  await addTask(page, task)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, task, 'REVIEW')
  await openOverview(page)

  const data = await readMoney(page, pid)
  expect(modelSpend(data, 'fake-architect-assessment').cost_usd).toBeNull()
  const coding = modelSpend(data, 'fake-small')
  expect(coding.cost_usd).toBeGreaterThan(0)
  expect(coding.partial_cost).toBe(false)
  expect(data.summary.spend.cost_usd).toBe(coding.cost_usd)
  expect(data.summary.spend.partial_cost).toBe(true)
  expect(data.money.period.cost_usd).toBe(coding.cost_usd)
  expect(data.money.period.partial_cost).toBe(true)
  const spend = page.locator('.mini-stat', { hasText: 'Расход за период' }).locator('.v')
  await expect(spend).toHaveText(/^\$\d+\.\d{2}\*$/)
  await expect(spend).not.toHaveText('$0.00*')
  await expect(spend.locator('.ov-warn')).toHaveText('*')
  await expect(page.locator('[data-overview-money]')).toContainText(
    '* часть записей без стоимости: сумма неполная.'
  )
})

test('эскалация по задаче попадает в «Нужны решения», Epic ждёт человека, пункт открывает задачу', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const epic = `Epic решений ${stamp}`
  const taskTitle = `Решение ${stamp}`

  await createProject(page, `Decisions ${stamp}`)
  await createAssessedEpic(page, epic)
  await addTask(page, taskTitle, 'Сценарий эскалации [e2e-block]: без ответа человека не продолжать.')
  await page.getByRole('button', { name: 'Запустить' }).click()
  // Агент по метке [e2e-block] задаёт вопрос человеку, по задаче
  // открывается эскалация.
  await expect(page.locator('.att-card', { hasText: 'BLOCKED' })).toBeVisible({ timeout: 90_000 })

  await openOverview(page)
  const panel = page.locator('.panel', { has: page.getByRole('heading', { name: 'Нужны решения' }) })
  await expect(panel.locator('.chip[data-kind="escalation"] .n')).toHaveText('1')
  await expect(page.locator('.mini-stat', { hasText: 'Открытых решений' }).locator('.v')).toHaveText('1')
  const item = panel.locator('.att-card[data-kind="escalation"]')
  await expect(item).toHaveCount(1)
  await expect(item.locator('.att-reason')).toHaveText('BLOCKED')
  // Номер задачи сквозной по установке, поэтому сверяется название.
  await expect(item.locator('.att-msg')).toHaveText(new RegExp(`^Эскалация по задаче #\\d+ ${taskTitle}$`))

  const card = page.locator('.ov-epic', { hasText: epic })
  await expect(card).toHaveAttribute('data-risk', 'needs_human')
  await expect(card.locator('.ov-risk')).toHaveText('нужен человек')
  await expect(card.locator('li[data-reason="escalation"]')).toHaveText(/^эскалация по задаче #\d+: BLOCKED$/)

  // Один клик по пункту открывает деталку задачи на дашборде Epic'а.
  await item.click()
  await expect(page.getByRole('heading', { name: epic })).toBeVisible()
  const drawer = page.locator('#drawer')
  await expect(drawer).toContainText(taskTitle)
  await expect(drawer.getByText('вопрос от e2e-агента').first()).toBeVisible()
})

test('отчёт за период скачивается с семью разделами и совпадает с предпросмотром', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const project = `Report ${stamp}`
  const epic = `Epic отчёта ${stamp}`
  const taskTitle = `Отчёт ${stamp}`

  await createProject(page, project)
  const pid = await projectId(page, project)
  await createAssessedEpic(page, epic)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  const beforeMerge = new Date()
  await mergeTask(page, taskTitle)

  await openOverview(page)
  // По умолчанию последние 7 суток до начала текущей минуты: файл назван
  // проектом и датами периода в поясе браузера, конец включительно.
  const names = (now: Date) => {
    const to = Math.floor(now.getTime() / 60_000) * 60_000
    return `rivet-report-${stamp}-${localDate(new Date(to - 7 * 24 * 3600_000))}-${localDate(new Date(to - 1))}.md`
  }
  const before = names(new Date())
  await page.getByRole('button', { name: 'Отчёт', exact: true }).click()
  const dlg = page.getByRole('dialog', { name: 'Отчёт' })
  const preview = dlg.locator('pre[data-report]')
  await expect(preview).toContainText(`# Отчёт по проекту «${project}»`)
  expect([before, names(new Date())]).toContain(await dlg.locator('.mono.muted').textContent())

  // Период по умолчанию кончается на начале текущей минуты, а задача
  // завершилась только что. Свои даты со дня до merge по сегодня кончаются
  // в будущем: отчёт строится на момент запроса и включает её.
  const from = localDate(beforeMerge)
  const today = localDate(new Date())
  await dlg.getByRole('button', { name: 'свои даты' }).click()
  await dlg.getByLabel('с', { exact: true }).fill(from)
  await dlg.getByLabel('по', { exact: true }).fill(today)
  const todayName = `rivet-report-${stamp}-${from}-${today}.md`
  await expect(dlg).toContainText(todayName)
  await expect(preview).toContainText('период ещё идёт')
  const text = (await preview.textContent()) ?? ''
  expect(text.split('\n').filter((l) => l.startsWith('## '))).toEqual([
    '## 1. Итог периода',
    "## 2. Epic'и",
    '## 3. Пропускная способность и качество',
    '## 4. Деньги',
    '## 5. Эскалации и решения людей',
    '## 6. Поставки',
    '## 7. Риски на конец периода',
  ])
  // Завершённый Epic есть в разделе Epic'ов, задача в итоге периода.
  expect(text).toContain(`| ${epic} | завершён |`)
  expect(text).toContain("- Завершено задач: 1 (1 ед. оценки), Epic'ов: 1.")

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dlg.getByRole('button', { name: 'Скачать' }).click(),
  ])
  expect(download.suggestedFilename()).toBe(todayName)
  expect(await readFile(await download.path(), 'utf-8')).toBe(text)

  // Прошлая неделя: с понедельника по воскресенье, файл снова совпадает
  // с предпросмотром. Работы проекта в ней нет.
  await dlg.getByRole('button', { name: 'прошлая неделя' }).click()
  const monday = new Date()
  monday.setHours(0, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 7)
  const sunday = new Date(monday)
  sunday.setDate(sunday.getDate() + 6)
  const weekName = `rivet-report-${stamp}-${localDate(monday)}-${localDate(sunday)}.md`
  await expect(dlg).toContainText(weekName)
  const weekText = (await preview.textContent()) ?? ''
  expect(weekText).toContain('- Завершено задач: 0')
  const [weekDownload] = await Promise.all([
    page.waitForEvent('download'),
    dlg.getByRole('button', { name: 'Скачать' }).click(),
  ])
  expect(weekDownload.suggestedFilename()).toBe(weekName)
  expect(await readFile(await weekDownload.path(), 'utf-8')).toBe(weekText)
  // Консоль показывает текст сервера как есть: период закрыт, ответ API за
  // те же границы и пояс побайтно тот же.
  const nextMonday = new Date(monday)
  nextMonday.setDate(nextMonday.getDate() + 7)
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const q = new URLSearchParams({ from: monday.toISOString(), to: nextMonday.toISOString(), tz })
  const api = await page.request.get(`/api/v1/projects/${pid}/report?${q}`)
  expect(api.ok()).toBeTruthy()
  expect(await api.text()).toBe(weekText)
})
