import { expect, test, type Browser, type Page } from '@playwright/test'
import { addTask, createEpic, createProject, login, node, openProject, openSection, projectFromURL, projectSections, sectionItem } from './helpers'
import { ADMIN } from './stand'

// Навигация по проекту (add-project-navigation, спека web «Навигация по
// проекту», «Проект в адресе экранов проекта», «Совместимость старых
// адресов», «Доступность навигации»): вне проекта в боковой панели только
// пункты установки, разделы проекта появляются после входа в проект,
// проект — часть адреса, старые адреса перенаправляются.

const SECTIONS = ['Обзор', 'Исследование', 'Архитектура', 'Epic’и', 'Задачи', 'Цикл разработки',
  'Релизы', 'Инциденты', 'Команда', 'Активность', 'Настройки']

// Подпись пункта: у «Проектов», «Задач» и «Моих шагов» бывает счётчик.
// Стенд общий для всех сценариев, поэтому счётчики от прошлых сценариев
// допускаются.
function label(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\d*$`)
}

function installGroup(page: Page) {
  return page.locator('#sidebar').getByRole('navigation', { name: 'Установка' })
}

// Вход новым пользователем браузера: пустое хранилище, своя сессия.
async function freshPage(browser: Browser, hash: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL })
  const page = await ctx.newPage()
  await page.goto('/' + hash)
  await page.getByPlaceholder('Логин').fill(ADMIN.login)
  await page.getByPlaceholder('Пароль').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Войти' }).click()
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible()
  return page
}

// Имя проекта в блоке: переключатель, если проектов несколько, иначе
// подпись. Один локатор на оба вида: пока список проектов грузится, блок
// показывает «…», и проверка ждёт.
async function expectProjectBlock(page: Page, name: string) {
  await expect(page.locator('.side-project select option:checked, .side-project-name')).toHaveText(name)
}

test('без проекта боковая панель показывает только пункты установки', async ({ page }) => {
  await login(page)
  await page.goto('/#/projects')
  await expect(installGroup(page).getByRole('button')).toHaveText(['Проекты', 'Мои шаги', 'Runner’ы', 'Usage', 'Управление'].map(label))
  await expect(projectSections(page)).toHaveCount(0)
  await expect(page.locator('#sidebar').getByRole('link', { name: /Все проекты/ })).toHaveCount(0)
  await expect(page.locator('#sidebar select')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Путь' })).toHaveText('Проекты')
})

test('вход в проект показывает разделы, пункт установки проект не закрывает', async ({ page }) => {
  await login(page)
  const name = `Nav ${Date.now()}`
  await createProject(page, name)
  const pid = projectFromURL(page.url())

  await openProject(page, name)
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/overview$`))
  await expect(page.getByRole('heading', { name: 'Обзор проекта' })).toBeVisible()
  await expectProjectBlock(page, name)
  await expect(projectSections(page).getByRole('button')).toHaveText(SECTIONS.map(label))
  await expect(sectionItem(page, 'Обзор')).toHaveAttribute('aria-current', 'page')
  // Пункты установки ниже, без «Проектов»: их заменяет «← Все проекты».
  await expect(installGroup(page).getByRole('button')).toHaveText(['Мои шаги', 'Runner’ы', 'Usage', 'Управление'].map(label))

  // Раздел с клавиатуры: фокус на пункте, Enter открывает.
  await sectionItem(page, 'Epic’и').focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/epics$`))
  await expect(sectionItem(page, 'Epic’и')).toHaveAttribute('aria-current', 'page')

  // Крошки «Проекты / проект / раздел», имя проекта ведёт в обзор.
  const crumbs = page.getByRole('navigation', { name: 'Путь' })
  await expect(crumbs.getByRole('link')).toHaveText(['Проекты', name])
  await expect(crumbs.locator('b')).toHaveText('Epic’и')
  await crumbs.getByRole('link', { name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/overview$`))

  // Runner'ы установки из проекта: блок и разделы проекта остаются.
  await installGroup(page).getByRole('button', { name: 'Runner’ы' }).click()
  await expect(page.getByRole('heading', { name: 'Runner’ы' })).toBeVisible()
  await expect(page).toHaveURL(/#\/runners$/)
  await expect(projectSections(page)).toBeVisible()
  await expectProjectBlock(page, name)
})

