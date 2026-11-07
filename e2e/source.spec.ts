import { expect, test } from '@playwright/test'
import { login } from './helpers'

// Ссылка на исходный код работающей версии (спека source-availability,
// AGPL §13). Стенд собирает rivetd без версии (go build), поэтому подпись
// «сборка без версии», а ссылка ведёт на корень репозитория. Адрес консоль
// берёт из GET /api/v1/about, сценарий сверяет его с тем же ответом.

test('ссылка на исходный код видна без входа и ведёт на исходники этой версии', async ({ page, request }) => {
  const resp = await request.get('/api/v1/about')
  expect(resp.status()).toBe(200)
  const about = await resp.json()
  expect(Object.keys(about).sort()).toEqual(['commit', 'license', 'source_ref_url', 'source_url', 'version'])
  expect(about.license).toBe('AGPL-3.0-only')
  expect(about.version).toBe('dev')
  expect(about.source_ref_url).toBe(about.source_url)

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible()
  const link = page.getByRole('link', { name: 'Исходный код · сборка без версии' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', about.source_ref_url)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
})

test('та же ссылка в профиле вошедшего пользователя', async ({ page, request }) => {
  const about = await (await request.get('/api/v1/about')).json()
  await login(page)
  await page.goto('/#/profile')
  await expect(page.getByRole('heading', { name: 'Профиль' })).toBeVisible()
  const link = page.getByRole('link', { name: 'Исходный код · сборка без версии' })
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute('href', about.source_ref_url)
})
