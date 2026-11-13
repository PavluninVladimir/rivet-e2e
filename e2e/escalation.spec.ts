import { expect, test } from '@playwright/test'
import { addTask, createAssessedEpic, createProject, expectNodeStatus, login, node, sectionItem } from './helpers'

// Эскалация (2.4): агент Rivet по метке [e2e-block] задаёт вопрос человеку
// инструментом ask_human (сценарий fake-llm), карточка attention появляется,
// ответ через деталку возвращает задачу в работу до done.
test('blocked-задача эскалируется и возвращается в работу после ответа', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Эскалация ${stamp}`

  const project = `Esc ${stamp}`
  await createProject(page, project)
  await createAssessedEpic(page, `Epic esc ${stamp}`)
  await addTask(page, taskTitle, 'Сценарий эскалации [e2e-block]: без ответа человека не продолжать.')

  await page.getByRole('button', { name: 'Запустить' }).click()

  // Вопрос агента блокирует задачу, на дашборде появляется карточка attention.
  const attCard = page.locator('.att-card', { hasText: 'BLOCKED' })
  await expect(attCard).toBeVisible({ timeout: 90_000 })

  // Счётчики эскалаций по проектам (add-project-navigation): у «Задач» —
  // эскалации этого проекта, в списке проектов — у самого проекта.
  await expect(sectionItem(page, 'Задачи').locator('.count')).toHaveText('1')
  const dashboard = page.url()
  await page.goto('/#/projects')
  await expect(page.locator('tr', { hasText: project }).locator('td[data-escalations]')).toHaveAttribute('data-escalations', '1')
  // Из другого проекта эскалация видна у «← Все проекты», а «Задачи» её не
  // считают.
  await createProject(page, `Esc other ${stamp}`)
  await expect(page.locator('.side-back .count')).toBeVisible()
  await expect(sectionItem(page, 'Задачи').locator('.count')).toHaveCount(0)
  await page.goto(dashboard)
  await expect(attCard).toBeVisible()
  await attCard.click()

  const drawer = page.locator('#drawer')
  await expect(drawer.getByText('вопрос от e2e-агента').first()).toBeVisible()
  await drawer.getByPlaceholder(/Ответ/).fill('Подтверждаю, работай по описанию.')
  await drawer.getByRole('button', { name: 'Ответить и вернуть в работу' }).click()

  // Эскалация закрыта, задача едет дальше до review.
  await expect(page.locator('.att-card')).toHaveCount(0, { timeout: 30_000 })
  await expectNodeStatus(page, taskTitle, 'REVIEW')

  await node(page, taskTitle).click()
  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})