test('переключение проекта на дашборде Epic’а открывает Epic’и другого проекта', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const alpha = `NavAlpha ${stamp}`, beta = `NavBeta ${stamp}`
  await createProject(page, alpha)
  const alphaId = projectFromURL(page.url())
  await createProject(page, beta)
  const betaId = projectFromURL(page.url())
  await createEpic(page, `Epic switch ${stamp}`)
  await expect(page).toHaveURL(/\/epic\/[^/]+$/)
  const epicId = /\/epic\/([^/?]+)$/.exec(page.url())![1]
  const taskTitle = `Задача switch ${stamp}`
  await addTask(page, taskTitle)
  await node(page, taskTitle).click()
  await expect(page).toHaveURL(/\/task\/[^/]+$/)
  const taskId = /\/task\/([^/?]+)$/.exec(page.url())![1]

  await page.locator('#sidebar').getByLabel('Проект', { exact: true }).selectOption(alphaId)
  await expect(page).toHaveURL(new RegExp(`#/p/${alphaId}/epics$`))
  await expect(page.getByRole('heading', { name: 'Epic’и', exact: true })).toBeVisible()
  await expectProjectBlock(page, alpha)

  // Старые ссылки на Epic «Beta» и его задачу, когда последним открыт
  // «Alpha»: проект берётся из самого Epic’а.
  await page.goto(`/#/epic/${epicId}`)
  await expect(page).toHaveURL(new RegExp(`#/p/${betaId}/epic/${epicId}$`))
  await expect(page.getByRole('heading', { name: `Epic switch ${stamp}` })).toBeVisible()
  await expectProjectBlock(page, beta)
  // На дашборде «Epic’и» — родитель экрана, а не сама страница.
  await expect(sectionItem(page, 'Epic’и')).toHaveAttribute('aria-current', 'true')
  // Снова последним открыт «Alpha»: проект задачи должен прийти из Epic’а.
  await page.locator('#sidebar').getByLabel('Проект', { exact: true }).selectOption(alphaId)
  await expect(page).toHaveURL(new RegExp(`#/p/${alphaId}/epics$`))
  await expectProjectBlock(page, alpha)
  await page.goto(`/#/epic/${epicId}/task/${taskId}`)
  await expect(page).toHaveURL(new RegExp(`#/p/${betaId}/epic/${epicId}/task/${taskId}$`))
  await expect(page.locator('#drawer').getByRole('heading', { name: taskTitle })).toBeVisible()
  await expectProjectBlock(page, beta)
})

test('переключатель проекта с клавиатуры: стрелки выбирают, Enter переходит, Escape отменяет', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const alpha = `NavKeyA ${stamp}`, beta = `NavKeyB ${stamp}`
  await createProject(page, alpha)
  const alphaId = projectFromURL(page.url())
  await createProject(page, beta)
  const betaId = projectFromURL(page.url())
  // Список проектов уже знает «Beta»: иначе первой опцией стоит заглушка.
  await expectProjectBlock(page, beta)
  // Узкий экран: Escape в переключателе не должен закрыть панель.
  await page.setViewportSize({ width: 390, height: 800 })
  const menu = page.getByRole('button', { name: 'Меню' })
  await menu.click()
  const sw = page.locator('#sidebar').getByLabel('Проект', { exact: true })
  await sw.focus()

  if (process.platform === 'darwin') {
    // macOS: стрелка открывает список, а не меняет значение. Headless
    // Chromium этим списком с клавиатуры не управляет, поэтому здесь
    // проверяется только, что стрелка не выбирает проект и не переходит.
    // Отменять нечего, и Escape по общему правилу закрывает панель. Выбор
    // из списка — тот же change, что у selectOption в сценарии
    // переключения на дашборде Epic’а. Ветка ниже идёт в CI на Linux.
    await page.keyboard.press('ArrowUp')
    await expect(sw).toHaveValue(betaId)
    await expect(page).toHaveURL(new RegExp(`#/p/${betaId}/epics$`))
    await page.keyboard.press('Escape')
    await expect(menu).toHaveAttribute('aria-expanded', 'false')
    await expect(menu).toBeFocused()
    return
  }

  // Windows и Linux: стрелка на закрытом списке только меняет значение.
  await page.keyboard.press('ArrowUp')
  await expect(sw).toHaveValue(alphaId)
  await expect(page).toHaveURL(new RegExp(`#/p/${betaId}/epics$`))
  // Escape отменяет просмотр, панель остаётся открытой.
  await page.keyboard.press('Escape')
  await expect(sw).toHaveValue(betaId)
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  // Поиск по первой букве — тоже просмотр: значение меняется, перехода нет.
  await page.keyboard.press('n')
  await expect(sw).not.toHaveValue(betaId)
  await expect(page).toHaveURL(new RegExp(`#/p/${betaId}/epics$`))
  await page.keyboard.press('Escape')
  await expect(sw).toHaveValue(betaId)
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  // Enter переходит в выбранный проект.
  await page.keyboard.press('ArrowUp')
  await expect(sw).toHaveValue(alphaId)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#/p/${alphaId}/epics$`))
})

