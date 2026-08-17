import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node, openProjectSettings } from './helpers'

// Публикация окружений (implement-deployment): auto-деплой после merge
// с Deploy → Verify и провал с паузой и возобновлением.

// Создание окружения через форму блока «Окружения» (страница настроек
// проекта — блок переехал туда в add-repo-onboarding).
async function createEnvironment(page, project: string, name: string, opts: {
  trigger: 'auto' | 'manual'
  deployCmd: string
  verifyCmd: string
}) {
  await openProjectSettings(page, project)
  await page.getByRole('button', { name: 'Новое окружение' }).click()
  await page.getByPlaceholder(/Имя \(staging/).fill(name)
  await page.locator('.modal select').selectOption(opts.trigger)
  await page.getByPlaceholder(/Команда доставки/).fill(opts.deployCmd)
  await page.getByPlaceholder(/Команда проверки/).fill(opts.verifyCmd)
  await page.locator('.modal').getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.locator('.env-card', { hasText: name })).toBeVisible()
}

test('merge запускает auto-публикацию: Deploy → Verify, статус и лог видны', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Деплой ${stamp}`

  const projectName = `Deploy ${stamp}`
  await createProject(page, projectName)
  await createEnvironment(page, projectName, 'staging', {
    trigger: 'auto',
    deployCmd: 'echo "доставка версии $RIVET_VERSION в $RIVET_ENV"',
    verifyCmd: 'true',
  })

  await page.goto('/#/epics')
  await createEpic(page, `Epic deploy ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()
  await page.locator('#drawer').getByRole('button', { name: 'Merge' }).click()

  // Merge ставит auto-публикацию; карточка окружения доезжает до DONE по SSE.
  await openProjectSettings(page, projectName)
  const card = page.locator('.env-card', { hasText: 'staging' })
  await expect(card.locator('.sess-stage')).toHaveText('DONE', { timeout: 60_000 })
  await expect(card).toContainText('fake-merge-') // версия — sha merge-коммита

  // История: лог публикации сохранён и замаскированных секретов не требует —
  // просто проверяем содержимое вывода команды доставки.
  await card.getByRole('button', { name: 'История' }).click()
  await card.locator('.sess-row').first().click()
  await expect(card.locator('.term')).toContainText('доставка версии fake-merge-')
})

test('провал Verify: публикация failed, окружение на паузе, resume снимает', async ({ page }) => {
  await login(page)
  const stamp = Date.now()

  const projectName = `DeployFail ${stamp}`
  await createProject(page, projectName)
  await createEnvironment(page, projectName, 'prod', {
    trigger: 'manual',
    deployCmd: 'echo deploying',
    verifyCmd: 'echo "health-check не прошёл"; exit 1',
  })

  const card = page.locator('.env-card', { hasText: 'prod' })
  await card.getByRole('button', { name: 'Опубликовать' }).click()

  // Провал (prev-версии нет — откатываться некуда): FAILED, пауза, detail.
  await expect(card.locator('.sess-stage')).toHaveText('FAILED', { timeout: 60_000 })
  await expect(card.locator('.env-paused')).toBeVisible()
  await expect(card.locator('.env-detail')).toContainText('health-check')

  // Эскалация DEPLOY_FAILED видна в «Требует внимания» и ведёт к проектам.
  await page.goto('/#/tasks')
  const att = page.locator('.att-card', { hasText: 'DEPLOY_FAILED' })
  await expect(att).toBeVisible()
  await att.click()
  // Карточка ведёт прямо в настройки проекта, где живут окружения.
  await expect(page.getByRole('heading', { name: 'Настройки проекта' })).toBeVisible()
  await expect(page.locator('.env-card', { hasText: 'prod' })).toBeVisible()

  // Resume: пауза снята, публиковать снова можно.
  await card.getByRole('button', { name: 'Возобновить' }).click()
  await expect(card.locator('.env-paused')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Опубликовать' })).toBeEnabled()
})
