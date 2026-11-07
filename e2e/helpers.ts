import { expect, type Page } from '@playwright/test'
import { LLM_URL, STAND } from './stand'

// Токен стенда намеренно длинный: короткий бэкенд не показывает вовсе,
// и проверка «токен не виден в интерфейсе» стала бы бессмысленной.
export const E2E_TOKEN = 'ghp_e2e_token_0123456789'

// Порт API стенда: единственный источник портов — e2e/stand.ts.
export const HTTP_PORT = STAND.httpPort

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
// проверка проходит с любым токеном. repo — репозиторий стенда: e2e/demo
// (пустой) или e2e/arch (README и описание архитектуры демо-CRM, снимок
// архитектуры читается из настоящей версии).
export async function createProject(page: Page, name: string, repo = 'e2e/demo'): Promise<void> {
  await page.goto('/#/projects')
  await page.getByRole('button', { name: 'Новый проект' }).click()
  await page.getByPlaceholder('Название проекта').fill(name)
  await page.getByPlaceholder(/URL репозитория/).fill(`https://fake.local/${repo}`)
  await page.getByPlaceholder('Токен доступа к хостингу').fill(E2E_TOKEN)
  await page.getByRole('button', { name: 'Проверить доступ' }).click()
  await expect(page.getByRole('button', { name: 'Далее' })).toBeEnabled()
  await page.getByRole('button', { name: 'Далее' }).click()   // → проверки
  await page.getByRole('button', { name: 'Далее' }).click()   // → подтверждение
  await page.getByRole('button', { name: 'Создать проект' }).click()
  // Создание входит в проект и открывает список его Epic'ов.
  await expect(page.getByRole('button', { name: 'Новый Epic' })).toBeVisible()
}

// Навигация (add-project-navigation): разделы проекта видны только в
// проекте, адрес экрана проекта — #/p/<проект>/<раздел>.

// Вход в проект из списка «Проекты»: открывается обзор проекта.
export async function openProject(page: Page, name: string): Promise<void> {
  await page.goto('/#/projects')
  await page.getByRole('link', { name, exact: true }).click()
  await expect(projectSections(page)).toBeVisible()
}

// Разделы текущего проекта в боковой панели.
export function projectSections(page: Page) {
  return page.locator('#sidebar').getByRole('navigation', { name: 'Разделы проекта' })
}

// Пункт раздела по подписи: у «Задач» к подписи добавляется счётчик эскалаций.
export function sectionItem(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return projectSections(page).getByRole('button', { name: new RegExp(`^${escaped}\\s*\\d*$`) })
}

// Переход к разделу текущего проекта через боковую панель.
export async function openSection(page: Page, label: string): Promise<void> {
  await sectionItem(page, label).click()
}

// Проект текущей страницы из адреса.
export function projectFromURL(url: string): string {
  const id = /#\/p\/([^/?]+)/.exec(url)?.[1]
  if (!id) throw new Error(`в адресе нет проекта: ${url}`)
  return decodeURIComponent(id)
}

// Страница настроек проекта: открывается кнопкой из списка, затем нужная
// вкладка (Общее · Участники · Процесс · Политики · Окружения).
export type SettingsTab = 'Общее' | 'Участники' | 'Процесс' | 'Политики' | 'Окружения'
export async function openProjectSettings(page: Page, name: string, tab: SettingsTab = 'Общее'): Promise<void> {
  await page.goto('/#/projects')
  await page.locator('tr', { hasText: name }).getByRole('button', { name: 'Настройки' }).click()
  await expect(page.getByRole('heading', { name: 'Настройки проекта' })).toBeVisible()
  if (tab !== 'Общее') await page.locator('.tabs').getByRole('button', { name: tab, exact: true }).click()
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

// Исследование (add-product-discovery): общие шаги сценариев исследования
// и цикла разработки. withFakeModel — настройка стенда через API, а не
// шаг пользователя: модель Аналитику даёт администратор установки.

// Модель для Аналитика и Тимлида: подключение к fake-llm и модель
// декомпозиции из него. Своей модели у Аналитика Веры и у шаблона роли нет,
// поэтому анализ идёт на модели Тимлида. После сценария модель
// декомпозиции возвращается к прежней, подключение удаляется: остальные
// сценарии ждут стенд без модели.
export async function withFakeModel(page: Page, stamp: number, body: () => Promise<void>) {
  const conn = `disc${stamp}`
  const before = await (await page.request.get('/api/v1/system/planner')).json()
  let r = await page.request.put(`/api/v1/system/connections/${conn}`, {
    data: { name: 'Fake LLM', kind: 'local', api: 'openai', base_url: LLM_URL, key: 'fake-key' },
  })
  expect(r.ok()).toBeTruthy()
  r = await page.request.post(`/api/v1/system/connections/${conn}/discover`)
  expect(r.ok()).toBeTruthy()
  r = await page.request.put('/api/v1/system/planner', { data: { connection_id: conn, model: 'fake-planner' } })
  expect(r.ok()).toBeTruthy()
  try {
    await body()
  } finally {
    // soft: провал уборки виден в отчёте и не прячет ошибку самого сценария.
    const prev = before?.source === 'catalog' ? { connection_id: before.connection_id, model: before.model } : {}
    r = await page.request.put('/api/v1/system/planner', { data: prev })
    expect.soft(r.ok(), 'модель декомпозиции возвращена').toBeTruthy()
    r = await page.request.delete(`/api/v1/system/connections/${conn}`)
    expect.soft(r.ok(), 'подключение fake-llm удалено').toBeTruthy()
  }
}

// Интервью вставкой текста. Штамп в реплике интервьюера делает текст
// уникальным: кэш конспектов общий для установки и ключ у него по тексту.
export async function addInterviewText(page: Page, title: string, role: string, text: string) {
  await page.getByRole('button', { name: 'Добавить интервью' }).click()
  const modal = page.locator('.modal', { has: page.getByRole('heading', { name: 'Новое интервью' }) })
  await modal.locator('.tabs').getByRole('button', { name: 'Текстом' }).click()
  await modal.getByLabel('Название').fill(title)
  await modal.getByLabel('Роль респондента').fill(role)
  await modal.getByLabel('Текст интервью').fill(text)
  await modal.getByRole('button', { name: 'Добавить' }).click()
  await expect(modal).toHaveCount(0)
}
