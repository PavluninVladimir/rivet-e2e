import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, login, node } from './helpers'

// Правка плана до запуска (add-plan-editing): поля, критерии, зависимости,
// отклонение цикла, удаление задачи из чернового плана.
test('план правится и чистится до запуска, цикл отклоняется', async ({ page }) => {
  await login(page)
  const stamp = Date.now()

  await createProject(page, `Plan ${stamp}`)
  await createEpic(page, `Epic plan ${stamp}`)
  await addTask(page, `База ${stamp}`)
  await addTask(page, `Зависимая ${stamp}`)
  await addTask(page, `Лишняя ${stamp}`)

  const drawer = page.locator('#drawer')

  // Правка: критерий и зависимость от «База».
  await node(page, `Зависимая ${stamp}`).click()
  await drawer.getByRole('button', { name: 'Редактировать' }).click()
  await drawer.getByRole('button', { name: 'Добавить критерий' }).click()
  await drawer.locator('.dw-sec input:not([type="checkbox"])').last().fill('новый критерий')
  await drawer.locator('label', { hasText: `База ${stamp}` }).getByRole('checkbox').check()
  await drawer.getByRole('button', { name: 'Сохранить' }).click()
  await expect(drawer).toContainText('новый критерий')
  // DAG перерисован: ребро добавлено (узел остаётся видимым).
  await expect(node(page, `Зависимая ${stamp}`)).toBeVisible()

  // Цикл: «База» → «Зависимая» отклоняется с причиной.
  await drawer.locator('.close').click()
  await node(page, `База ${stamp}`).click()
  await drawer.getByRole('button', { name: 'Редактировать' }).click()
  await drawer.locator('label', { hasText: `Зависимая ${stamp}` }).getByRole('checkbox').check()
  await drawer.getByRole('button', { name: 'Сохранить' }).click()
  await expect(drawer).toContainText('цикл')

  // Удаление лишней задачи из чернового плана.
  await drawer.locator('.close').click()
  await node(page, `Лишняя ${stamp}`).click()
  await drawer.getByRole('button', { name: 'Удалить', exact: true }).click()
  await drawer.getByRole('button', { name: 'Удалить?' }).click()
  await expect(node(page, `Лишняя ${stamp}`)).toHaveCount(0)
})
