import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, node } from './helpers'

// Smoke: проект, Epic и задача создаются через UI, задача видна в DAG,
// деталка открывается, палитра находит задачу по имени (2.2).
test('создание проекта, Epic и задачи через UI', async ({ page }) => {
  const stamp = Date.now()
  const project = `Smoke ${stamp}`
  const taskTitle = `Задача smoke ${stamp}`

  await createProject(page, project)
  await createEpic(page, `Epic smoke ${stamp}`)
  await addTask(page, taskTitle)

  // Деталка по клику на узел.
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.getByRole('heading', { name: taskTitle })).toBeVisible()
  await expect(drawer.getByText('e2e-результат записан')).toBeVisible()
  await drawer.getByRole('button', { name: '✕' }).click()

  // Палитра находит задачу.
  await page.keyboard.press('ControlOrMeta+KeyK')
  await page.getByPlaceholder(/Задача, Epic/).fill(taskTitle)
  await expect(page.locator('.pal-item', { hasText: taskTitle })).toBeVisible()
  await page.keyboard.press('Escape')
})