test('«← Все проекты» скрывает разделы проекта', async ({ page }) => {
  await login(page)
  const name = `NavBack ${Date.now()}`
  await createProject(page, name)
  await expect(projectSections(page)).toBeVisible()

  await page.locator('#sidebar').getByRole('link', { name: /Все проекты/ }).click()
  await expect(page).toHaveURL(/#\/projects$/)
  await expect(page.getByRole('heading', { name: 'Проекты', exact: true })).toBeVisible()
  await expect(projectSections(page)).toHaveCount(0)
  await expect(page.locator('#sidebar select')).toHaveCount(0)
  await expect(installGroup(page).getByRole('button').first()).toHaveText(label('Проекты'))

  // Вход в проект из палитры.
  const pid = projectFromURL((await page.locator('tr', { hasText: name }).getByRole('link').getAttribute('href'))!)
  await page.keyboard.press('ControlOrMeta+KeyK')
  await page.getByPlaceholder(/Задача, Epic/).fill(name)
  await expect(page.locator('.pal-item', { hasText: `Проект: ${name}` })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/overview$`))
  await expect(projectSections(page)).toBeVisible()
  await expectProjectBlock(page, name)
})

test('ссылка #/p/<проект>/epics открывает проект, чужой проект ведёт к «Проектам»', async ({ page, browser }) => {
  await login(page)
  const name = `NavLink ${Date.now()}`
  await createProject(page, name)
  const pid = projectFromURL(page.url())

  // Ссылка в новом браузере: экран входа, затем запрошенный адрес.
  const other = await freshPage(browser, `#/p/${pid}/epics`)
  try {
    await expect(other).toHaveURL(new RegExp(`#/p/${pid}/epics$`))
    await expect(other.getByRole('heading', { name: 'Epic’и', exact: true })).toBeVisible()
    await expectProjectBlock(other, name)
    await expect(sectionItem(other, 'Epic’и')).toHaveAttribute('aria-current', 'page')

    // Адрес проекта без раздела заменяется каноническим адресом обзора.
    await other.goto(`/#/p/${pid}`)
    await expect(other).toHaveURL(new RegExp(`#/p/${pid}/overview$`))
    // Перезагрузка на вкладке архитектуры открывает её же в том же проекте.
    await other.goto(`/#/p/${pid}/architecture/c4`)
    await other.reload()
    await expect(other).toHaveURL(new RegExp(`#/p/${pid}/architecture/c4$`))
    await expect(sectionItem(other, 'Архитектура')).toHaveAttribute('aria-current', 'page')
    await expectProjectBlock(other, name)

    // Проекта нет среди доступных: сообщение и «Проекты».
    await other.goto('/#/p/no-such-project/epics')
    await expect(other.getByRole('alert')).toContainText('не найден или у вас нет к нему доступа')
    await expect(other).toHaveURL(/#\/projects$/)
    await expect(projectSections(other)).toHaveCount(0)
  } finally {
    await other.context().close()
  }
})

test('старый адрес #/epics перенаправляется в последний открытый проект', async ({ page, browser }) => {
  await login(page)
  const name = `NavOld ${Date.now()}`
  await createProject(page, name)
  const pid = projectFromURL(page.url())
  await openProject(page, name)

  await page.goto('/#/epics')
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/epics$`))
  await expect(page.getByRole('heading', { name: 'Epic’и', exact: true })).toBeVisible()
  // Замена без записи в истории: «Назад» ведёт на обзор, а не на #/epics.
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/overview$`))

  // Старый адрес с проектом сохраняет свой проект и вкладку.
  await page.goto(`/#/project/${pid}/settings/members`)
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/settings/members$`))
  await expect(page.getByRole('heading', { name: 'Участники' })).toBeVisible()

  // В браузере, где проект ещё не открывали, старый адрес ведёт к «Проектам».
  const fresh = await freshPage(browser, '#/architecture/c4')
  try {
    await expect(fresh).toHaveURL(/#\/projects$/)
    await expect(projectSections(fresh)).toHaveCount(0)
    // Последний проект больше недоступен: «Проекты» без сообщения, а
    // сохранённый проект стирается.
    await fresh.evaluate(() => localStorage.setItem('rivet.lastProject', 'gone-project'))
    await fresh.goto('/#/tasks')
    await expect(fresh).toHaveURL(/#\/projects$/)
    await expect(fresh.getByRole('alert')).toHaveCount(0)
    expect(await fresh.evaluate(() => localStorage.getItem('rivet.lastProject'))).toBeNull()
  } finally {
    await fresh.context().close()
  }
})

test('на узком экране меню открывается кнопкой и закрывается выбором и Escape', async ({ page }) => {
  await login(page)
  const name = `NavNarrow ${Date.now()}`
  await createProject(page, name)
  const pid = projectFromURL(page.url())
  // Узкое окно после входа: «Выйти» тоже живёт в боковой панели.
  await page.setViewportSize({ width: 390, height: 800 })

  const menu = page.getByRole('button', { name: 'Меню' })
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(projectSections(page)).toBeHidden()
  await menu.click()
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await expect(projectSections(page)).toBeVisible()
  // Открытая панель забирает фокус.
  await expect(page.locator('#sidebar :focus')).toHaveCount(1)
  await sectionItem(page, 'Задачи').click()
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/tasks$`))
  await expect(projectSections(page)).toBeHidden()
  // Фокус уходит к экрану, а не остаётся в скрытой панели.
  await expect(page.locator('#viewport')).toBeFocused()

  // Выбор текущего пункта тоже закрывает панель.
  await menu.click()
  await sectionItem(page, 'Задачи').click()
  await expect(projectSections(page)).toBeHidden()

  // Escape закрывает панель и возвращает фокус на кнопку «Меню».
  await menu.click()
  await expect(projectSections(page)).toBeVisible()
  await expect(page.locator('#sidebar :focus')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(projectSections(page)).toBeHidden()
  await expect(menu).toBeFocused()
  // Без горизонтальной прокрутки.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // Меню открыто, окно стало широким (поворот телефона): панель на месте,
  // экран снова кликабелен.
  await menu.click()
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.locator('#viewport')).not.toHaveAttribute('inert')
  await page.getByRole('navigation', { name: 'Путь' }).getByRole('link', { name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/p/${pid}/overview$`))
  await expect(page.getByRole('heading', { name: 'Обзор проекта' })).toBeVisible()
})

test('эскалация в другом проекте появляется у «← Все проекты» без перехода к «Проектам»', async ({ page, context }) => {
  test.setTimeout(240_000)
  await login(page)
  const stamp = Date.now()
  await createProject(page, `NavLiveA ${stamp}`)
  const alphaId = projectFromURL(page.url())
  await openSection(page, 'Задачи')
  const back = page.locator('.side-back .count')

  // Во второй вкладке задача проекта «Beta» уходит в эскалацию.
  const other = await context.newPage()
  let betaId = ''
  try {
    await createProject(other, `NavLiveB ${stamp}`)
    betaId = projectFromURL(other.url())
    await createEpic(other, `Epic live ${stamp}`)
    await addTask(other, `Эскалация live ${stamp}`, 'Сценарий эскалации [e2e-block]: без ответа человека не продолжать.')
    await other.getByRole('button', { name: 'Запустить' }).click()
    await expect(other.locator('.att-card', { hasText: 'BLOCKED' })).toBeVisible({ timeout: 90_000 })
  } finally {
    await other.close()
  }

  // Вкладка «Alpha» не получает событий «Beta»: счётчик обновляет опрос,
  // по спеке не позже чем через минуту. Стенд общий, и задачи прошлых
  // сценариев ещё могут менять эскалации, поэтому счётчик сверяется с API:
  // он равен числу эскалаций вне «Alpha», и среди них есть эскалация «Beta».
  await expect.poll(async () => {
    const list: Array<{ ProjectID: string }> = (await (await page.request.get('/api/v1/attention')).json()) ?? []
    const outside = list.filter((a) => a.ProjectID !== alphaId)
    const shown = (await back.count()) ? Number(await back.textContent()) : 0
    return outside.some((a) => a.ProjectID === betaId) && shown === outside.length
  }, { timeout: 60_000 }).toBe(true)
  await expect(sectionItem(page, 'Задачи').locator('.count')).toHaveCount(0)
})
