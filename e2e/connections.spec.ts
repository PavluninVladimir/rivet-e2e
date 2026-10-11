import { expect, test } from '@playwright/test'
import { createEpic, createProject, login, node } from './helpers'

// Подключения к моделям (add-model-connections): подключение к fake-провайдеру
// стенда, обнаружение моделей, ручная модель с ценой, выбор модели
// декомпозиции, декомпозиция Epic этой моделью, отключение убирает модели
// из выбора, неверный ключ подсвечивается.

const LLM_URL = `http://localhost:${process.env.E2E_LLM_PORT ?? '8283'}/v1`

test('подключение к провайдеру, модели и декомпозиция Epic через каталог', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const id = `fake${stamp}`
  await page.goto('/#/app-management/connections')
  await expect(page.getByRole('heading', { name: 'Подключения' })).toBeVisible()

  // Создание с неверным ключом: сохраняется как «ключ отклонён».
  await page.getByRole('button', { name: 'Новое подключение' }).click()
  const dlg = page.getByRole('dialog')
  await dlg.getByLabel('Идентификатор').fill(id)
  await dlg.getByLabel('Название', { exact: true }).fill('Fake LLM')
  await dlg.getByLabel('Вид').selectOption('local')
  await dlg.getByLabel('Base URL').fill(LLM_URL)
  await dlg.getByPlaceholder('API-ключ').fill('wrong-key')
  await dlg.getByRole('button', { name: 'Создать и проверить' }).click()
  const card = page.locator(`.conn-card[data-connection="${id}"]`)
  await expect(card).toContainText('ключ отклонён')

  // Правильный ключ: состояние «в порядке», обнаружение находит модели.
  await card.getByRole('button', { name: 'Изменить' }).click()
  await dlg.getByPlaceholder('API-ключ').fill('fake-key')
  await dlg.getByRole('button', { name: 'Сохранить' }).click()
  await expect(card).toContainText('в порядке')
  await card.getByRole('button', { name: 'Обновить список' }).click()
  await expect(card).toContainText('fake-planner')
  await expect(card).toContainText('моделей: 3')

  // Ручная модель с ценой и скрытие обнаруженной.
  await card.getByRole('button', { name: 'Модели…' }).click()
  await dlg.getByRole('button', { name: '+ модель вручную' }).click()
  const manual = dlg.locator('.model-row').last()
  await manual.getByLabel('идентификатор модели').fill('fake-manual')
  await manual.getByLabel('цена входа').fill('1.5')
  await dlg.locator('.model-row[data-model="fake-large"]').getByRole('checkbox').check()
  await dlg.getByRole('button', { name: 'Сохранить' }).click()
  await expect(card).toContainText('fake-manual')
  await expect(card).toContainText('моделей: 3 (+1 скрытых или пропавших)')

  // Модель декомпозиции из каталога.
  const plannerBlock = page.locator('.dw-sec', { hasText: 'Модель для декомпозиции Epic' })
  await plannerBlock.getByLabel('Подключение', { exact: true }).selectOption(id)
  const modelSelect = plannerBlock.getByLabel('Модель', { exact: true })
  await expect(modelSelect.locator('option', { hasText: 'fake-planner' })).toHaveCount(1)
  await expect(modelSelect.locator('option', { hasText: 'fake-large' })).toHaveCount(0)
  await modelSelect.selectOption('fake-planner')
  await plannerBlock.getByRole('button', { name: 'Сохранить' }).click()
  await expect(plannerBlock).toContainText(`из каталога: ${id}/fake-planner`)
  await expect(card).toContainText('декомпозиция')

  // Декомпозиция Epic идёт этой моделью: fake-llm отдаёт план из двух задач.
  const project = `Conn ${stamp}`
  await createProject(page, project)
  const epic = `Epic conn ${stamp}`
  await createEpic(page, epic)
  await page.getByRole('button', { name: 'Декомпозировать' }).click()
  await expect(node(page, `Подготовка: ${epic}`)).toBeVisible({ timeout: 30_000 })
  await expect(node(page, `Завершение: ${epic}`)).toBeVisible()

  // Отключение подключения: модели уходят из выбора, планировщик помечен недоступным.
  await page.goto('/#/app-management/connections')
  await card.getByRole('button', { name: 'Отключить' }).click()
  await expect(card).toContainText('отключено')
  await expect(plannerBlock).toContainText('недоступна')
  await expect(plannerBlock.getByLabel('Подключение', { exact: true }).locator('option', { hasText: id })).toHaveCount(0)

  // Удалить нельзя, пока планировщик ссылается; после сброса — можно.
  await card.getByRole('button', { name: 'Удалить', exact: true }).click()
  await card.getByRole('button', { name: 'Удалить?' }).click()
  await expect(page.getByText('подключение используется')).toBeVisible()
  await plannerBlock.getByRole('button', { name: 'Сбросить на окружение' }).click()
  await expect(plannerBlock).toContainText('не настроена')
  await card.getByRole('button', { name: 'Удалить?' }).click()
  await expect(card).toHaveCount(0)
})
