import { expect, test, type Page } from '@playwright/test'
import { addTask, createProject, login, openSection, waitForEpicAssessment, withFakeArchitect } from './helpers'

// Действия командной палитры (fix-web-console-tails, спека web «Командная
// палитра»): новый Epic, запуск с подтверждением, пауза и возобновление
// Epic'а. Команда находится только по глаголу, поиск по имени Epic'а или
// задачи ведёт к объекту. Начальное выделение не стоит на действии, которое
// меняет состояние. Отказ сервера остаётся в палитре причиной. Необратимых
// действий нет. Задача с маркером [e2e-block] останавливается вопросом
// агента, и Epic остаётся в работе, пока сценарий им управляет.

async function palette(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+KeyK')
  await page.getByPlaceholder(/Задача, Epic/).fill(query)
}

test('палитра создаёт Epic, запускает, ставит на паузу и возобновляет его', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const epicTitle = `Palette epic ${stamp}`
  const taskTitle = `Вопрос агента ${stamp}`

  await createProject(page, `Palette ${stamp}`)
  await openSection(page, 'Обзор')
  const pal = page.locator('#pal')
  const item = (label: string) => pal.locator('.pal-item', { hasText: label })
  const status = page.locator('.epic-title-row .st')

  await withFakeArchitect(page, async (connection, seen) => {
    // Новый Epic: команда без побочного эффекта выделена сразу, Enter
    // открывает список Epic'ов проекта с формой.
    await palette(page, 'Новый Epic')
    await expect(pal.locator('.pal-group').first()).toHaveText('Команды')
    await expect(item('Новый Epic')).toHaveClass(/sel/)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'Новый Epic' })).toBeVisible()
    await expect(page).toHaveURL(/#\/p\/[^/]+\/epics$/)
    await page.getByPlaceholder('Название').fill(epicTitle)
    await page.getByPlaceholder(/Цель/).fill('e2e-прогон палитры')
    await page.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByRole('heading', { name: epicTitle })).toBeVisible()
    await waitForEpicAssessment(page, connection, seen)
  })
  const epicId = /\/epic\/([^/?]+)/.exec(page.url())![1]
  await addTask(page, taskTitle, 'Сценарий палитры [e2e-block]: без ответа человека не продолжать.')

  // Без запроса палитра предлагает действие над открытым Epic'ом.
  await page.keyboard.press('ControlOrMeta+KeyK')
  await expect(item(`Запустить Epic «${epicTitle}»`)).toBeVisible()
  await page.keyboard.press('Escape')

  // Поиск по имени ведёт к Epic'у: действий над ним нет, Enter открывает его.
  await openSection(page, 'Обзор')
  await palette(page, epicTitle)
  await expect(item(epicTitle)).toHaveClass(/sel/)
  await expect(pal.locator('.pal-group', { hasText: 'Команды' })).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`/epic/${epicId}$`))
  await expect(status).toHaveText('PLANNED')
  // По имени задачи открывается её деталка.
  await palette(page, taskTitle)
  await expect(item(taskTitle)).toHaveClass(/sel/)
  await page.keyboard.press('Enter')
  await expect(page.locator('#drawer').getByRole('heading', { name: taskTitle })).toBeVisible()
  await page.locator('#drawer').getByRole('button', { name: '✕' }).click()

  // Запуск: по глаголу команда находится, но не выделена; Enter ничего не
  // делает. Выбор стрелкой взводит подтверждение, второе нажатие сразу за
  // первым не считается, а нажатие через полсекунды запускает Epic.
  await palette(page, 'запуст')
  const start = item(`Запустить Epic «${epicTitle}»`)
  await expect(start).toBeVisible()
  await expect(start).not.toHaveClass(/sel/)
  await page.keyboard.press('Enter')
  await expect(pal).toBeVisible()
  await expect(status).toHaveText('PLANNED')
  await page.keyboard.press('ArrowDown')
  await expect(start).toHaveClass(/sel/)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(start).toContainText('нажмите ещё раз, чтобы подтвердить')
  await expect(pal).toBeVisible()
  await expect(status).toHaveText('PLANNED')
  await page.waitForTimeout(600)
  await page.keyboard.press('Enter')
  await expect(pal).toHaveCount(0)
  await expect(status).toHaveText('RUNNING')

  // Пауза обратима: один клик.
  await palette(page, 'пауза')
  await item(`Пауза Epic «${epicTitle}»`).click()
  await expect(pal).toHaveCount(0)
  await expect(status).toHaveText('PAUSED')
  await expect(page.locator('.epic-actions').getByRole('button', { name: 'Возобновить' })).toBeVisible()

  // Необратимых действий нет: архивирование есть на дашборде, но не в
  // палитре. Сначала список Epic'ов загружается (видно возобновление), потом
  // в том же окне палитры проверяются запросы.
  await palette(page, 'возобнов')
  await expect(item(`Возобновить Epic «${epicTitle}»`)).toBeVisible()
  for (const q of ['Архив', 'отменить', 'удалить']) {
    await page.getByPlaceholder(/Задача, Epic/).fill(q)
    await expect(pal.locator('.pal-group', { hasText: 'Команды' })).toHaveCount(0)
  }
  await page.keyboard.press('Escape')

  // Отказ: Epic возобновили мимо палитры, пока она открыта, и действие
  // устарело. Палитра показывает причину, остаётся открытой, а устаревшее
  // действие пропадает и не оставляет выделения.
  await palette(page, 'возобнов')
  const resume = item(`Возобновить Epic «${epicTitle}»`)
  await expect(resume).toBeVisible()
  expect((await page.request.post(`/api/v1/epics/${epicId}/resume`)).ok()).toBeTruthy()
  await resume.click()
  await expect(pal.getByRole('alert')).toContainText(`Возобновить Epic «${epicTitle}»`)
  await expect(pal).toBeVisible()
  await expect(resume).toHaveCount(0)
  await expect(pal.locator('.pal-item.sel')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(status).toHaveText('RUNNING')

  // Палитра заново предлагает действие по текущему статусу. Epic
  // останавливается, чтобы задача не занимала worker'ы.
  await palette(page, `пауза ${epicTitle}`)
  await expect(item(`Возобновить Epic «${epicTitle}»`)).toHaveCount(0)
  await item(`Пауза Epic «${epicTitle}»`).click()
  await expect(status).toHaveText('PAUSED')
})
