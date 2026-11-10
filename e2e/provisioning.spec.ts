import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createProject, login, openProjectSettings, openSection } from './helpers'
import { STAND } from './stand'

// Хост окружения от провайдера инфраструктуры (add-environment-provisioning).
// RUVDS на стенде: fake (cmd/fake-ruvds), deploy-runner ходит на «сервер»
// через подмену ssh, а локальный хост проверяется подменой docker
// (rivet-service/scripts/e2e-bin). Настоящих серверов, токенов и денег нет.

// Заведомо фальшивые значения: fake RUVDS принимает любой непустой токен,
// слово lowbalance даёт баланс 10 ₽.
const FAKE_TOKEN = 'fake-ruvds-e2e-token'
const LOW_BALANCE_TOKEN = 'fake-ruvds-lowbalance-e2e-token'
const FAKE_PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE2eFakeDeployRunnerKeyForStand deploy@e2e'

type FakeCalls = { creates: number; deletes: number; quotes: number; servers: number }

async function ruvdsCalls(page: Page): Promise<FakeCalls> {
  const res = await page.request.get(`http://127.0.0.1:${STAND.ruvdsPort}/__fake/calls`)
  expect(res.ok()).toBeTruthy()
  return await res.json() as FakeCalls
}

// Подключение RUVDS вводит администратор в «Управление → Подключения».
async function connectRUVDS(page: Page, id: string, token: string): Promise<void> {
  await page.goto('/#/app-management/connections')
  const section = page.locator('[data-infra-section]')
  await expect(section).toBeVisible()
  await section.getByRole('button', { name: 'Подключить RUVDS' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('input[name="infra.id"]').fill(id)
  await dialog.locator('input[name="infra.name"]').fill(`RUVDS ${id}`)
  await dialog.locator('input[name="infra.token"]').fill(token)
  await dialog.getByRole('button', { name: 'Создать и проверить' }).click()
  const card = page.locator(`[data-infra-connection="${id}"]`)
  await expect(card).toHaveAttribute('data-state', 'ok')
  // Токен после сохранения не показывается, только префикс.
  await expect(page.locator('body')).not.toContainText(token)
}

// Окружение «Linux-хост» с хостом от провайдера (RUVDS или локально).
async function createProvisionedEnv(page: Page, project: string, name: string, source: string,
  deployCmd: string, verifyCmd: string): Promise<void> {
  await openProjectSettings(page, project, 'Окружения')
  await page.getByRole('button', { name: 'Новое окружение' }).click()
  const modal = page.locator('.modal')
  await page.getByPlaceholder(/Имя \(staging/).fill(name)
  await modal.locator('select[name="host_source"]').selectOption(source)
  if (source.startsWith('ruvds:')) {
    const ruvds = modal.locator('fieldset[data-provision="ruvds"]')
    // Справочник провайдера загружен: селекты доступны и заполнены.
    await expect(ruvds.locator('select[name="provision.os_id"]')).toBeEnabled()
    await expect(ruvds.locator('select[name="provision.os_id"]')).toContainText('Ubuntu 24.04')
    await ruvds.locator('select[name="provision.datacenter"]').selectOption('1')
    await ruvds.locator('select[name="provision.tariff_id"]').selectOption('14')
    await ruvds.locator('select[name="provision.os_id"]').selectOption('52')
    await ruvds.locator('select[name="provision.drive_tariff_id"]').selectOption('1')
    await ruvds.locator('textarea[name="provision.ssh_public_key"]').fill(FAKE_PUBKEY)
  }
  await page.getByPlaceholder(/Команда доставки/).fill(deployCmd)
  await page.getByPlaceholder(/Команда проверки/).fill(verifyCmd)
  await modal.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.locator('.env-card', { hasText: name })).toBeVisible()
}

function hostBlock(page: Page, env: string) {
  return page.locator('.env-card', { hasText: env }).locator('.env-host')
}

test('RUVDS: решение с ценой, подтверждение, асинхронное создание, публикация и удаление по подтверждению', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const conn = `ruvds-${stamp}`
  await connectRUVDS(page, conn, FAKE_TOKEN)
  await expect(page.locator(`[data-infra-connection="${conn}"] .infra-balance`)).toContainText(/\d[\d\s]*₽/)

  const project = `Hosting ${stamp}`
  await createProject(page, project)
  const before = await ruvdsCalls(page)
  await createProvisionedEnv(page, project, 'staging', `ruvds:${conn}`,
    'echo "доставка $RIVET_VERSION на $RIVET_HOST_ADDRESS проект $COMPOSE_PROJECT_NAME"', 'true')

  // Цена посчитана, сервер не создан: решение ждёт владельца проекта.
  const host = hostBlock(page, 'staging')
  await expect(host).toHaveAttribute('data-host-state', 'awaiting_approval', { timeout: 30_000 })
  const decision = host.locator('.env-host-decision[data-decision="create"]')
  await expect(decision).toContainText(/658/)
  await expect(decision).toContainText('1 месяц')
  await expect(decision).toContainText('Ubuntu 24.04')
  let calls = await ruvdsCalls(page)
  expect(calls.creates).toBe(before.creates)
  expect(calls.quotes).toBeGreaterThan(before.quotes)

  // Решение видно в «Требует внимания» и ведёт к окружениям.
  await openSection(page, 'Задачи')
  const att = page.locator('.att-card', { hasText: 'HOST_CREATE' })
  await expect(att).toBeVisible()
  await att.click()
  await expect(page.getByRole('heading', { name: 'Настройки проекта' })).toBeVisible()

  // Подтверждение: создание асинхронное, затем bootstrap по SSH и готовность.
  await host.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect(host).toHaveAttribute('data-host-state', 'ready', { timeout: 90_000 })
  await expect(host.locator('.env-host-address')).toContainText('10.77.')
  await expect(host.locator('.env-host-paid')).toBeVisible()
  calls = await ruvdsCalls(page)
  expect(calls.creates).toBe(before.creates + 1)

  // Публикация идёт на сервер (подмена ssh стенда) с переменными хоста.
  const card = page.locator('.env-card', { hasText: 'staging' })
  await card.getByRole('button', { name: 'Опубликовать' }).click()
  await expect(card.locator('.sess-stage')).toHaveText('DONE', { timeout: 60_000 })
  await card.getByRole('button', { name: 'История' }).click()
  await card.locator('.sess-row').first().click()
  await expect(card.locator('.term')).toContainText(/доставка main на 10\.77\.\S+ проект rivet-/)
  const ssh = await readFile(path.join(STAND.dir, 'ssh.log'), 'utf-8')
  expect(ssh).toContain('StrictHostKeyChecking=yes')

  // Удаление: запрос, решение с предупреждением, без подтверждения провайдер не трогается.
  await host.getByRole('button', { name: 'Удалить хост' }).click()
  await expect(host).toHaveAttribute('data-host-state', 'delete_requested')
  const del = host.locator('.env-host-decision[data-decision="delete"]')
  await expect(del).toContainText('Удаление необратимо')
  await page.waitForTimeout(3_000)
  expect((await ruvdsCalls(page)).deletes).toBe(before.deletes)
  await del.getByRole('button', { name: 'Подтвердить удаление' }).click()
  await expect(host).toHaveAttribute('data-host-state', 'deleted', { timeout: 60_000 })
  calls = await ruvdsCalls(page)
  expect(calls.deletes).toBe(before.deletes + 1)
  await expect(host.getByRole('button', { name: 'Запросить снова' })).toBeVisible()
})

test('RUVDS: нехватка баланса, создание не отправлено, эскалация с причиной', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const conn = `poor-${stamp}`
  await connectRUVDS(page, conn, LOW_BALANCE_TOKEN)
  const project = `Poor ${stamp}`
  await createProject(page, project)
  await createProvisionedEnv(page, project, 'prod', `ruvds:${conn}`, 'echo deploy', 'true')
  const host = hostBlock(page, 'prod')
  await expect(host).toHaveAttribute('data-host-state', 'awaiting_approval', { timeout: 30_000 })
  // Баланс меньше цены виден до решения.
  await expect(host.locator('.env-host-decision .env-host-balance')).toContainText(/10\s?₽/)
  const before = await ruvdsCalls(page)
  await host.getByRole('button', { name: 'Подтвердить', exact: true }).click()
  await expect(host).toHaveAttribute('data-host-state', 'failed', { timeout: 30_000 })
  await expect(host.locator('.env-host-detail')).toContainText('недостаточно средств')
  expect((await ruvdsCalls(page)).creates).toBe(before.creates)
  await openSection(page, 'Задачи')
  await expect(page.locator('.att-card', { hasText: 'HOST_FAILED' })).toBeVisible()
})

