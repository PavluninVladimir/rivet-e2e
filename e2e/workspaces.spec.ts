import { expect, test, type Page, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STAND } from './stand';
import { login, createProject, projectFromURL } from './helpers';
import { workspaceProvider, type Provider } from './fixtures/workspace-provider';
let provider: Provider;
let previousPlanner: any;
let evaWasEnabled: string | null = null;
function sql(q: string): string {
    const database = process.env.E2E_WORKSPACES_DATABASE ?? readFileSync(path.join(STAND.dir, 'database-name'), 'utf8').trim();
    if (!/^rivet_e2e_\d+_\d+$/.test(database) || !['8281', '19381'].includes(STAND.httpPort))
        throw Error('A separately named QA database and port19381 are required for synthetic fixtures');
    const base = new URL(process.env.RIVET_DATABASE_URL ?? 'postgres://rivet:rivet@127.0.0.1:5432/rivet?sslmode=disable');
    if (!spawnSync('psql', ['--version']).error)
        return execFileSync('psql', ['-At', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8', env: { ...process.env, PGHOST: base.hostname, PGPORT: base.port || '5432', PGUSER: decodeURIComponent(base.username), PGPASSWORD: decodeURIComponent(base.password), PGDATABASE: database } }).trim();
    return execFileSync('docker', ['exec', '-i', process.env.E2E_POSTGRES_CONTAINER ?? 'rivet-service-postgres-1', 'psql', '-U', 'rivet', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8' }).trim();
}
async function ok(r: APIResponse, status?: number) {
    if (status === undefined)
        expect(r.ok(), await r.text()).toBeTruthy();
    else
        expect(r.status(), await r.text()).toBe(status);
    return r.json();
}
const key = () => ({ 'Idempotency-Key': randomUUID() });
async function project(page: Page, label: string) { await createProject(page, `QA ${label} ${Date.now()}`); return projectFromURL(page.url()); }
async function config(page: Page, p: string) { const v = await ok(await page.request.get(`/api/v1/projects/${p}/assistant`)); return ok(await page.request.patch(`/api/v1/projects/${p}/assistant/config`, { data: { expected_revision: v.config.revision, enabled: false, connection_id: 'qa-workspaces', model_id: 'qa-model', limits: { max_run_actions: 3, max_run_seconds: 30, max_input_tokens: 100000, max_output_tokens: 4000, daily_tokens: 1000000, daily_cost_usd: 1 } } })); }
async function seedFailed(page: Page, p: string) { const epic = randomUUID(); sql(`INSERT INTO epics(id,project_id,title,goal,status,kind) VALUES('${epic}','${p}','QA maintenance','Synthetic retry fixture','paused','maintenance');`); const task = await ok(await page.request.post(`/api/v1/epics/${epic}/tasks`, { data: { title: 'QA timeout task', description: 'Synthetic timeout fixture' } }), 201); sql(`UPDATE tasks SET status='failed',step_id='code',block_reason='timeout',attempt_used=3 WHERE id='${task.ID}';`); return { epic, task: task.ID }; }
async function submissionEffects(page: Page, p: string) {
    const history = await ok(await page.request.get(`/api/v1/projects/${p}/assistant/messages?limit=100`));
    expect(history.next_cursor, 'the fixture must observe its complete submission history').toBeNull();
    const runIDs = [...new Set<string>(history.items.map((m: any) => m.run_id).filter(Boolean))].sort();
    const runs = await Promise.all(runIDs.map(async id => {
        const result = await ok(await page.request.get(`/api/v1/projects/${p}/assistant/runs/${id}`));
        return { id: result.run.id, actions: result.actions.map((a: any) => a.id).sort() };
    }));
    return { messages: history.items.map((m: any) => ({ id: m.id, run_id: m.run_id })).sort((a: any, b: any) => a.id.localeCompare(b.id)), runs };
}
async function send(page: Page, p: string, text: string, intent = 'question') {
    // Positive clients may explicitly refresh a rejected CAS snapshot. Runner,
    // model and domain facts can change while a fresh fixture is settling. This
    // never retries an accepted run, guard denial or the explicit negative409.
    for (let attempt = 0; attempt < 3; attempt++) {
        const effects = await submissionEffects(page, p);
        const calls = provider.assistantCalls;
        const view = await ok(await page.request.get(`/api/v1/projects/${p}/assistant`));
        const body = { text, intent, expected_snapshot_revision: view.snapshot.revision };
        const response = await page.request.post(`/api/v1/projects/${p}/assistant/messages`, { headers: key(), data: body });
        if (response.status() === 202) {
            const accepted = await ok(response, 202);
            expect(accepted.message.run_id).toBe(accepted.run.id);
            expect(effects.runs.map(r => r.id)).not.toContain(accepted.run.id);
            return accepted;
        }
        const rejected = await response.json();
        if (response.status() !== 409 || rejected.error?.code !== 'stale_revision')
            return ok(response, 202);
        const refreshed = await ok(await page.request.get(`/api/v1/projects/${p}/assistant`));
        expect(refreshed.active_run?.id ?? null, 'rejected CAS must not start an active run').toBe(view.active_run?.id ?? null);
        expect(await submissionEffects(page, p), 'rejected CAS must not create messages, runs or actions').toEqual(effects);
        expect(provider.assistantCalls, 'rejected CAS must not invoke the model').toBe(calls);
        const beforeFacts = new Map(view.snapshot.facts.map((f: any) => [f.id, JSON.stringify(f.value)]));
        const afterFacts = new Map(refreshed.snapshot.facts.map((f: any) => [f.id, JSON.stringify(f.value)]));
        const changed = [...new Set([...beforeFacts.keys(), ...afterFacts.keys()])].filter(id => beforeFacts.get(id) !== afterFacts.get(id));
        await test.info().attach(`rejected-snapshot-refresh-${attempt + 1}`, { contentType: 'application/json', body: JSON.stringify({ attempt: attempt + 1, rejected_code: rejected.error.code, before_revision: view.snapshot.revision, after_revision: refreshed.snapshot.revision, before_cursor: view.snapshot.event_cursor, after_cursor: refreshed.snapshot.event_cursor, changed_fact_ids: changed, messages: effects.messages.length, runs: effects.runs.length, actions: effects.runs.reduce((n, r) => n + r.actions.length, 0), model_calls_unchanged: true }) });
    }
    throw new Error('Positive fixture snapshot changed before submission on all 3 attempts; no run was accepted');
}
async function finished(page: Page, p: string, id: string) { let result: any; await expect.poll(async () => { result = await ok(await page.request.get(`/api/v1/projects/${p}/assistant/runs/${id}`)); return result.run.status; }, { timeout: 20000 }).not.toMatch(/^(queued|running)$/); return result; }
const normalText = '**Р:** Договоры хранятся в системе предприятия.\n**Р:** Реквизиты приходится переписывать вручную.\n**Р:** Пользователь проверяет значения перед сохранением.';
async function material(page: Page, p: string, title: string, text = normalText) { return ok(await page.request.post(`/api/v1/projects/${p}/discovery/interviews`, { data: { title, text, respondent_role: 'Оператор' } }), 201); }
async function analyse(page: Page, p: string) { const run = await ok(await page.request.post(`/api/v1/projects/${p}/discovery/analyses`, { data: {} }), 202); let result: any; await expect.poll(async () => { result = await ok(await page.request.get(`/api/v1/projects/${p}/discovery/analyses/${run.id}`)); return result.status; }, { timeout: 30000 }).not.toBe('running'); expect(result.status, result.error).toBe('ready'); return result; }
test.beforeAll(async () => {
    await expect.poll(async () => { try {
        return (await fetch(`http://127.0.0.1:${STAND.httpPort}/api/v1/health`)).ok;
    }
    catch {
        return false;
    } }, { timeout: 30000 }).toBe(true);
    provider = await workspaceProvider(Number(STAND.httpPort) + 5, `http://127.0.0.1:${STAND.llmPort}`);
});
test.afterAll(async () => { await provider?.close(); });
test.beforeEach(async ({ page }) => {
    await login(page);
    previousPlanner = await ok(await page.request.get('/api/v1/system/planner'));
    await ok(await page.request.put('/api/v1/system/connections/qa-workspaces', { data: { name: 'QA deterministic models', kind: 'local', api: 'openai', base_url: `http://127.0.0.1:${provider.port}/v1`, key: 'qa-key' } }));
    await ok(await page.request.post('/api/v1/system/connections/qa-workspaces/discover'));
    await ok(await page.request.put('/api/v1/system/connections/qa-workspaces/models', { data: { models: [{ id: 'qa-model', label: 'QA deterministic', input_price: 0, output_price: 0, source: 'manual' }] } }));
    await ok(await page.request.put('/api/v1/system/planner', { data: { connection_id: 'qa-workspaces', model: 'qa-model' } }));
});
test.afterEach(async ({ page }) => {
    if (evaWasEnabled !== null) {
        sql(`UPDATE team_agents SET enabled=${evaWasEnabled === 't' ? 'true' : 'false'} WHERE id='eva';`);
        evaWasEnabled = null;
    }
    if (previousPlanner) {
        const previous = previousPlanner.source === 'catalog' ? { connection_id: previousPlanner.connection_id, model: previousPlanner.model } : {};
        expect.soft((await page.request.put('/api/v1/system/planner', { data: previous })).ok()).toBeTruthy();
        previousPlanner = null;
    }
});
test('assistant: real guarded retry, replay and stable timeout episode, browser evidence', async ({ page }, info) => {
    const p = await project(page, 'assistant');
    const f = await seedFailed(page, p);
    await config(page, p);
    const start = await send(page, p, 'Восстанови проект', 'recover');
    const done = await finished(page, p, start.run.id);
    expect(done.actions).toHaveLength(1);
    expect(done.actions[0].status).toBe('succeeded');
    expect(['queued', 'ready']).toContain(sql(`SELECT status FROM tasks WHERE id='${f.task}'`));
    expect(sql(`SELECT count(*) FROM events WHERE task_id='${f.task}' AND type='task.status'`)).not.toBe('0');
    // A new session/timestamp/counter reset is not a repaired causal input.
    sql(`UPDATE tasks SET status='failed',attempt_used=3,block_reason='timeout',updated_at=now() WHERE id='${f.task}';`);
    const again = await send(page, p, 'Снова восстанови проект', 'recover'), repeat = await finished(page, p, again.run.id);
    expect(repeat.actions[0].status).not.toBe('succeeded');
    expect(sql(`SELECT status FROM tasks WHERE id='${f.task}'`)).toBe('failed');
    await page.goto(`/#/p/${p}/assistant`);
    await expect(page.getByRole('heading', { name: 'Ассистент', exact: true })).toBeVisible();
    await expect(page.getByText('Срок не подтверждён.', { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath('assistant-real-backend.png'), fullPage: true });
});
test('assistant: question has no mutation, unsupported money, stale snapshot and stop', async ({ page }) => {
    const p = await project(page, 'assistant limits');
    const f = await seedFailed(page, p);
    await config(page, p);
    const start = await send(page, p, 'Что с проектом? [qa-money]'), done = await finished(page, p, start.run.id);
    expect(done.actions).toHaveLength(0);
    expect(done.run.followups[0].type).toBe('infrastructure.purchase');
    expect(sql(`SELECT status FROM tasks WHERE id='${f.task}'`)).toBe('failed');
    const slow = await send(page, p, '[qa-slow] восстанови', 'recover');
    let current: any;
    await expect.poll(async () => { current = await ok(await page.request.get(`/api/v1/projects/${p}/assistant/runs/${slow.run.id}`)); return current.run.status; }).toBe('running');
    await ok(await page.request.post(`/api/v1/projects/${p}/assistant/runs/${slow.run.id}/stop`, { headers: key(), data: { expected_revision: current.run.revision } }));
    const stopped = await finished(page, p, slow.run.id);
    expect(stopped.run.status).toBe('stopped');
    expect(sql(`SELECT status FROM tasks WHERE id='${f.task}'`)).toBe('failed');
    const before = await ok(await page.request.get(`/api/v1/projects/${p}/assistant`));
    sql(`UPDATE tasks SET updated_at=now() WHERE id='${f.task}';`);
    const stale = await page.request.post(`/api/v1/projects/${p}/assistant/messages`, { headers: key(), data: { text: 'stale', intent: 'recover', expected_snapshot_revision: before.snapshot.revision } });
    expect(stale.status()).toBe(409);
});
test('discovery: clarification sources and explicit new analysis, guarded old-client bypass, mobile', async ({ page }, info) => {
    const p = await project(page, 'clarification');
    const iv = await material(page, p, '[qa-clarify] Unknown integration');
    const run = await analyse(page, p);
    expect(run.outcome).toBe('needs_clarification');
    expect(run.backlog).toEqual([]);
    expect(run.questions[0].sources[0].material_id).toBe(iv.id);
    expect(run.questions[0].sources[0].line).not.toBe(999);
    await config(page, p);
    const diagnosis = await send(page, p, 'Что с исследованием?');
    const assistantResult = await finished(page, p, diagnosis.run.id);
    expect(assistantResult.run.summary).toContain('Требуются уточнения');
    expect(assistantResult.actions).toHaveLength(0);
    const base = `/api/v1/projects/${p}/discovery/analyses/${run.id}`;
    expect((await page.request.put(base + '/backlog', { data: { backlog_rev: run.backlog_rev, epics: [{ key: 'h1', title: 'Injected', goal: 'Injected from old client' }] } })).status()).toBe(409);
    expect((await page.request.post(base + '/approve', { data: { backlog_rev: run.backlog_rev, decompose: true } })).status()).toBe(409);
    expect(sql(`SELECT count(*) FROM epics WHERE project_id='${p}' AND kind='work'`)).toBe('0');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/p/${p}/discovery`);
    await expect(page.getByText('Нужны уточнения', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('В какой системе хранятся договоры и куда возвращать данные?', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('clarification-real-mobile.png'), fullPage: true });
    await material(page, p, '[qa-answer] Ответ на integration', '**Р:** Ответ версии 1 integration: договоры в ECM, API доступно.\n**Р:** Нужна интеграция в существующую карточку договора.');
    const old = await ok(await page.request.get(base));
    expect(old.outcome).toBe('needs_clarification');
    expect(sql(`SELECT count(*) FROM discovery_runs WHERE project_id='${p}'`)).toBe('1');
    const next = await analyse(page, p);
    expect(next.version).toBe(2);
    expect(next.outcome).toBe('backlog_ready');
    expect(next.backlog.length).toBeGreaterThan(0);
});
test('discovery: no development creates no work, legacy projection and cross-project isolation', async ({ page }) => {
    const p = await project(page, 'no development');
    await material(page, p, '[qa-no-development] Existing capability');
    const run = await analyse(page, p);
    expect(run.outcome).toBe('no_development_recommended');
    expect(run.backlog).toEqual([]);
    expect(run.questions).toEqual([]);
    await config(page, p);
    const diagnosis = await send(page, p, 'Нужна ли разработка?');
    const assistantResult = await finished(page, p, diagnosis.run.id);
    expect(assistantResult.run.summary).toContain('разработка не рекомендована');
    expect(assistantResult.actions).toHaveLength(0);
    expect(sql(`SELECT count(*) FROM epics WHERE project_id='${p}' AND kind='work'`)).toBe('0');
    const base = `/api/v1/projects/${p}/discovery/analyses/${run.id}`;
    expect((await page.request.post(base + '/approve', { data: { backlog_rev: run.backlog_rev, decompose: true } })).status()).toBe(409);
    const other = await project(page, 'other scope');
    expect((await page.request.get(`/api/v1/projects/${other}/discovery/analyses/${run.id}`)).status()).toBe(404);
    const legacy = await project(page, 'legacy');
    const legacyInterview = await material(page, legacy, 'Legacy');
    const ready = await analyse(page, legacy);
    sql(`UPDATE discovery_runs SET result=result-'outcome'-'rationale'-'questions'-'sources' WHERE id='${ready.id}';`);
    const projected = await ok(await page.request.get(`/api/v1/projects/${legacy}/discovery/analyses/${ready.id}`));
    expect(projected.outcome).toBe('backlog_ready');
    expect(projected.outcome_legacy).toBe(true);
    expect(sql(`SELECT result ? 'outcome' FROM discovery_runs WHERE id='${ready.id}'`)).toBe('f');
    expect((await page.request.delete(`/api/v1/projects/${legacy}/discovery/interviews/${legacyInterview.id}`)).status()).toBe(204);
    const outdated = await ok(await page.request.get(`/api/v1/projects/${legacy}/discovery/analyses/${ready.id}`));
    expect(outdated.outdated).toBe(true);
    expect(outdated.outcome).toBe('backlog_ready');
    expect((await page.request.post(`/api/v1/projects/${legacy}/discovery/analyses/${ready.id}/approve`, { data: { backlog_rev: outdated.backlog_rev, decompose: true } })).status()).toBe(409);
});
test('design: real padding/token impact, anchored orphan, revision conflict and immutable screenshot handoff', async ({ page }, info) => {
    const messages: string[] = [];
    page.on('console', m => {
        if (m.type() === 'error')
            messages.push(m.text());
    });
    const p = await project(page, 'design');
    const token = randomUUID(), component = randomUUID(), componentNode = randomUUID(), root = randomUUID(), first = randomUUID(), second = randomUUID();
    const model = { schema: 'rivet.design/v1', tokens: [{ id: token, name: 'Shared spacing', type: 'spacing', value: { px: 16 } }], components: [{ id: component, name: 'Action', root: { id: componentNode, type: 'button', props: { text: 'Продолжить', padding: { token_id: token }, background: '#3498db', color: '#ffffff' }, children: [] }, variants: [{ state: 'default', props: {} }] }], screens: [{ id: randomUUID(), name: 'Form', viewport: { width: 640, height: 480 }, root: { id: root, type: 'container', props: { padding: 16, gap: 12, direction: 'column' }, children: [{ id: first, type: 'instance', component_id: component, props: {}, children: [] }, { id: second, type: 'instance', component_id: component, props: {}, children: [] }] } }], base: null, overrides: [] };
    const prefix = `/api/v1/projects/${p}/design`;
    const doc = await ok(await page.request.post(prefix + '/documents', { headers: key(), data: { name: 'Contract form', model } }), 201);
    const path = prefix + `/documents/${doc.id}`;
    await page.goto(`/#/p/${p}/design`);
    await expect(page.getByRole('heading', { name: 'Дизайн-система', exact: true })).toBeVisible();
    const preview = page.frameLocator('iframe[title="Изолированный предпросмотр дизайна"]');
    await preview.getByRole('button', { name: 'Продолжить' }).first().click();
    await expect(page.locator('.design-inspector code'), messages.join('\n')).toHaveText(first);
    await page.locator('.design-inspector label').filter({ hasText: /^padding/ }).locator('input').fill('24');
    await page.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Влияние изменений' })).toBeVisible();
    let patchResponse = page.waitForResponse(r => r.url().endsWith(`/documents/${doc.id}`) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Сохранить patch', exact: true }).click();
    await ok(await patchResponse);
    await expect(page.getByText('Изменения сохранены', { exact: true })).toBeVisible();
    await page.reload();
    await preview.getByRole('button', { name: 'Продолжить' }).first().click();
    await expect(page.locator('.design-inspector label').filter({ hasText: /^padding/ }).locator('input')).toHaveValue('24');
    let saved = await ok(await page.request.get(path));
    expect(saved.model.overrides).toContainEqual({ instance_id: first, property: 'padding', value: 24 });
    // Shared token impact includes the other instance while local override survives.
    await page.locator('.design-tokens fieldset', { hasText: 'Shared spacing' }).getByLabel('px', { exact: true }).fill('32');
    await page.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Влияние изменений' })).toBeVisible();
    patchResponse = page.waitForResponse(r => r.url().endsWith(`/documents/${doc.id}`) && r.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Сохранить patch', exact: true }).click();
    await ok(await patchResponse);
    await expect(page.getByText('Изменения сохранены', { exact: true })).toBeVisible();
    saved = await ok(await page.request.get(path));
    expect(saved.model.tokens[0].value.px).toBe(32);
    expect(saved.model.overrides[0].value).toBe(24);
    const impact = await ok(await page.request.post(path + '/preview-diff', { data: { expected_revision: saved.document.revision, operations: [{ op: 'set_token', token_id: token, value: { px: 40 } }] } }));
    expect(impact.affected_element_ids).toContain(second);
    await page.getByLabel('Комментарий', { exact: true }).fill('Уточнить подпись этой кнопки');
    const threadResponse = page.waitForResponse(r => r.url().endsWith(`/documents/${doc.id}/threads`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Добавить к элементу', exact: true }).click();
    await ok(await threadResponse, 201);
    await expect(page.locator('.design-thread').getByText('Уточнить подпись этой кнопки', { exact: true })).toBeVisible();
    const threads = await ok(await page.request.get(path + '/threads'));
    expect(threads.items[0].anchor.element_id).toBe(first);
    const response = page.waitForResponse(r => r.url().endsWith(`/documents/${doc.id}/handoffs`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: `Создать handoff v${saved.document.revision}`, exact: true }).click();
    const handoff = await ok(await response, 201);
    expect(handoff.model_sha).toBe(saved.document.content_sha);
    expect(handoff.manifest_sha).toMatch(/^[a-f0-9]{64}$/);
    const screenshot = await ok(await page.request.get(prefix + `/assets/${handoff.screenshot_asset_id}`));
    const png = await fetch(new URL(screenshot.url, `http://127.0.0.1:${STAND.httpPort}`));
    expect(png.status).toBe(200);
    const imageBytes = Buffer.from(await png.arrayBuffer());
    expect(imageBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const renderedPixel = await page.evaluate(async encoded => {
        const data = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw Error('Canvas unavailable');
        ctx.drawImage(bitmap, 0, 0);
        return [...ctx.getImageData(30, 30, 1, 1).data];
    }, imageBytes.toString('base64'));
    expect(renderedPixel).toEqual([0x34, 0x98, 0xdb, 0xff]);
    // The opaque preview cannot read parent cookies or DOM. Forged messages ignored.
    const denied = await preview.locator('body').evaluate(() => {
        try {
            void window.parent.document.cookie;
            return false;
        }
        catch {
            return true;
        }
    });
    expect(denied).toBe(true);
    await page.evaluate(({ document, element }) => window.postMessage({ type: 'select', channel_nonce: 'forged', document_id: document, revision: 1, element_id: element }, '*'), { document: doc.id, element: second });
    await expect(page.locator('.design-inspector code')).toHaveText(first);
    await page.getByLabel('Текст', { exact: true }).fill('Локальный текст');
    await ok(await page.request.patch(path, { headers: key(), data: { expected_revision: saved.document.revision, operations: [{ op: 'set_property', scope: 'instance', element_id: second, property: 'text', value: 'Правка другого редактора' }] } }));
    const stale = await page.request.patch(path, { headers: key(), data: { expected_revision: saved.document.revision, operations: [{ op: 'set_property', scope: 'instance', element_id: first, property: 'text', value: 'stale overwrite' }] } });
    expect(stale.status()).toBe(409);
    await expect(page.getByRole('heading', { name: /На сервере уже v/ })).toBeVisible();
    await expect(page.getByLabel('Текст', { exact: true })).toHaveValue('Локальный текст');
    await expect(page.getByRole('button', { name: 'Экспорт patch', exact: true })).toBeEnabled();
    await page.screenshot({ path: info.outputPath('design-conflict-real-backend.png'), fullPage: true });
    const current = await ok(await page.request.get(path));
    await ok(await page.request.patch(path, { headers: key(), data: { expected_revision: current.document.revision, operations: [{ op: 'remove_node', element_id: first }] } }));
    const orphaned = await ok(await page.request.get(path + '/threads'));
    expect(orphaned.items[0].orphaned).toBe(true);
    expect(orphaned.items[0].anchor.element_id).toBe(first);
    const immutable = await ok(await page.request.get(prefix + `/handoffs/${handoff.id}`));
    expect(immutable.manifest_sha).toBe(handoff.manifest_sha);
    expect(immutable.model_sha).toBe(handoff.model_sha);
    expect(immutable.threads_snapshot[0].orphaned).toBe(false);
});
test('assistant: resumes Epic and environment through existing guards, retains old failure and pinned agent', async ({ page }) => {
    const p = await project(page, 'resume guards'), f = await seedFailed(page, p);
    await config(page, p);
    // Empty paused maintenance Epic is independently resumable; the failed task
    // remains in a separate paused Epic to avoid starting synthetic coding jobs.
    evaWasEnabled = sql("SELECT enabled FROM team_agents WHERE id='eva'");
    const resumable = randomUUID(), env = randomUUID(), dep = randomUUID(), attention = randomUUID();
    sql(`INSERT INTO epics(id,project_id,title,goal,status,kind) VALUES('${resumable}','${p}','QA resumable','Empty maintenance fixture','paused','maintenance');
 INSERT INTO environments(id,project_id,name,exec_type,trigger,config,paused) VALUES('${env}','${p}','QA local','ssh','manual','{"deploy_cmd":"true","verify_cmd":"true"}',true);
 INSERT INTO deployments(id,env_id,version,status,ended_at) VALUES('${dep}','${env}','old-failure','failed',now());
 INSERT INTO attention(id,project_id,deployment_id,reason,message,status,claimed_by) VALUES('${attention}','${p}','${dep}','DEPLOY_FAILED','Historical failure: no verified recovery','claimed','qa-owner');
 UPDATE tasks SET developer_agent_id='eva' WHERE id='${f.task}';UPDATE team_agents SET enabled=false WHERE id='eva';`);
    const snapshot = await ok(await page.request.get(`/api/v1/projects/${p}/assistant`));
    const tf = snapshot.snapshot.facts.find((x: any) => x.resource_id === f.task);
    expect(tf.value.developer_agent_id).toBe('eva');
    expect(tf.value.developer_binding.enabled).toBe(false);
    const start = await send(page, p, 'Восстанови [qa-resume]', 'recover'), done = await finished(page, p, start.run.id);
    // A run is bounded to three effects. The failed task and its containing Epic
    // appear first, so use a second explicit resume for the independent resource.
    expect(done.actions.length).toBeLessThanOrEqual(3);
    if (sql(`SELECT paused FROM environments WHERE id='${env}'`) === 't') {
        const next = await send(page, p, 'Возобнови [qa-resume]', 'recover');
        await finished(page, p, next.run.id);
    }
    expect(sql(`SELECT status FROM epics WHERE id='${resumable}'`)).toMatch(/^(running|done)$/);
    expect(sql(`SELECT paused FROM environments WHERE id='${env}'`)).toBe('f');
    expect(sql(`SELECT status FROM attention WHERE id='${attention}'`)).toBe('claimed');
    expect(sql(`SELECT developer_agent_id FROM tasks WHERE id='${f.task}'`)).toBe('eva');
    // Environment resume does not itself publish a fake successful release.
    expect(sql(`SELECT count(*) FROM releases WHERE env_id='${env}'`)).toBe('0');
});
test('design API: private assets, screenshot snapshot, cross-project refs, unsupported import and audited handoff link', async ({ page }) => {
    const p = await project(page, 'design API'), node = randomUUID(), root = randomUUID();
    const model = { schema: 'rivet.design/v1', tokens: [], components: [], screens: [{ id: randomUUID(), name: 'Main', viewport: { width: 320, height: 240 }, root: { id: root, type: 'container', props: { padding: 12 }, children: [{ id: node, type: 'button', props: { text: 'Договор', padding: 16 }, children: [] }] } }], base: null, overrides: [] };
    const prefix = `/api/v1/projects/${p}/design`, doc = await ok(await page.request.post(prefix + '/documents', { headers: key(), data: { name: 'Handoff', model } }), 201), path = prefix + `/documents/${doc.id}`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const asset = await ok(await page.request.post(prefix + '/assets', { headers: key(), multipart: { file: { name: 'qa.png', mimeType: 'image/png', buffer: png } } }), 201);
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await page.request.post(prefix + '/assets', { headers: key(), multipart: { file: { name: 'active.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg onload="alert(1)"></svg>') } } })).status()).toBe(422);
    const metadata = await ok(await page.request.get(prefix + `/assets/${asset.id}`));
    const bytes = await fetch(new URL(metadata.url, `http://127.0.0.1:${STAND.httpPort}`));
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(bytes.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    const first = await ok(await page.request.post(path + '/handoffs', { headers: key(), data: { revision: 1, thread_ids: [], links: [] } }), 201);
    expect(first.model_sha).toBe(doc.content_sha);
    await ok(await page.request.patch(path, { headers: key(), data: { expected_revision: 1, operations: [{ op: 'set_property', scope: 'instance', element_id: node, property: 'text', value: 'Новая подпись' }] } }));
    const old = await ok(await page.request.get(prefix + `/handoffs/${first.id}`));
    expect(old.manifest_sha).toBe(first.manifest_sha);
    expect(old.model_sha).toBe(doc.content_sha);
    const bad = { ...model, screens: [{ ...model.screens[0], root: { ...model.screens[0].root, props: { html: '<script>document.cookie</script>' } } }] };
    const validation = await ok(await page.request.post(prefix + '/imports/validate', { data: { document_id: doc.id, model: bad, assets: [] } }));
    expect(validation.valid).toBe(false);
    expect((await page.request.post(path + '/import', { headers: key(), data: { expected_revision: 2, model: bad, assets: [] } })).status()).toBe(422);
    const other = await project(page, 'design other');
    expect((await page.request.get(`/api/v1/projects/${other}/design/documents/${doc.id}`)).status()).toBe(404);
    const ref = await seedFailed(page, p);
    const linked = await ok(await page.request.post(prefix + `/handoffs/${first.id}/links`, { headers: key(), data: { kind: 'task', id: ref.task } }));
    expect(linked.manifest_sha).toBe(first.manifest_sha);
    expect(linked.git_commit_sha).toBeNull();
    expect(sql(`SELECT status FROM tasks WHERE id='${ref.task}'`)).toBe('failed');
    const replay = await ok(await page.request.get(path + '?revision=1'));
    expect(replay.model.screens[0].root.children[0].props.text).toBe('Договор');
});
test('discovery: actionable backlog passes Ada before planning and never auto-Starts coding', async ({ page }) => {
    test.setTimeout(120000);
    const p = await project(page, 'positive Ada');
    await material(page, p, 'Standalone requirements');
    const run = await analyse(page, p);
    expect(run.outcome).toBe('backlog_ready');
    await ok(await page.request.post(`/api/v1/projects/${p}/discovery/analyses/${run.id}/approve`, { data: { backlog_rev: run.backlog_rev, decompose: true } }));
    await expect.poll(() => Number(sql(`SELECT count(*) FROM epic_architecture_assessments WHERE project_id='${p}' AND status='passed'`)), { timeout: 60000 }).toBeGreaterThan(0);
    await expect.poll(() => Number(sql(`SELECT count(*) FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE e.project_id='${p}' AND e.kind='work'`)), { timeout: 60000 }).toBeGreaterThan(0);
    expect(sql(`SELECT count(*) FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE e.project_id='${p}' AND e.kind='work' AND t.started_at IS NOT NULL`)).toBe('0');
    expect(sql(`SELECT count(*) FROM epics WHERE project_id='${p}' AND kind='work' AND status='planned'`)).not.toBe('0');
});
test('assistant: cross-actor ACL and revocation between diagnosis and mutation', async ({ page, playwright }) => {
    const p = await project(page, 'revoked actor'), f = await seedFailed(page, p);
    await config(page, p);
    const loginName = `qa-owner-${Date.now()}`, password = `qa-${randomUUID()}`;
    const u = await ok(await page.request.post('/api/v1/users', { data: { login: loginName, name: 'QA owner', password, admin: false } }), 201);
    const client = await playwright.request.newContext({ baseURL: `http://127.0.0.1:${STAND.httpPort}` });
    try {
        await ok(await client.post('/api/v1/auth/login', { data: { login: loginName, password } }));
        expect((await client.get(`/api/v1/projects/${p}/assistant`)).status()).toBe(404);
        await ok(await page.request.post(`/api/v1/projects/${p}/members`, { data: { login: loginName, role: 'owner' } }));
        const snap = await ok(await client.get(`/api/v1/projects/${p}/assistant`));
        const run = await ok(await client.post(`/api/v1/projects/${p}/assistant/messages`, { headers: key(), data: { text: '[qa-slow] восстановить', intent: 'recover', expected_snapshot_revision: snap.snapshot.revision } }), 202);
        await expect.poll(async () => { const d = await ok(await page.request.get(`/api/v1/projects/${p}/assistant/runs/${run.run.id}`)); return d.run.status; }).toBe('running');
        await ok(await page.request.delete(`/api/v1/projects/${p}/members/${loginName}`));
        const final = await finished(page, p, run.run.id);
        expect(final.actions.every((x: any) => x.status !== 'succeeded')).toBe(true);
        expect(sql(`SELECT status FROM tasks WHERE id='${f.task}'`)).toBe('failed');
        expect((await client.get(`/api/v1/projects/${p}/assistant/messages`)).status()).toBe(404);
        expect(u.id).toBeTruthy();
    }
    finally {
        await client.dispose();
    }
});
test('design: exported immutable manifest is verified against an actual Git artifact commit', async ({ page }) => {
    await createProject(page, `QA Git handoff ${Date.now()}`, 'e2e/arch');
    const p = projectFromURL(page.url()), node = randomUUID();
    const model = { schema: 'rivet.design/v1', tokens: [], components: [], screens: [{ id: randomUUID(), name: 'Git handoff', viewport: { width: 640, height: 480 }, root: { id: node, type: 'text', props: { text: 'Версия для кодера и reviewer' }, children: [] } }], base: null, overrides: [] };
    const prefix = `/api/v1/projects/${p}/design`, doc = await ok(await page.request.post(prefix + '/documents', { headers: key(), data: { name: 'Review snapshot', model } }), 201);
    const handoff = await ok(await page.request.post(prefix + `/documents/${doc.id}/handoffs`, { headers: key(), data: { revision: 1, thread_ids: [], links: [] } }), 201);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rivet-qa-git-'));
    try {
        const bare = path.join(STAND.dir, 'repos/e2e/arch.git');
        execFileSync('git', ['clone', '-q', bare, dir]);
        const artifact = path.join(dir, 'design', 'rivet', doc.id);
        mkdirSync(artifact, { recursive: true });
        writeFileSync(path.join(artifact, 'manifest.json'), JSON.stringify(handoff));
        execFileSync('git', ['add', 'design'], { cwd: dir });
        execFileSync('git', ['-c', 'user.name=Rivet QA', '-c', 'user.email=qa@rivet.test', 'commit', '-q', '-m', 'Add immutable design handoff'], { cwd: dir });
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        execFileSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/qa-design-${randomUUID()}`], { cwd: dir });
        expect(sha).toMatch(/^[a-f0-9]{40}$/);
        expect(sha).not.toBe(handoff.model_sha);
        const linked = await ok(await page.request.post(prefix + `/handoffs/${handoff.id}/links`, { headers: key(), data: { kind: 'git_commit', id: sha } }));
        expect(linked.git_commit_sha).toBe(sha);
        expect(linked.manifest_sha).toBe(handoff.manifest_sha);
        // A real commit containing only a claimed SHA does not prove the artifact.
        writeFileSync(path.join(artifact, 'manifest.json'), JSON.stringify({ manifest_sha: handoff.manifest_sha }));
        execFileSync('git', ['add', 'design'], { cwd: dir });
        execFileSync('git', ['-c', 'user.name=Rivet QA', '-c', 'user.email=qa@rivet.test', 'commit', '-q', '-m', 'Invalid self-declared handoff'], { cwd: dir });
        const invalid = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
        execFileSync('git', ['push', '-q', 'origin', `HEAD:refs/heads/qa-invalid-${randomUUID()}`], { cwd: dir });
        expect((await page.request.post(prefix + `/handoffs/${handoff.id}/links`, { headers: key(), data: { kind: 'git_commit', id: invalid } })).status()).toBe(422);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test('assistant: dependency cause is sourced and unchanged heartbeat never triggers a model call', async ({ page }) => {
    const p = await project(page, 'cause and heartbeat'), f = await seedFailed(page, p);
    await config(page, p);
    const dependent = await ok(await page.request.post(`/api/v1/epics/${f.epic}/tasks`, { data: { title: 'QA dependent task', description: 'Await the failed prerequisite', deps: [f.task] } }), 201);
    const start = await send(page, p, 'Что мешает завершению?'), done = await finished(page, p, start.run.id);
    expect(done.run.summary).toContain('Первопричина');
    const history = await ok(await page.request.get(`/api/v1/projects/${p}/assistant/messages`));
    const answer = history.items.find((m: any) => m.author === 'assistant' && m.run_id === start.run.id);
    expect(answer.ref_ids).toContain(`task:${f.task}`);
    expect(answer.ref_ids).toContain(`task:${dependent.ID}`);
    expect(done.actions).toHaveLength(0);
    const maxEvent = Number(sql(`SELECT max(id) FROM events WHERE project_id='${p}'`));
    await expect.poll(() => Number(sql('SELECT cursor FROM assistant_event_checkpoint WHERE id=true'))).toBeGreaterThanOrEqual(maxEvent);
    const view = await ok(await page.request.get(`/api/v1/projects/${p}/assistant`));
    await ok(await page.request.patch(`/api/v1/projects/${p}/assistant/config`, { data: { expected_revision: view.config.revision, enabled: true, connection_id: 'qa-workspaces', model_id: 'qa-model', limits: view.config.limits } }));
    const calls = provider.assistantCalls;
    sql(`INSERT INTO events(actor_kind,type,project_id,text) SELECT 'runner','runner.heartbeat','${p}'::uuid,'unchanged synthetic heartbeat' FROM generate_series(1,10);`);
    const noiseMax = Number(sql(`SELECT max(id) FROM events WHERE project_id='${p}'`));
    await expect.poll(() => Number(sql('SELECT cursor FROM assistant_event_checkpoint WHERE id=true'))).toBeGreaterThanOrEqual(noiseMax);
    expect(sql(`SELECT count(*) FROM assistant_event_pending WHERE project_id='${p}'`)).toBe('0');
    expect(provider.assistantCalls).toBe(calls);
    expect(sql(`SELECT count(*) FROM assistant_runs WHERE project_id='${p}'`)).toBe('1');
});
test('design: historical image survives current deletion and expired capabilities refresh after idle', async ({ page }) => {
    const p = await project(page, 'historical asset'), root = randomUUID(), image = randomUUID();
    const prefix = `/api/v1/projects/${p}/design`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const asset = await ok(await page.request.post(prefix + '/assets', { headers: key(), multipart: { file: { name: 'history.png', mimeType: 'image/png', buffer: png } } }), 201);
    const model = { schema: 'rivet.design/v1', tokens: [], components: [], screens: [{ id: randomUUID(), name: 'Historical image', viewport: { width: 640, height: 480 }, root: { id: root, type: 'container', props: { padding: 12 }, children: [{ id: image, type: 'image', props: { asset_id: asset.id, width: 64, height: 64 }, children: [] }] } }], base: null, overrides: [] };
    const doc = await ok(await page.request.post(prefix + '/documents', { headers: key(), data: { name: 'Image history', model } }), 201);
    await ok(await page.request.patch(prefix + `/documents/${doc.id}`, { headers: key(), data: { expected_revision: 1, operations: [{ op: 'remove_node', element_id: image }] } }));
    await page.clock.install({ time: new Date() });
    await page.goto(`/#/p/${p}/design`);
    await page.locator('.workspace-toolbar').filter({ has: page.locator('span', { hasText: /^v1 ·/ }) }).getByRole('button', { name: 'Просмотр', exact: true }).click();
    await expect(page.getByText('Просмотр истории v1.', { exact: false })).toBeVisible();
    const img = page.frameLocator('iframe[title="Изолированный предпросмотр дизайна"]').locator('img');
    await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const oldURL = await img.getAttribute('src');
    expect(oldURL).toBeTruthy();
    // Inject expiry only into the separately named synthetic database. A browser
    // clock jump alone would not prove that backend capability refresh works.
    sql(`UPDATE design_asset_reads SET expires_at=now()-interval '1 second' WHERE project_id='${p}' AND asset_id='${asset.id}';`);
    const expired = await fetch(new URL(oldURL!, `http://127.0.0.1:${STAND.httpPort}`), { cache: 'no-store' });
    expect(expired.status).toBe(404);
    const refresh = page.waitForResponse(r => r.url().endsWith(`/design/assets/${asset.id}`) && r.request().method() === 'GET' && r.ok());
    await page.clock.fastForward(5 * 60 * 1000 + 1000);
    const metadata = await ok(await refresh);
    expect(metadata.url).not.toBe(oldURL);
    await expect(img).not.toHaveAttribute('src', oldURL!);
    await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect((await fetch(new URL(metadata.url, `http://127.0.0.1:${STAND.httpPort}`))).status).toBe(200);
    expect(sql(`SELECT revision FROM design_documents WHERE id='${doc.id}'`)).toBe('2');
});
