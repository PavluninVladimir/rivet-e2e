import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Сессия доработки (add-user-sessions): blocked-задача → промпт участника →
// fixing на runner'е → обычный конвейер до review; timeline показывает
// запуск сессии человеком, история — сессию с водителем.
test('сессия доработки выводит blocked-задачу в конвейер', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Доработка ${stamp}`

  await createProject(page, `UserSession ${stamp}`)
  await createEpic(page, `Epic session ${stamp}`)
  await addTask(page, taskTitle, 'Сценарий эскалации [e2e-block]: без ответа человека не продолжать.')
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'BLOCKED')

  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.getByRole('heading', { name: 'Сессия доработки' })).toBeVisible()
  // [e2e-slow] в промпте держит сессию открытой — FIXING наблюдаем без гонки.
  await drawer.getByPlaceholder(/Промпт агенту/).fill(`Допиши результат [e2e-slow]. ${stamp}`)
  // Приватная сессия: автор видит содержимое и бейдж.
  await drawer.getByRole('checkbox', { name: /приватная/ }).check()
  await drawer.getByRole('button', { name: 'Запустить сессию' }).click()

  // Задача уходит в конвейер и доезжает до REVIEW без участия человека.
  await expect(drawer.locator('.st').first()).toHaveText('FIXING', { timeout: 15_000 })
  await expect(drawer.locator('.st').first()).toHaveText('REVIEW', { timeout: 60_000 })
  // Timeline: запуск сессии участником; шаги приватной сессии в timeline не публикуются.
  await expect(drawer.locator('.tl')).toContainText('сессия доработки запущена участником')
  // История сессий: водитель-пользователь и бейдж приватности (автор видит).
  const row = drawer.locator('.sess-row', { hasText: 'FIX' }).first()
  await expect(row).toContainText('водитель: e2e-admin')
  await expect(row.locator('.chip', { hasText: 'приватная' })).toBeVisible()
})
