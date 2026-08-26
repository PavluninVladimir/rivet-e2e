import { expect, test, type Page } from '@playwright/test'
import { createProject, login, openProjectSettings } from './helpers'

// Граф процесса (add-process-graph-editor, спека web «Редактор процесса»):
// стрелка правит переход, «+» добавляет шаг, клавиатура открывает и
// закрывает окно, ошибка сервера открывает окно шага с ошибкой у поля,
// участник без роли владельца видит граф только для чтения.

async function projectId(page: Page, name: string): Promise<string> {
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const id = projects.find((p) => p.Name === name)?.ID
  expect(id).toBeTruthy()
  return id!
}

test('переход правится стрелкой, шаг добавляется через «+», клавиатура открывает окно', async ({ page }) => {
  await login(page)
  const name = `Graph ${Date.now()}`
  await createProject(page, name)
  await openProjectSettings(page, name, 'Процесс')

  // Процесс по умолчанию: пять шагов, терминалы, переходы по умолчанию пунктиром.
  await expect(page.locator('.pg-node')).toHaveCount(5)
  await expect(page.locator('.pg-cap.done')).toBeVisible()
  await expect(page.locator('.pg-cap.escalate')).toBeVisible()
  const okEdge = page.locator('.pg-edge[data-edge="review:ok"]')
  await expect(okEdge).toHaveClass(/default/)
  await expect(okEdge).toHaveAttribute('aria-label', /к merge, по умолчанию/)
  await expect(page.locator('.pg-edge[data-edge="review:changes"]')).toHaveAttribute('aria-label', /к code, по умолчанию/)

  // Стрелка ok у review задаётся явно (на merge) — сплошная линия без пометки «по умолчанию».
  await okEdge.locator('text').click()
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('Исход ok шага review')
  await dlg.locator('select').selectOption('merge')
  await dlg.getByRole('button', { name: 'Готово' }).click()
  await expect(okEdge).not.toHaveClass(/default/)
  await expect(okEdge).toHaveAttribute('aria-label', /к merge$/)

  // «+» перед merge добавляет шаг prompt.
  await page.getByRole('button', { name: 'добавить шаг на позицию 4' }).click()
  await expect(dlg).toContainText('Новый шаг')
  await dlg.getByLabel('Тип', { exact: true }).selectOption('prompt')
  await dlg.getByPlaceholder('Задание агенту').fill('Проверь миграции.')
  await dlg.getByRole('button', { name: 'Добавить шаг' }).click()
  await expect(page.locator('.pg-node')).toHaveCount(6)
  await expect(page.locator('.pg-node').nth(3)).toHaveAttribute('data-step', 'prompt')

  await page.getByRole('button', { name: 'Сохранить процесс' }).click()
  await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')
  await page.reload()
  await expect(page.locator('.pg-edge[data-edge="review:ok"]')).toHaveAttribute('aria-label', /к merge$/)

  // Клавиатура: Enter на узле открывает окно, Escape закрывает и возвращает фокус.
  const code = page.locator('.pg-node[data-step="code"]')
  await code.focus()
  await page.keyboard.press('Enter')
  await expect(dlg).toContainText('Шаг code')
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await expect(code).toBeFocused()
})

test('ошибка сервера подсвечивает узел и открывает окно с ошибкой у поля перехода', async ({ page }) => {
  await login(page)
  const name = `Graph err ${Date.now()}`
  await createProject(page, name)
  await openProjectSettings(page, name, 'Процесс')
  const dlg = page.getByRole('dialog')

  // changes у review явно ведёт на test, затем test удаляется: переход повисает.
  await page.locator('.pg-edge[data-edge="review:changes"] text').click()
  await dlg.locator('select').selectOption('test')
  await dlg.getByRole('button', { name: 'Готово' }).click()
  await page.locator('.pg-node[data-step="test"]').click()
  await dlg.getByRole('button', { name: 'Удалить шаг' }).click()
  await expect(page.locator('.pg-node')).toHaveCount(4)

  await page.getByRole('button', { name: 'Сохранить процесс' }).click()
  const review = page.locator('.pg-node[data-step="review"]')
  await expect(review).toHaveClass(/has-err/)
  await expect(dlg).toContainText('Шаг review')
  await expect(dlg.getByRole('alert')).toHaveCount(1)
  await expect(dlg.getByRole('alert')).toContainText('несуществующий шаг')
  await expect(dlg.getByLabel('changes →')).toHaveAttribute('aria-invalid', 'true')
  // Версия не создана: процесс по-прежнему унаследован.
  await expect(page.locator('.proc-section')).toContainText('наследуется от установки')
})

test('участник без роли владельца видит граф только для чтения', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const name = `Graph ro ${stamp}`
  await createProject(page, name)
  const id = await projectId(page, name)
  const member = `viewer${stamp}`
  let r = await page.request.post('/api/v1/users', { data: { login: member, name: 'Viewer', password: 'viewer-pass-1', admin: false } })
  expect(r.ok()).toBeTruthy()
  r = await page.request.post(`/api/v1/projects/${id}/members`, { data: { login: member, role: 'member' } })
  expect(r.ok()).toBeTruthy()

  await page.getByRole('button', { name: 'Выйти' }).click()
  await page.getByPlaceholder('Логин').fill(member)
  await page.getByPlaceholder('Пароль').fill('viewer-pass-1')
  await page.getByRole('button', { name: 'Войти' }).click()
  // Если установка требует сменить выданный пароль при первом входе — меняем.
  const gate = page.getByPlaceholder('Выданный пароль')
  await expect(page.getByRole('button', { name: 'Выйти' }).or(gate)).toBeVisible()
  if (await gate.isVisible()) {
    await gate.fill('viewer-pass-1')
    await page.getByPlaceholder(/Новый пароль/).fill('viewer-pass-2')
    await page.getByRole('button', { name: 'Сменить пароль' }).click()
  }
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()

  await openProjectSettings(page, name, 'Процесс')
  await expect(page.locator('.proc-section')).toContainText('только просмотр')
  await expect(page.locator('.pg-node')).toHaveCount(5)
  await expect(page.locator('.pg-gap')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Сохранить процесс' })).toHaveCount(0)
  await page.locator('.pg-node[data-step="review"]').click()
  const dlg = page.getByRole('dialog')
  await expect(dlg.getByPlaceholder('название')).toBeDisabled()
  await expect(dlg.getByRole('button', { name: 'Готово' })).toHaveCount(0)
  await dlg.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await expect(dlg).toHaveCount(0)
})
