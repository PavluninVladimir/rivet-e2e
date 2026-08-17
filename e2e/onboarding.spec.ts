import { expect, test } from '@playwright/test'
import { E2E_TOKEN, createProject, login, openProjectSettings } from './helpers'

// Подключение репозитория при создании проекта (спеки scm-integration и
// web): мастер с проверкой доступа и страница настроек проекта.

test('мастер создаёт проект после успешной проверки подключения', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const name = `Онбординг ${stamp}`

  await page.goto('/#/projects')
  await page.getByRole('button', { name: 'Новый проект' }).click()
  await page.getByPlaceholder('Название проекта').fill(name)
  await page.getByPlaceholder(/URL репозитория/).fill('https://fake.local/e2e/demo')

  // Без проверки подключения вперёд не пускает.
  await expect(page.getByRole('button', { name: 'Далее' })).toBeDisabled()

  await page.getByPlaceholder('Токен доступа к хостингу').fill(E2E_TOKEN)
  await page.getByRole('button', { name: 'Проверить доступ' }).click()
  await expect(page.getByRole('button', { name: 'Далее' })).toBeEnabled()

  // Шаг проверок и возврат назад: значения сохранены, токен — нет.
  await page.getByRole('button', { name: 'Далее' }).click()
  await page.getByRole('button', { name: 'Назад' }).click()
  await expect(page.getByPlaceholder('Название проекта')).toHaveValue(name)
  await expect(page.getByPlaceholder('Токен доступа к хостингу')).toHaveValue('')

  await page.getByPlaceholder('Токен доступа к хостингу').fill(E2E_TOKEN)
  await page.getByRole('button', { name: 'Проверить доступ' }).click()
  await page.getByRole('button', { name: 'Далее' }).click()
  await page.getByRole('button', { name: 'Далее' }).click()
  await page.getByRole('button', { name: 'Создать проект' }).click()
  await expect(page.getByRole('button', { name: 'Новый Epic' })).toBeVisible()

  // Проект в списке с путём репозитория.
  await page.goto('/#/projects')
  await expect(page.locator('tr', { hasText: name })).toContainText('e2e/demo')
})

test('мастер показывает причину отказа и не создаёт проект', async ({ page }) => {
  await login(page)
  await page.goto('/#/projects')
  await page.getByRole('button', { name: 'Новый проект' }).click()
  await page.getByPlaceholder('Название проекта').fill('Битый URL')
  await page.getByPlaceholder(/URL репозитория/).fill('git@github.com:owner/name.git')
  await page.getByPlaceholder('Токен доступа к хостингу').fill(E2E_TOKEN)
  await page.getByRole('button', { name: 'Проверить доступ' }).click()

  // Причина показана рядом с полями, шаг не пройден.
  await expect(page.locator('.modal.wizard')).toContainText(/https|URL/)
  await expect(page.getByRole('button', { name: 'Далее' })).toBeDisabled()

  // Проект при этом не создан.
  await page.getByRole('button', { name: 'Отмена' }).click()
  await expect(page.locator('tr', { hasText: 'Битый URL' })).toHaveCount(0)
})

test('страница настроек показывает всё про проект', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const name = `Настройки ${stamp}`
  await createProject(page, name)
  await openProjectSettings(page, name)

  // Репозиторий, webhook, проверки, участники, окружения — в одном месте.
  await expect(page.getByRole('heading', { name: 'Репозиторий' })).toBeVisible()
  await expect(page.locator('.page')).toContainText('e2e/demo')
  await expect(page.getByRole('heading', { name: 'Webhook' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Название и проверки' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Участники' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Окружения' })).toBeVisible()

  // Токен после сохранения не показывается: виден только префикс владельца.
  await expect(page.locator('.page')).not.toContainText(E2E_TOKEN)

  // Правка проверок сохраняется.
  await page.getByRole('button', { name: 'Добавить проверку' }).click()
  await page.getByPlaceholder('Имя').last().fill('tests')
  await page.getByPlaceholder('Команда').last().fill('true')
  await page.getByRole('button', { name: 'Сохранить настройки' }).click()
  await expect(page.locator('.page')).toContainText('настройки сохранены')
  await page.reload()
  await expect(page.getByPlaceholder('Команда').last()).toHaveValue('true')
})
