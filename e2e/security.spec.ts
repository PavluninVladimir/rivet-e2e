import { expect, test, type Page } from '@playwright/test'
import { createProject, login, openSection } from './helpers'

// Заголовки безопасности rivetd (fix-console-rivetd-tails, спека
// access-policy «Заголовки безопасности HTTP»): консоль отдаётся со строгим
// CSP, запретом фреймов, nosniff и Referrer-Policy, ответы API — с политикой
// без ресурсов. Консоль работает под политикой без нарушений: вход, поток
// событий и схемы Mermaid всех видов, которые она рисует (C4, ER, sequence).

// Нарушения CSP со страницы: событие securitypolicyviolation и сообщения
// браузера в консоли. Сборщик ставится до загрузки страницы.
async function collectViolations(page: Page): Promise<() => Promise<string[]>> {
  const logged: string[] = []
  page.on('console', m => { if (/Content Security Policy/i.test(m.text())) logged.push(m.text()) })
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', e => {
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)
    })
  })
  return async () => [...logged, ...await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? [])]
}

test('консоль и API отдаются с заголовками безопасности', async ({ page }) => {
  for (const path of ['/', '/p/x/tasks']) {
    const r = await page.request.get(path)
    expect(r.ok()).toBeTruthy()
    const h = r.headers()
    expect(h['content-security-policy']).toContain("default-src 'self'")
    expect(h['content-security-policy']).toContain("script-src 'self';")
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(h['content-security-policy']).toContain("object-src 'none'")
    expect(h['content-security-policy']).not.toContain('unsafe-eval')
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['referrer-policy']).toBe('same-origin')
  }
  for (const path of ['/api/v1/health', '/api/v1/projects']) {
    const h = (await page.request.get(path)).headers()
    expect(h['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'")
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['referrer-policy']).toBe('same-origin')
  }
})

test('консоль под CSP: вход, поток событий и схемы архитектуры без нарушений', async ({ page }) => {
  test.setTimeout(150_000)
  const violations = await collectViolations(page)
  await login(page)
  await createProject(page, `CSP ${Date.now()}`, 'e2e/arch')
  // Поток событий подключён: EventSource разрешён connect-src 'self'.
  await expect(page.locator('#sidebar .side-foot')).toContainText('Подключено')

  // Снимок архитектуры строится при подключении проекта.
  await openSection(page, 'Архитектура')
  await expect(page.getByRole('heading', { name: 'Архитектура', exact: true })).toBeVisible()
  const diagram = page.locator('.arch-page .mmd svg').first()
  await expect(diagram).toBeVisible({ timeout: 45_000 })
  for (const tab of ['C4', 'Данные (ERD)', 'Сценарии']) {
    await page.locator('.tabs').getByRole('button', { name: tab, exact: true }).click()
    await expect(page.locator('.arch-page .mmd svg').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.arch-page .mmd-error')).toHaveCount(0)
  }
  await openSection(page, 'Обзор')
  await expect(page.getByRole('heading', { name: 'Обзор проекта' })).toBeVisible()
  await openSection(page, 'Задачи')
  await openSection(page, 'Цикл разработки')
  await expect(page.getByRole('heading', { name: 'Цикл разработки', exact: true })).toBeVisible()
  expect(await violations()).toEqual([])
})
