import { expect, test, type Page } from '@playwright/test'
import { addInterviewText, createProject, login, openSection, withFakeModel } from './helpers'

// Цикл разработки (add-sdlc-cycle, fix-cycle-phase-data): фазы
// «Исследование» и «Архитектура» показывают данные проекта, а не «нет
// данных». Проект подключён к репозиторию стенда e2e/arch: на его основной
// ветке лежит описание архитектуры демо-CRM, снимок строится при
// подключении. Исследование наполняется интервью и анализом Аналитика на
// fake-llm.

function phaseNode(page: Page, id: string) {
  return page.locator(`.cycle-ring [data-phase-node="${id}"]`)
}

function phasePanel(page: Page, title: string) {
  return page.getByRole('complementary', { name: `Фаза ${title}` })
}

async function openCycle(page: Page) {
  await openSection(page, 'Цикл разработки')
  await expect(page.getByRole('heading', { name: 'Цикл разработки', exact: true })).toBeVisible()
}

test('фазы «Исследование» и «Архитектура» показывают интервью, анализ, снимок и решения ADR', async ({ page }) => {
  test.setTimeout(180_000)
  await login(page)
  const stamp = Date.now()
  await createProject(page, `Cycle ${stamp}`, 'e2e/arch')
  await openCycle(page)

  // Интервью ещё нет: исследование без данных с подсказкой.
  const discovery = phaseNode(page, 'discovery')
  await expect(discovery).toHaveAttribute('aria-label', /нет данных/)

  // Снимок архитектуры строится при подключении проекта, экран цикла
  // перечитывает агрегат по событию снимка без перезагрузки.
  const architecture = phaseNode(page, 'architecture')
  await expect(architecture).not.toHaveAttribute('aria-label', /нет данных/, { timeout: 30_000 })
  await expect(architecture).not.toContainText('нет данных')
  await architecture.click()
  const archPanel = phasePanel(page, 'Архитектура')
  await expect(archPanel.getByRole('button', { name: /Снимок архитектуры · CRM/ })).toBeVisible()
  await expect(archPanel.getByRole('button', { name: /ADR-0002 · Node\.js без внешних зависимостей/ })).toBeVisible()
  await expect(archPanel.getByRole('link', { name: 'Архитектура →' })).toBeVisible()
  // Решение ведёт на вкладку решений «Архитектуры» с выбранным номером и
  // реестром всех статусов: заменённое решение тоже видно слева.
  await archPanel.getByRole('button', { name: /ADR-0001 · Хранилище в JSON-файле/ }).click()
  await expect(page).toHaveURL(/\/architecture\/decisions\/1\?status=all$/)
  await expect(page.locator('article.arch-decision[data-adr="1"]')).toBeVisible()

  // Интервью: фаза исследования получает материал, который ждёт анализа.
  const title = `Менеджер ${stamp}`
  await openSection(page, 'Исследование')
  await addInterviewText(page, title, 'Менеджер по продажам', [
    `**И:** Расскажите о своей работе. Интервью ${stamp}.`,
    '**Р:** Сделки веду в таблице, статусы теряются.',
    '**И:** А что ещё?',
    '**Р:** Не видно, на каком этапе сделка.',
  ].join('\n') + '\n')
  await openCycle(page)
  await expect(discovery).toHaveAttribute('aria-label', /в работе 0, ждут 1, нужен человек 0/)
  await discovery.click()
  const discPanel = phasePanel(page, 'Исследование')
  await expect(discPanel.getByRole('button', { name: new RegExp(`ждёт.*Интервью · ${title}`) })).toBeVisible()
  await expect(discPanel.locator('.dw-sec', { has: page.getByRole('heading', { name: 'Материалы' }) })
    .getByRole('button', { name: new RegExp(`интервью\\s*${title}`) })).toBeVisible()

  // Анализ Аналитика: интервью учтено, бэклог ждёт утверждения владельцем,
  // потребности — артефакты фазы.
  await withFakeModel(page, stamp, async () => {
    await openSection(page, 'Исследование')
    await page.getByRole('button', { name: 'Запустить анализ' }).click()
    await expect(page.locator('.disc-status .st').first()).toHaveText('готова', { timeout: 60_000 })
  })
  await openCycle(page)
  await expect(discovery).toHaveAttribute('aria-label', /в работе 0, ждут 0, нужен человек 1/)
  await discovery.click()
  await expect(discPanel.getByRole('button', { name: /нужен человек.*Бэклог исследования · версия 1 ждёт утверждения/ })).toBeVisible()
  await expect(discPanel.locator('.cp-items .chip', { hasText: 'потребность' }).first()).toBeVisible()
  await expect(discPanel.locator('.cyc-card', { hasText: 'Вера' })).toBeVisible()
})
