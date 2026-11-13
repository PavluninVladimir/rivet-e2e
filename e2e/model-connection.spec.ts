import { expect, test } from '@playwright/test'
import { addTask, createAssessedEpic, createProject, expectNodeStatus, login, node } from './helpers'
import { LLM_URL } from './stand'

// Модель без рабочего подключения (fix-agent-without-connection): стадия
// агента Rivet не назначается, пока у модели участника нет ключа, задача
// ждёт с понятной причиной и не эскалируется. Администратор исправляет
// подключение, и планировщик сам продолжает задачу.
test('стадия ждёт подключения к модели и продолжает сама', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const conn = `e2e-nokey-${stamp}`
  const model = `nokey-model-${stamp}`
  const taskTitle = `Без ключа ${stamp}`

  // Подключение без ключа на чужой машине: runner без ключа туда не пойдёт.
  let resp = await page.request.put(`/api/v1/system/connections/${conn}`, {
    data: { name: 'E2E без ключа', kind: 'local', api: 'openai', base_url: 'http://nokey.invalid/v1' },
  })
  expect(resp.ok()).toBeTruthy()
  resp = await page.request.put(`/api/v1/system/connections/${conn}/models`, {
    data: { models: [{ id: model, label: model, source: 'manual' }] },
  })
  expect(resp.ok()).toBeTruthy()

  try {
    await createProject(page, `No key ${stamp}`)
    const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
    const projectId = projects.find((p) => p.Name === `No key ${stamp}`)?.ID
    expect(projectId).toBeTruthy()
    resp = await page.request.put(`/api/v1/projects/${projectId}/policy`, {
      data: {
        process: {
          steps: [
            { id: 'code', kind: 'code', participants: [{ agent: { kind: 'rivet', model } }] },
            { id: 'test', kind: 'test', participants: [{ agent: {} }] },
            { id: 'review', kind: 'review', participants: [{ agent: {} }] },
            { id: 'merge', kind: 'merge' },
          ],
        },
      },
    })
    expect(resp.ok()).toBeTruthy()

    await createAssessedEpic(page, `Epic no key ${stamp}`)
    await addTask(page, taskTitle)
    await page.getByRole('button', { name: 'Запустить' }).click()

    // Задача ждёт с причиной в деталке, эскалации нет.
    await node(page, taskTitle).click()
    const drawer = page.locator('#drawer')
    const reason = `у подключения ${conn} к модели ${model} нет ключа, а без ключа runner обращается только к серверу на своей машине`
    await expect(drawer.locator('[data-wait]')).toContainText(reason, { timeout: 60_000 })
    await expect(drawer.locator('.st')).toHaveText('READY')
    const attention: Array<{ ProjectID: string }> | null = await (await page.request.get('/api/v1/attention')).json()
    expect((attention ?? []).filter((a) => a.ProjectID === projectId)).toHaveLength(0)

    // Подключение исправили: сервер на этой машине и ключ. Задача идёт сама.
    resp = await page.request.put(`/api/v1/system/connections/${conn}`, {
      data: { name: 'E2E без ключа', kind: 'local', api: 'openai', base_url: LLM_URL, key: 'fake-key' },
    })
    expect(resp.ok()).toBeTruthy()
    await expect(drawer.getByText('review пройден — ожидание подтверждения merge')).toBeVisible({ timeout: 90_000 })
    await drawer.getByRole('button', { name: 'Merge' }).click()
    await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
    await expectNodeStatus(page, taskTitle, 'DONE')
  } finally {
    // Каталог стенда после сценария прежний, даже если сценарий упал.
    // Отказ удаления не проверяется: он заслонил бы исходную ошибку.
    await page.request.delete(`/api/v1/system/connections/${conn}`).catch(() => undefined)
  }
})

