import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, openProjectSettings } from './helpers'

// Редактор процесса (add-process-editor, add-process-graph-editor): шаг
// prompt проходит fake-агент с маркером вердикта; владелец правит процесс
// графом в настройках проекта; ограничения установки не дают сохранить
// процесс без человека на review, ошибка открывает окно шага.

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

  // Граф в настройках проекта: узел prompt виден, окно шага правит название.
  await openProjectSettings(page, name, 'Процесс')
  const step = page.locator('.pg-node[data-step="migrations"]')
  await expect(step).toBeVisible()
  await step.click()
  const dlg = page.getByRole('dialog')
  await expect(dlg.getByPlaceholder('Задание агенту')).toHaveValue('Проверь миграции на обратимость.')
  await dlg.getByPlaceholder('название').fill('Обратимость миграций')
  await dlg.getByRole('button', { name: 'Готово' }).click()
  await expect(step).toContainText('Обратимость миграций')
  await page.getByRole('button', { name: 'Сохранить процесс' }).click()
  await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')
  await expect(page.locator('.proc-section')).toContainText('процесс проекта')

  // Пустой текст задания не даёт закрыть окно кнопкой «Готово».
  await step.click()
  await dlg.getByPlaceholder('Задание агенту').fill('')
  await expect(dlg.getByText('Текст задания обязателен')).toBeVisible()
  await expect(dlg.getByRole('button', { name: 'Готово' })).toBeDisabled()
})

test('ограничение установки «человек на review» не даёт сохранить процесс без человека', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const name = `Locks ${stamp}`
  await createProject(page, name)

  // Администратор включает ограничение на вкладке «Политики». Ограничение
  // глобальное, поэтому снимается в finally и с ожиданием сохранения.
  const setHumanReview = async (on: boolean) => {
    await page.goto('/#/app-management/policies')
    const box = page.getByLabel(/человек на review обязателен/)
    if (on) await box.check(); else await box.uncheck()
    await page.getByRole('button', { name: 'Сохранить версию' }).click()
    await expect(page.getByText(/сохранена версия|не соответствуют/).first()).toBeVisible()
  }
  try {
    await setHumanReview(true)
    // Владелец сохраняет процесс с review без человека — узел подсвечен,
    // окно шага открыто с ошибкой.
    await openProjectSettings(page, name, 'Процесс')
    const review = page.locator('.pg-node[data-step="review"]')
    await review.click()
    const dlg = page.getByRole('dialog')
    await dlg.getByPlaceholder('название').fill('Только агенты')
    await dlg.getByRole('button', { name: 'Готово' }).click()
    await page.getByRole('button', { name: 'Сохранить процесс' }).click()
    await expect(review).toHaveClass(/has-err/)
    await expect(dlg).toContainText('участника-человека')

    // С человеком по роли — сохраняется.
    await dlg.getByRole('button', { name: '+ участник' }).click()
    await dlg.locator('[data-participant]').last().getByLabel('тип участника').selectOption('user')
    await dlg.getByRole('button', { name: 'Готово' }).click()
    await expect(review).toContainText('owner')
    await page.getByRole('button', { name: 'Сохранить процесс' }).click()
    await expect(page.locator('.proc-section .note')).toContainText('сохранена версия проекта')
  } finally {
    await setHumanReview(false)
  }
})
