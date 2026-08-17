import { expect, type Page } from '@playwright/test'

// Токен стенда намеренно длинный: короткий бэкенд не показывает вовсе,
// и проверка «токен не виден в интерфейсе» стала бы бессмысленной.
export const E2E_TOKEN = 'ghp_e2e_token_0123456789'

// Хелперы ходят через UI, как человек: никаких прямых вызовов API.

// Вход стендовым bootstrap-админом (rivetd поднят e2e-стендом с
// RIVET_ADMIN_LOGIN/RIVET_ADMIN_PASSWORD). Консоль без сессии показывает
// экран логина на любом адресе.
export async function login(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByPlaceholder('Логин').fill(process.env.E2E_ADMIN_LOGIN ?? 'e2e-admin')
  await page.getByPlaceholder('Пароль').fill(process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password')
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()
}

// Проект создаётся пошаговым мастером: репозиторий (с проверкой доступа),
// проверки, подтверждение. Стенд работает на fake-хостинге, поэтому
// проверка проходит с любым токеном.
export async function createProject(page: Page, name: string): Promise<void> {
  await page.goto('/#/projects')
  await page.getByRole('button', { name: 'Новый проект' }).click()
  await page.getByPlaceholder('Название проекта').fill(name)
  await page.getByPlaceholder(/URL репозитория/).fill('https://fake.local/e2e/demo')
  await page.getByPlaceholder('Токен доступа к хостингу').fill(E2E_TOKEN)
  await page.getByRole('button', { name: 'Проверить доступ' }).click()
  await expect(page.getByRole('button', { name: 'Далее' })).toBeEnabled()
  await page.getByRole('button', { name: 'Далее' }).click()   // → проверки
  await page.getByRole('button', { name: 'Далее' }).click()   // → подтверждение
  await page.getByRole('button', { name: 'Создать проект' }).click()
  // Создание делает проект текущим и открывает список его Epic'ов.
  await expect(page.getByRole('button', { name: 'Новый Epic' })).toBeVisible()
}

// Страница настроек текущего проекта.
export async function openProjectSettings(page: Page, name: string): Promise<void> {
  await page.goto('/#/projects')
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Настройки' }).click()
  await expect(page.getByRole('heading', { name: 'Настройки проекта' })).toBeVisible()
}

export async function createEpic(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Новый Epic' }).click()
  await page.getByPlaceholder('Название').fill(title)
  await page.getByPlaceholder(/Цель/).fill('e2e-прогон')
  await page.getByRole('button', { name: 'Создать' }).click()
  // Создание ведёт на дашборд Epic.
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

export async function addTask(page: Page, title: string, description = ''): Promise<void> {
  await page.getByRole('button', { name: 'Добавить задачу' }).click()
  await page.getByPlaceholder('Название').fill(title)
  if (description) await page.getByPlaceholder(/Описание/).fill(description)
  await page.getByPlaceholder(/Acceptance criteria/).fill('e2e-результат записан')
  await page.getByRole('button', { name: 'Создать' }).click()
  await expect(node(page, title)).toBeVisible()
}

// Узел DAG по названию задачи.
export function node(page: Page, title: string) {
  return page.locator('.node', { hasText: title })
}

export async function expectNodeStatus(page: Page, title: string, status: string, timeout = 90_000) {
  await expect(node(page, title).locator('.st')).toHaveText(status, { timeout })
}
