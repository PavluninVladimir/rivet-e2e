import { expect, test, type Page } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node, openProjectSettings } from './helpers'

// Политики конвейера (add-policy-presets): авто-merge по политике проекта
// и отложенный merge по защищённому пути. Fake SCM отдаёт diff с путём
// «e2e», так что путь защищается шаблоном «e2e».

// Переопределить пресет в секции «Политики» настроек проекта: чекбокс
// «переопределить» в строке, затем контрол строки.
function policyRow(page: Page, label: string) {
  return page.locator('.set-row', { hasText: label })
}

async function overrideSwitch(page: Page, label: string, on: boolean) {
  const row = policyRow(page, label)
  await row.getByRole('checkbox').check()
  const sw = row.locator('.sw')
  const isOn = await sw.evaluate(el => el.classList.contains('on'))
  if (isOn !== on) await sw.click()
}

async function savePolicy(page: Page) {
  await page.locator('.set-row', { hasText: 'создаёт новую версию политики проекта' })
    .getByRole('button', { name: 'Сохранить версию' }).click()
  await expect(page.getByText(/сохранена версия проекта/)).toBeVisible()
}

test('включённый авто-merge мержит задачу без кнопки после review', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const projectName = `AutoMerge ${stamp}`
  const taskTitle = `Авто-merge ${stamp}`

  await createProject(page, projectName)
  await openProjectSettings(page, projectName)
  await expect(policyRow(page, 'Авто-merge после review')).toContainText('наследуется')
  await overrideSwitch(page, 'Авто-merge после review', true)
  await savePolicy(page)
  await expect(policyRow(page, 'Авто-merge после review')).toContainText('переопределено')

  await page.goto('/#/epics')
  await createEpic(page, `Epic automerge ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Review пройден → движок мержит сам: DONE без участия человека.
  await expectNodeStatus(page, taskTitle, 'DONE')
  await expect(page.locator('.epic-meta-row .pct')).toHaveText('100%')
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.locator('.tl')).toContainText('смержен автоматически по политике')
})

test('защищённый путь откладывает merge, деталка показывает причину, кнопка работает', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const projectName = `Protected ${stamp}`
  const taskTitle = `Защищённый путь ${stamp}`

  await createProject(page, projectName)
  await openProjectSettings(page, projectName)
  await overrideSwitch(page, 'Авто-merge после review', true)
  const pathsRow = policyRow(page, 'Пути, требующие человека')
  await pathsRow.getByRole('checkbox').check()
  await pathsRow.getByPlaceholder('infra/**, **/*.sql').fill('e2e')
  await savePolicy(page)

  await page.goto('/#/epics')
  await createEpic(page, `Epic protected ${stamp}`)
  await addTask(page, taskTitle)
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Merge отложен: задача остаётся в REVIEW, деталка показывает причину и путь.
  await expectNodeStatus(page, taskTitle, 'REVIEW')
  await node(page, taskTitle).click()
  const drawer = page.locator('#drawer')
  await expect(drawer.getByRole('heading', { name: 'Merge отложен политикой' })).toBeVisible({ timeout: 30_000 })
  await expect(drawer).toContainText('PR меняет пути, требующие человека')
  await expect(drawer).toContainText('e2e')
  await expect(drawer.locator('.tl')).toContainText('merge отложен политикой')

  // Политика доехала до агента (add-policy-delivery): защищённый путь и
  // версия политики видны в транскрипте coding-сессии.
  const coding = drawer.locator('.sess-row', { hasText: 'CODING' }).first()
  await coding.click()
  await expect(drawer.locator('.sess-term')).toContainText('Учитываю политику', { timeout: 20_000 })
  await expect(drawer.locator('.sess-term')).toContainText('Политика проекта (версия')
  await coding.click()

  // Человек подтверждает merge кнопкой.
  await drawer.getByRole('button', { name: 'Подтвердить merge' }).click()
  await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
})

// Движок политик (add-policy-engine): вкладка «Политики» раздела
// управления показывает режим и состояние движка, а авто-merge проходит
// через него — решения гейта остались прежними.
test('вкладка «Политики» показывает движок, авто-merge работает через него', async ({ page }) => {
  await login(page)
  await page.goto('/#/app-management/policies')
  const engine = page.locator('.budget-pause', { hasText: 'Движок политик' })
  await expect(engine).toBeVisible()
  await expect(engine).toContainText('встроенный')
  await expect(engine).toContainText('отвечает')
  // Состояние установки показывает движок отдельным компонентом.
  await page.goto('/#/app-management/status')
  const grid = page.locator('.status-grid')
  await expect(grid).toContainText('Движок политик')
  await expect(grid).toContainText('встроенный движок')
})
