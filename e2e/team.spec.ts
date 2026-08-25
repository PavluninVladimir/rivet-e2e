import { expect, test } from '@playwright/test'
import { addTask, createEpic, createProject, expectNodeStatus, login, node } from './helpers'

// Представление «Команда» (add-team-visibility): реестр активных сессий с
// последним шагом, поиск по истории, пересечения работ по общим файлам.
// [e2e-slow] держит coding-сессию fake-claude открытой ~6 секунд.

test('реестр показывает активную сессию, поиск находит её после завершения', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const taskTitle = `Команда-${stamp}`

  await createProject(page, `Team ${stamp}`)
  await createEpic(page, `Epic team ${stamp}`)
  await addTask(page, taskTitle, 'Наблюдение за сессией [e2e-slow]')
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Пока сессия держится открытой — реестр показывает её и последний шаг.
  await page.goto('/#/team')
  const row = page.locator('.sess-row', { hasText: taskTitle })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.sess-files', { hasText: 'сейчас:' })).toContainText('Edit e2e-result.txt')

  // Задача доезжает до REVIEW, сессия закрывается — поиск по уникальному
  // слову названия находит сессию с итогом.
  await page.getByPlaceholder('Поиск по истории сессий…').fill(`Команда-${stamp}`)
  // Дождаться именно результатов поиска (не строки реестра): секция «История».
  await expect(page.locator('h3', { hasText: 'История:' })).toBeVisible({ timeout: 10_000 })
  const result = page.locator('.sess-row', { hasText: taskTitle })
  await expect(result.first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.sess-files', { hasText: 'запрос:' }).first()).toBeVisible()
  // Клик ведёт к деталке задачи, транскрипт открывается там.
  await result.first().click()
  await expect(page.locator('#drawer')).toBeVisible()
  await expect(page.locator('#drawer .sess-row').first()).toBeVisible()
})

test('две задачи с общим файлом дают предупреждение о пересечении обеим', async ({ page }) => {
  await login(page)
  const stamp = Date.now()

  await createProject(page, `Overlap ${stamp}`)
  await createEpic(page, `Epic overlap ${stamp}`)
  // Две независимые задачи: два worker'а берут их параллельно, обе правят
  // e2e-result.txt и держат сессии открытыми ([e2e-slow]).
  await addTask(page, `Пересечение A ${stamp}`, 'Общий файл [e2e-slow]')
  await addTask(page, `Пересечение B ${stamp}`, 'Общий файл [e2e-slow]')
  const epicHash = await page.evaluate(() => location.hash)
  await page.getByRole('button', { name: 'Запустить' }).click()

  // Плашки пересечений в реестре «Команды» у обеих сессий.
  await page.goto('/#/team')
  await expect(page.locator('.budget-pause', { hasText: 'Пересечение с task-' }).first())
    .toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.budget-pause')).toHaveCount(2)
  await expect(page.locator('.budget-pause').first()).toContainText('e2e-result.txt')

  // Событие пересечения — в timeline обеих задач, с отметкой о доставке
  // предупреждения самому агенту (add-context-channel: обратный канал).
  await page.goto('/' + epicHash)
  await expectNodeStatus(page, `Пересечение A ${stamp}`, 'REVIEW', 60_000)
  await node(page, `Пересечение A ${stamp}`).click()
  await expect(page.locator('#drawer .tl')).toContainText('пересечение работ с task-')
  await expect(page.locator('#drawer .tl')).toContainText('агент предупреждён')
  await page.locator('#drawer .close').click()
  // Ждём конца coding-стадии B: список сессий деталки читается один раз при
  // открытии, у ещё выполняющейся стадии транскрипта нет.
  await expectNodeStatus(page, `Пересечение B ${stamp}`, 'REVIEW', 60_000)
  await node(page, `Пересечение B ${stamp}`).click()
  await expect(page.locator('#drawer .tl')).toContainText('пересечение работ с task-')
  await expect(page.locator('#drawer .tl')).toContainText('агент предупреждён')

  // Предупреждение доехало до агента: оно видно в транскрипте его сессии
  // (fake-claude печатает полученный обратным каналом текст в поток).
  const coding = page.locator('#drawer .sess-row', { hasText: 'CODING' }).first()
  await expect(coding).toBeVisible()
  await coding.click()
  await expect(page.locator('#drawer .sess-term'))
    .toContainText('Предупреждение Rivet', { timeout: 20_000 })
})
