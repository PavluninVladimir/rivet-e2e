import { expect, test, type Page } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node, projectFromURL } from './helpers'

// Процесс задачи в деталке (fix-web-console-tails, спека web «Процесс
// задачи в деталке»): компактный граф по снимку процесса задачи. Процесс
// проекта задаётся явно, чтобы сценарий не зависел от процесса установки:
// code → test → review → merge. У не начатой задачи снимка нет. Задача
// ждёт merge: merge текущий, code, test и review пройдены. После merge
// пройдено всё и выделено «готово».

async function projectWithProcess(page: Page, name: string): Promise<void> {
  await createProject(page, name)
  const pid = projectFromURL(page.url())
  const r = await page.request.put(`/api/v1/projects/${pid}/policy`, { data: { process: { steps: [
    { id: 'code', kind: 'code', title: 'Реализация', participants: [{ agent: { role: 'developer' } }] },
    { id: 'test', kind: 'test', title: 'Проверки', participants: [{ agent: { role: 'tester' } }] },
    { id: 'review', kind: 'review', title: 'Review', participants: [{ agent: { role: 'reviewer' } }] },
    { id: 'merge', kind: 'merge', title: 'Merge' },
  ] } } })
  expect(r.ok(), await r.text()).toBeTruthy()
}

test('деталка задачи показывает процесс: текущий шаг, пройденные шаги и «готово»', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Граф процесса ${stamp}`

  await projectWithProcess(page, `ProcGraph ${stamp}`)
  await createEpic(page, `Epic graph ${stamp}`)
  await addTask(page, taskTitle)

  const drawer = page.locator('#drawer')
  const graph = drawer.locator('[data-task-process]')
  const step = (id: string) => graph.locator(`[data-step="${id}"]`)
  const summary = drawer.locator('[data-task-process-summary]')

  // Не начатая задача: процесс ещё не зафиксирован, графа нет.
  await node(page, taskTitle).click()
  await expect(drawer.getByRole('heading', { name: taskTitle })).toBeVisible()
  await expect(drawer.getByRole('heading', { name: 'Метаданные' })).toBeVisible()
  await expect(graph).toHaveCount(0)
  await drawer.getByRole('button', { name: '✕' }).click()

  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()

  // Review одобрен, задача ждёт merge: граф обновляется вместе с деталкой.
  await expect(step('merge')).toHaveAttribute('data-state', 'current', { timeout: 90_000 })
  for (const id of ['code', 'test', 'review']) await expect(step(id)).toHaveAttribute('data-state', 'passed')
  await expect(summary).toHaveText('Текущий шаг: Merge · пройдено 3 из 4')
  await expect(graph.getByRole('img')).toHaveAttribute('aria-label', /Текущий шаг: Merge/)
  // Пройденные переходы отмечены, возвратов и эскалаций не было.
  await expect(graph.locator('[data-edge="code:ok"]')).toHaveAttribute('data-taken', '1')
  await expect(graph.locator('[data-edge="review:changes"]')).toHaveCount(0)
  await expect(graph.locator('[data-cap="escalate"]')).toHaveCount(0)
  await expect(graph.locator('[data-cap="done"]')).not.toHaveClass(/reached/)

  await drawer.getByRole('button', { name: 'Merge' }).click()
  await expect(drawer.locator('.st').first()).toHaveText('DONE', { timeout: 30_000 })
  await expect(summary).toHaveText('Задача завершена · пройдено 4 из 4')
  for (const id of ['code', 'test', 'review', 'merge']) await expect(step(id)).toHaveAttribute('data-state', 'passed')
  await expect(graph.locator('[data-cap="done"]')).toHaveClass(/reached/)
})

// Возврат на исправление: ревьюер fake-llm по метке [e2e-native-changes]
// в заголовке возвращает задачу с первого прохода. Граф показывает
// пройденный возврат review → code, а второй проход снова отмечает шаги.
test('граф процесса показывает возврат с review и повторный проход', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Возврат ${stamp} [e2e-native-changes]`

  await projectWithProcess(page, `ProcLoop ${stamp}`)
  await createEpic(page, `Epic loop ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()

  const graph = page.locator('#drawer [data-task-process]')
  await expect(graph.locator('[data-step="merge"]')).toHaveAttribute('data-state', 'current', { timeout: 120_000 })
  const back = graph.locator('[data-edge="review:changes"]')
  await expect(back).toHaveAttribute('data-taken', '1')
  await expect(back).toContainText('changes')
  await expect(graph.locator('[data-edge="code:ok"]')).toHaveAttribute('data-taken', '2')
  for (const id of ['code', 'test', 'review']) await expect(graph.locator(`[data-step="${id}"]`)).toHaveAttribute('data-state', 'passed')
  await expect(page.locator('#drawer [data-task-process-summary]')).toHaveText('Текущий шаг: Merge · пройдено 3 из 4')
})
