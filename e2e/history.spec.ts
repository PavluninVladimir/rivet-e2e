import { expect, test } from '@playwright/test'
import { createProject, login } from './helpers'

// Импорт истории проекта (add-history-import): манифест уходит в API от
// имени владельца (сессия браузера), в списке Epic'ов появляется
// выполненный Epic с отметкой «история» и исходной датой.
test('импорт истории даёт выполненный Epic с отметкой в списке', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  await createProject(page, `History ${stamp}`)
  const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
  const projectId = projects.find((p) => p.Name === `History ${stamp}`)?.ID
  expect(projectId).toBeTruthy()

  const resp = await page.request.post(`/api/v1/projects/${projectId}/history`, {
    data: {
      source: 'openspec',
      epics: [{
        key: '2026-08-12-harden-core', title: `Ядро конвейера ${stamp}`, goal: 'надёжность',
        created_at: '2026-08-12T00:00:00Z', done_at: '2026-08-12T15:30:00Z',
        tasks: [{ title: '1.1 Попытки', done: true, repo: 'rivet', pr_url: 'https://github.com/o/r/pull/8' }],
      }],
    },
  })
  expect(resp.ok()).toBeTruthy()
  expect(await resp.json()).toMatchObject({ epics_created: 1, tasks_created: 1 })

  await page.goto('/#/epics')
  const row = page.locator('tr', { hasText: `Ядро конвейера ${stamp}` })
  await expect(row).toBeVisible()
  await expect(row).toContainText('DONE')
  await expect(row.locator('.chip')).toContainText('история · 2026-08-12')
})