test('локальный хост: проверка docker compose, публикация в своём compose-проекте, снятие с томами по решению', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const project = `Local ${stamp}`
  await createProject(page, project)
  await createProvisionedEnv(page, project, 'dev', 'local', 'docker compose up -d', 'docker compose ps')
  const host = hostBlock(page, 'dev')
  await expect(host).toHaveAttribute('data-host-state', 'ready', { timeout: 60_000 })
  const compose = (await host.locator('.env-host-compose').innerText()).match(/rivet-[0-9a-f]+-[0-9a-f]+/)?.[0]
  const port = (await host.locator('.env-host-port').innerText()).match(/\d{4,5}/)?.[0]
  expect(compose).toBeTruthy()
  expect(port).toBeTruthy()

  const card = page.locator('.env-card', { hasText: 'dev' })
  await card.getByRole('button', { name: 'Опубликовать' }).click()
  await expect(card.locator('.sess-stage')).toHaveText('DONE', { timeout: 60_000 })
  const dockerLog = () => readFile(path.join(STAND.dir, 'docker.log'), 'utf-8')
  let log = await dockerLog()
  expect(log).toContain(`project=${compose} port=${port} args=compose version`)
  expect(log).toContain(`project=${compose} port=${port} args=compose up -d`)

  // Снятие с томами только после подтверждения решения.
  await host.getByLabel('удалить тома с данными').check()
  await host.getByRole('button', { name: 'Удалить хост' }).click()
  await expect(host).toHaveAttribute('data-host-state', 'delete_requested')
  log = await dockerLog()
  expect(log).not.toContain(`project=${compose} port=${port} args=compose -p ${compose} down`)
  await host.getByRole('button', { name: 'Подтвердить удаление' }).click()
  await expect(host).toHaveAttribute('data-host-state', 'deleted', { timeout: 60_000 })
  log = await dockerLog()
  expect(log).toContain(`args=compose -p ${compose} down --remove-orphans --volumes`)
})
