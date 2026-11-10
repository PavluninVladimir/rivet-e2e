import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { addTask, createEpic, expectNodeStatus, login, node, openProjectSettings, projectFromURL } from './helpers'
import { STAND } from './stand'

// Отозванные учётные данные хостинга (change fix-credential-state, спека
// scm-integration «Учётные данные хостинга»): fake-хостинг стенда отвечает
// 401 на операции с токенами из файла RIVET_FAKE_SCM_REVOKED. Задача,
// прошедшая проверки, ждёт без расхода попытки, подключение нерабочее с
// причиной, в «Требует внимания» одна эскалация проекта. Отозванным
// токеном его не заменить, а новым — можно, хотя старый так и остался
// отозванным: задача продолжает конвейер.

const REVOKED = path.join(STAND.dir, 'scm-revoked')

test.afterEach(async () => {
  await rm(REVOKED, { force: true })
})

test('отозванный токен останавливает задачу перед PR, новый токен её продолжает', async ({ page }) => {
  test.setTimeout(240_000)
  await login(page)
  const stamp = Date.now()
  const name = `Токен ${stamp}`
  const taskTitle = `Отзыв токена ${stamp}`
  // Свои токены проекта: отзыв не задевает проекты других сценариев.
  const token = `ghp_e2e_creds_${stamp}`
  const otherRevoked = `ghp_e2e_creds_other_${stamp}`
  const fresh = `ghp_e2e_creds_fresh_${stamp}`

  await page.goto('/#/projects')
  await page.getByRole('button', { name: 'Новый проект' }).click()
  await page.getByPlaceholder('Название проекта').fill(name)
  await page.getByPlaceholder(/URL репозитория/).fill('https://fake.local/e2e/demo')
  await page.getByPlaceholder('Токен доступа к хостингу').fill(token)
  await page.getByRole('button', { name: 'Проверить доступ' }).click()
  await page.getByRole('button', { name: 'Далее' }).click()
  await page.getByRole('button', { name: 'Далее' }).click()
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await expect(page.getByRole('button', { name: 'Новый Epic' })).toBeVisible()
  const pid = projectFromURL(page.url())

  // Первый снимок архитектуры читается со старта проекта: дождаться его,
  // чтобы отзыв увидела именно операция задачи.
  await page.goto(`/#/p/${pid}/architecture`)
  await expect(page.locator('.arch-strip, .arch-empty').first()).toBeVisible()
  await expect(page.getByText('Снимок архитектуры ещё строится')).toHaveCount(0)

  await page.goto(`/#/p/${pid}/epics`)
  await createEpic(page, `Epic токен ${stamp}`)
  const epicURL = page.url()
  await addTask(page, taskTitle)
  await writeFile(REVOKED, `${token}\n${otherRevoked}\n`)
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Реализация и проверки проходят (git стенда без токена), PR не
  // открывается: задача стоит на проверках с причиной ожидания и не падает.
  await expectNodeStatus(page, taskTitle, 'TESTING')
  await openProjectSettings(page, name)
  await expect(page.locator('.kv', { hasText: 'подключение' }).first()).toContainText('подключение не работает', { timeout: 90_000 })
  await expect(page.getByTestId('repo-state-reason')).toContainText('токен не принят')

  // Одна эскалация уровня проекта ведёт к замене токена.
  await page.goto(`/#/p/${pid}/tasks`)
  const card = page.locator('.att-card', { hasText: 'SCM_CREDENTIALS' })
  await expect(card).toHaveCount(1)
  await expect(page.locator('.att-card')).toHaveCount(1)
  await card.click()
  await expect(page.getByRole('heading', { name: 'Репозиторий' })).toBeVisible()

  // Отозванным токеном подключение не заменить.
  await page.getByPlaceholder('Новый токен доступа').fill(otherRevoked)
  await page.getByRole('button', { name: 'Заменить токен' }).click()
  await expect(page.locator('.page')).toContainText('токен не принят')
  await expect(page.locator('.kv', { hasText: 'подключение' }).first()).toContainText('подключение не работает')

  // Новый токен: старый так и остался отозванным, но подключение рабочее,
  // эскалация снята.
  await page.getByPlaceholder('Новый токен доступа').fill(fresh)
  await page.getByRole('button', { name: 'Заменить токен' }).click()
  await expect(page.locator('.page')).toContainText('учётные данные заменены')
  await expect(page.locator('.kv', { hasText: 'подключение' }).first()).toContainText('подключение работает')
  await expect(page.getByTestId('repo-state-reason')).toHaveCount(0)

  // Задача продолжает конвейер с пройденных проверок: PR открыт, review,
  // merge кнопкой.
  await page.goto(`/#/p/${pid}/tasks`)
  await expect(page.locator('.att-card', { hasText: 'SCM_CREDENTIALS' })).toHaveCount(0)
  await page.goto(epicURL)
  await expectNodeStatus(page, taskTitle, 'REVIEW', 120_000)
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer).toContainText('PR откроется после восстановления подключения')
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})
