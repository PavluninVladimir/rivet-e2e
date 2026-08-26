import { expect, test } from '@playwright/test'
import { createProject, login, openProjectSettings } from './helpers'

// Состояния формы по спеке web «Система элементов форм»: отправка входа по
// Enter, ошибка у поля после blur, занятая кнопка при сохранении.

test('вход отправляется по Enter из поля пароля', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Логин').fill(process.env.E2E_ADMIN_LOGIN ?? 'e2e-admin')
  await page.getByPlaceholder('Пароль').fill(process.env.E2E_ADMIN_PASSWORD ?? 'e2e-password')
  await page.getByPlaceholder('Пароль').press('Enter')
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()
})

test('неверный пароль показывает ошибку у поля, поле остаётся в фокусе формы', async ({ page }) => {
  await page.goto('/')
  await page.getByPlaceholder('Логин').fill('nobody')
  await page.getByPlaceholder('Пароль').fill('wrong')
  await page.getByRole('button', { name: 'Войти' }).click()
  const err = page.getByRole('alert')
  await expect(err).toContainText('Неверный логин или пароль')
  // Ошибка привязана к полю пароля через aria-describedby.
  const pwd = page.getByPlaceholder('Пароль')
  const errId = await err.getAttribute('id')
  await expect(pwd).toHaveAttribute('aria-describedby', new RegExp(errId!))
  await expect(pwd).toHaveAttribute('aria-invalid', 'true')
})

test('мастер проекта: пустое название подсвечивается после ухода из поля', async ({ page }) => {
  await login(page)
  await page.goto('/#/projects')
  await page.getByRole('button', { name: 'Новый проект' }).click()
  const name = page.getByPlaceholder('Название проекта')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await name.focus()
  await page.getByPlaceholder(/URL репозитория/).focus()
  await expect(page.getByRole('alert')).toContainText('Укажите название проекта')
  await name.fill('Forms')
  await expect(page.getByText('Укажите название проекта')).toHaveCount(0)
  // Вперёд нельзя без успешной проверки подключения.
  await expect(page.getByRole('button', { name: 'Далее' })).toBeDisabled()
})

test('кнопка сохранения занята на время запроса и не принимает повторных нажатий', async ({ page }) => {
  await login(page)
  const name = `Forms ${Date.now()}`
  await createProject(page, name)
  await openProjectSettings(page, name, 'Процесс')

  let puts = 0
  await page.route('**/policy', async route => {
    if (route.request().method() !== 'PUT') return route.continue()
    puts++
    await new Promise(r => setTimeout(r, 700))
    await route.continue()
  })
  await page.locator('.pg-node[data-step="review"]').click()
  const dlg = page.getByRole('dialog')
  await dlg.getByPlaceholder('название').fill('Ревью с задержкой')
  await dlg.getByRole('button', { name: 'Готово' }).click()
  const save = page.getByRole('button', { name: 'Сохранить процесс' })
  await save.click()
  await expect(save).toHaveAttribute('aria-disabled', 'true')
  await expect(save).toContainText('Сохранить процесс')
  await save.click({ force: true })
  await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')
  await expect(save).not.toHaveAttribute('aria-disabled', 'true')
  expect(puts).toBe(1)
})
