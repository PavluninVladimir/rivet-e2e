import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { login } from './helpers'
import { SERVICE_DIR, STAND, issueRunnerToken } from './stand'

// Привязка токена регистрации к runner'ам (add-runner-identity, спеки
// backend/runners «Токены регистрации runner'ов» и clients/web «Привязка
// токенов и отказы на вкладке «Runner'ы»»). Регистрацию делает тестовый
// gRPC-клиент стенда (rivet-service/scripts/e2e-register): настоящий
// runner с чужим идентификатором просто завершился бы, а здесь нужен ответ
// control plane. Сторонний агент external-cli в запросе отделяет «идентичность
// принята» (дальше отказ по агенту, FailedPrecondition) от отказа по
// идентичности (PermissionDenied): runner'ов в стенде не прибавляется.

interface Registered { accepted: boolean; code: string; message: string }

async function register(page: Page, tokenFile: string, id: string): Promise<Registered> {
  const status: { protocol_version: string } = await (await page.request.get('/api/v1/system/status')).json()
  const { stdout } = await promisify(execFile)('go', ['run', './scripts/e2e-register',
    '-addr', `localhost:${STAND.grpcPort}`, '-token-file', tokenFile,
    '-id', id, '-agent', 'external-cli', '-protocol', status.protocol_version,
  ], { cwd: SERVICE_DIR, timeout: 200_000 })
  return JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
}

function tokenRow(page: Page, name: string) {
  return page.locator('.tbl tbody tr', { has: page.getByRole('cell', { name, exact: true }) })
}

test('токен выпускается в консоли для runner’ов хоста, чужой идентификатор получает отказ, видный администратору', async ({ page }) => {
  // go run компилирует клиент: на холодном кеше это дольше обычного шага.
  test.setTimeout(240_000)
  await login(page)
  const stamp = Date.now()
  const name = `host-${stamp}`
  const [a, b, intruder] = [`ri-a-${stamp}`, `ri-b-${stamp}`, `ri-c-${stamp}`]

  await page.goto('/#/app-management/runners')
  await page.getByLabel('Имя', { exact: true }).fill(name)
  // Список, вставленный через запятую, разбирается на отдельные теги.
  const runners = page.getByLabel(/Runner’ы/)
  await runners.fill(`${a}, ${b}`)
  await runners.press('Enter')
  await expect(page.locator('.f-tags .f-tag')).toHaveText([`${a}✕`, `${b}✕`])
  // Команда запуска подставляет первый runner из списка.
  await expect(page.locator('pre', { hasText: 'rivet-runner' })).toContainText(`-id ${a}`)
  await page.getByRole('button', { name: 'Создать' }).click()

  // Секрет показывается один раз; в списке у токена оба runner'а «выпущен для».
  const secretBox = page.locator('.dw-sec', { has: page.getByRole('heading', { name: `Токен регистрации «${name}»` }) })
  const secret = (await secretBox.locator('.mono').first().textContent())?.trim() ?? ''
  expect(secret).toMatch(/^rrt_/)
  const row = tokenRow(page, name)
  await expect(row).toContainText('выпущен для')
  await expect(row.locator('.f-tag')).toHaveText([a, b])

  const tokenFile = path.join(STAND.dir, `token-${name}`)
  await writeFile(tokenFile, secret + '\n', { mode: 0o600 })

  // Свой runner проходит идентичность (дальше отказ по агенту), чужой получает
  // отказ по идентичности без списка runner'ов токена.
  expect(await register(page, tokenFile, a)).toMatchObject({ accepted: false, code: 'FailedPrecondition' })
  const denied = await register(page, tokenFile, intruder)
  expect(denied).toMatchObject({ accepted: false, code: 'PermissionDenied' })
  expect(denied.message).toContain(`не выпущен для runner'а ${intruder}`)
  expect(denied.message).not.toContain(a)

  // Отказ виден на вкладке «Runner'ы» среди последних и в «Аудите».
  await page.reload()
  const rejections = page.locator('.dw-sec', { has: page.getByRole('heading', { name: 'Последние отказы регистрации' }) })
  await expect(rejections.locator('.act-row', { hasText: intruder })).toContainText('токен выпущен для других runner')
  await expect(rejections.locator('.act-row', { hasText: intruder })).toContainText(`токен «${name}»`)
  await rejections.getByRole('button', { name: 'Все в «Аудите»' }).click()
  await expect(page).toHaveURL(/#\/app-management\/audit/)
  await page.getByLabel('тип события').selectOption('runner.rejected')
  await expect(page.locator('.act-row', { hasText: intruder }).filter({ hasText: 'runner.rejected' })).toContainText('отклонена')
  const list: Array<{ ID: string }> = await (await page.request.get('/api/v1/runners')).json()
  expect(list.map((r) => r.ID)).not.toContain(intruder)
})

test('токен без списка привязывается к первому runner’у', async ({ page }) => {
  test.setTimeout(240_000)
  await login(page)
  const stamp = Date.now()
  const name = `free-${stamp}`
  const [first, second] = [`ri-first-${stamp}`, `ri-second-${stamp}`]
  const tokenFile = await issueRunnerToken(page, name, [])

  await page.goto('/#/app-management/runners')
  await expect(tokenRow(page, name)).toContainText('привяжется к первому зарегистрированному runner')

  expect(await register(page, tokenFile, first)).toMatchObject({ code: 'FailedPrecondition' })
  expect(await register(page, tokenFile, second)).toMatchObject({ code: 'PermissionDenied' })
  await page.reload()
  const row = tokenRow(page, name)
  await expect(row).toContainText('при первой регистрации')
  await expect(row.locator('.f-tag')).toHaveText([first])
})

test('слишком длинный идентификатор runner’а: ошибка у поля, токен не создаётся', async ({ page }) => {
  await login(page)
  const name = `bad-${Date.now()}`
  await page.goto('/#/app-management/runners')
  await page.getByLabel('Имя', { exact: true }).fill(name)
  const runners = page.getByLabel(/Runner’ы/)
  // Пробелы и запятые делят ввод на теги, поэтому недопустимый
  // идентификатор здесь длиннее предела в 128 символов.
  await runners.fill('r'.repeat(129))
  await runners.press('Enter')
  await page.getByRole('button', { name: 'Создать' }).click()
  await expect(page.locator('.f-field', { has: page.locator('.f-tags') }).locator('.f-error')).toContainText('длиннее 128 символов')
  await expect(page.getByRole('heading', { name: `Токен регистрации «${name}»` })).toHaveCount(0)
  await expect(tokenRow(page, name)).toHaveCount(0)
})