// Провайдер отозвал ключ, а в каталоге подключение ещё рабочее: стадия
// получает 401, control plane сам проверяет ключ и переводит подключение в
// invalid. Эскалация одна на перевод, вторая задача на том же ключе ждёт
// подключения. После замены ключа ждущая задача идёт сама, эскалированная
// идёт после «Повторить». Локальный адрес control plane не проверяет (это
// машина runner'а), поэтому подключение смотрит на fake-llm стенда через
// 0.0.0.0: соединение доходит до loopback, но адрес не считается локальным.
test('отозванный ключ: подключение invalid, одна эскалация, задачи идут после замены ключа', async ({ page }) => {
  await login(page)
  const stamp = Date.now()
  const conn = `e2e-revoked-${stamp}`
  const model = `revoked-model-${stamp}`
  const key = `fake-key-revoked-${stamp}`
  const baseURL = LLM_URL.replace('localhost', '0.0.0.0')
  const titles = [`Отозванный ключ A ${stamp}`, `Отозванный ключ B ${stamp}`]
  const connState = async () => {
    const list: Array<{ id: string; state: string }> = await (await page.request.get('/api/v1/system/connections')).json()
    return list.find((c) => c.id === conn)?.state
  }

  let resp = await page.request.put(`/api/v1/system/connections/${conn}`, {
    data: { name: 'E2E отзыв ключа', kind: 'local', api: 'openai', base_url: baseURL, key },
  })
  expect(resp.ok()).toBeTruthy()
  expect(await connState()).toBe('ok')
  resp = await page.request.put(`/api/v1/system/connections/${conn}/models`, {
    data: { models: [{ id: model, label: model, source: 'manual' }] },
  })
  expect(resp.ok()).toBeTruthy()

  try {
    await createProject(page, `Revoked ${stamp}`)
    const projects: Array<{ ID: string; Name: string }> = await (await page.request.get('/api/v1/projects')).json()
    const projectId = projects.find((p) => p.Name === `Revoked ${stamp}`)?.ID
    expect(projectId).toBeTruthy()
    resp = await page.request.put(`/api/v1/projects/${projectId}/policy`, {
      data: {
        process: {
          steps: [
            { id: 'code', kind: 'code', participants: [{ agent: { kind: 'rivet', model } }] },
            { id: 'test', kind: 'test', participants: [{ agent: {} }] },
            { id: 'review', kind: 'review', participants: [{ agent: {} }] },
            { id: 'merge', kind: 'merge' },
          ],
        },
      },
    })
    expect(resp.ok()).toBeTruthy()
    const projectAttention = async () => {
      const list: Array<{ ProjectID: string; TaskID: string; Reason: string; Message: string }> | null =
        await (await page.request.get('/api/v1/attention')).json()
      return (list ?? []).filter((a) => a.ProjectID === projectId)
    }

    await createAssessedEpic(page, `Epic revoked ${stamp}`)
    for (const title of titles) await addTask(page, title)
    // Ключ отозван у провайдера, в каталоге подключение по-прежнему ok.
    resp = await page.request.post(new URL('/_e2e/revoke', LLM_URL).toString(), { data: { key } })
    expect(resp.status()).toBe(204)
    await page.getByRole('button', { name: 'Запустить' }).click()

    await expect.poll(connState, { timeout: 90_000 }).toBe('invalid')
    await expect.poll(async () => (await projectAttention()).length, { timeout: 60_000 }).toBe(1)
    const [att] = await projectAttention()
    expect(att.Reason).toBe('MODEL_CONNECTION')
    expect(att.Message).toContain(`провайдер отклонил ключ подключения ${conn}`)
    expect(att.Message).toContain('проверка control plane подтвердила отказ')
    const failed: string = (await (await page.request.get(`/api/v1/tasks/${att.TaskID}`)).json()).task.Title
    const waiting = titles.find((t) => t !== failed) ?? ''
    expect(titles).toContain(failed)

    // Вторая задача ждёт подключения без своей эскалации: на своём шаге,
    // если успела получить 401 (возврат на шаг), или до первого назначения.
    await node(page, waiting).click()
    const drawer = page.locator('#drawer')
    await expect(drawer.locator('[data-wait]')).toContainText(`провайдер отклонил ключ подключения ${conn}`, { timeout: 60_000 })
    await expect(drawer.locator('.st')).toHaveText(/^(READY|RUNNING)$/)
    expect(await projectAttention()).toHaveLength(1)

    // Ключ заменили: ждущая задача идёт сама.
    resp = await page.request.put(`/api/v1/system/connections/${conn}`, {
      data: { name: 'E2E отзыв ключа', kind: 'local', api: 'openai', base_url: baseURL, key: 'fake-key' },
    })
    expect(resp.ok()).toBeTruthy()
    expect(await connState()).toBe('ok')
    await expect(drawer.getByText('review пройден — ожидание подтверждения merge')).toBeVisible({ timeout: 90_000 })
    await drawer.getByRole('button', { name: 'Merge' }).click()
    await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })

    // Эскалированная задача после «Повторить» идёт с тем же шагом.
    resp = await page.request.post(`/api/v1/tasks/${att.TaskID}/retry`)
    expect(resp.ok()).toBeTruthy()
    await node(page, failed).click()
    await expect(drawer.getByText('review пройден — ожидание подтверждения merge')).toBeVisible({ timeout: 90_000 })
    await drawer.getByRole('button', { name: 'Merge' }).click()
    await expect(drawer.locator('.st')).toHaveText('DONE', { timeout: 30_000 })
    await expectNodeStatus(page, failed, 'DONE')
    await expectNodeStatus(page, waiting, 'DONE')
  } finally {
    await page.request.delete(`/api/v1/system/connections/${conn}`).catch(() => undefined)
  }
})
