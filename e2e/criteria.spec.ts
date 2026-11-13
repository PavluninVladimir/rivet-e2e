import { expect, test } from '@playwright/test'
import { addTask, createAssessedEpic, createProject, expectNodeStatus, login, node, projectFromURL } from './helpers'

test('результаты критериев и причина возврата видны после исправления', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  await createProject(page, `Criteria ${stamp}`)
  const pid = projectFromURL(page.url())
  await createAssessedEpic(page, `Epic criteria ${stamp}`)
  const title = `Критерий [e2e-criterion-fail] ${stamp}`
  await addTask(page, title)
  await node(page, title).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.locator('.crit.pend')).toContainText('не проверен')
  await drawer.getByRole('button', { name: '✕', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await page.getByRole('button', { name: 'Запустить' }).click()
  // Fake reviewer says APPROVED but fails criterion 1 on the first pass.
  // The control plane must return it for changes before accepting pass two.
  await expect.poll(async () => {
    const response = await page.request.get(`/api/v1/events?project=${pid}&type=task.step&limit=200`)
    expect(response.ok()).toBeTruthy()
    const events = await response.json()
    return (events ?? []).some((e: { Payload: { step?: string; outcome?: string } }) =>
      e.Payload.step === 'review' && e.Payload.outcome === 'changes')
  }, { timeout: 120_000 }).toBe(true)
  await expectNodeStatus(page, title, 'REVIEW', 120_000)
  await node(page, title).click()
  await expect(drawer.locator('.crit.ok .m')).toHaveText('✓')
  await expect(drawer.locator('.crit.ok .m')).toHaveAttribute('aria-label', 'выполнен')
  const detail = drawer.locator('.tl-detail').filter({ hasText: 'Не выполнены критерии' }).first()
  await expect(detail.locator('pre')).toBeHidden()
  await detail.getByText('Подробнее', { exact: true }).click()
  await expect(detail.locator('pre')).toBeVisible()
  await expect(detail.locator('pre')).toContainText('нужен второй проход реализации')
  await drawer.getByRole('button', { name: 'Merge', exact: true }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})
