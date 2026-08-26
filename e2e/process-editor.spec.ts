import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, openProjectSettings } from './helpers'

// Редактор процесса (add-process-editor): шаг prompt проходит fake-агент с
// маркером вердикта; владелец правит процесс в настройках проекта;
// ограничения установки не дают сохранить процесс без человека на review.

async function projectWithPrompt(page: import('@playwright/test').Page, name: string) {
  await createProject(page, name)
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const projectId = projects.find((p) => p.Name === name)?.ID
  expect(projectId).toBeTruthy()
  const resp = await page.request.put(`/api/v1/projects/${projectId}/policy`, {
    data: {
      process: {
        steps: [
          { id: 'code', kind: 'code', participants: [{ agent: {} }] },
          { id: 'test', kind: 'test', participants: [{ agent: {} }] },
          { id: 'review', kind: 'review', participants: [{ agent: {} }] },
          { id: 'migrations', kind: 'prompt', title: 'Проверка миграций', prompt: 'Проверь миграции на обратимость.', participants: [{ agent: {} }] },
          { id: 'merge', kind: 'merge' },
        ],
      },
    },
  })
  expect(resp.ok()).toBeTruthy()
  return projectId!
}

test('шаг prompt исполняется агентом, процесс правится в настройках', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const name = `Editor ${stamp}`
  const taskTitle = `Задание агенту ${stamp}`
  const projectId = await projectWithPrompt(page, name)

  await createEpic(page, `Epic editor ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  // review → prompt (fake-агент отвечает VERDICT: OK) → ожидание merge.
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await expect.poll(async () => {
    const events: Array<{ Payload: Record<string, unknown> }> =
      await (await page.request.get(`/api/v1/events?project=${projectId}&type=task.step&limit=100&latest=1`)).json()
    return events.some((e) => e.Payload.step === 'migrations' && e.Payload.outcome === 'ok')
  }, { timeout: 60_000 }).toBe(true)

  // Редактор в настройках проекта: шаг prompt виден, название правится.
  await openProjectSettings(page, name)
  const step = page.locator('.proc-step[data-step="migrations"]')
  await expect(step).toBeVisible()
  await expect(step.locator('textarea')).toHaveValue('Проверь миграции на обратимость.')
  await step.locator('.proc-title').fill('Обратимость миграций')
  await page.getByRole('button', { name: 'Сохранить процесс' }).click()
  await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')
  await expect(page.locator('.proc-section')).toContainText('процесс проекта')

  // Ошибка у шага и поля: prompt без текста задания.
  await step.locator('textarea').fill('')
  await page.getByRole('button', { name: 'Сохранить процесс' }).click()
  await expect(step.locator('.err')).toContainText('текст задания')
})

test('ограничение установки «человек на review» не даёт сохранить процесс без человека', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const name = `Locks ${stamp}`
  await createProject(page, name)

  // Администратор включает ограничение на вкладке «Политики».
  await page.goto('/#/app-management/policies')
  await page.getByLabel(/человек на review обязателен/).check()
  await page.getByRole('button', { name: 'Сохранить версию' }).click()
  await expect(page.getByText(/сохранена версия|не соответствуют/).first()).toBeVisible()

  // Владелец сохраняет процесс с review без человека — ошибка у шага review.
  await openProjectSettings(page, name)
  const review = page.locator('.proc-step[data-step="review"]')
  await review.locator('.proc-title').fill('Только агенты')
  await page.getByRole('button', { name: 'Сохранить процесс' }).click()
  await expect(review.locator('.err')).toContainText('участника-человека')

  // С человеком по роли — сохраняется; ограничение снимается обратно.
  await review.getByRole('button', { name: '+ участник' }).click()
  await review.locator('.proc-participant').last().locator('select').first().selectOption('user')
  await page.getByRole('button', { name: 'Сохранить процесс' }).click()
  await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')
  await page.goto('/#/app-management/policies')
  await page.getByLabel(/человек на review обязателен/).uncheck()
  await page.getByRole('button', { name: 'Сохранить версию' }).click()
})
