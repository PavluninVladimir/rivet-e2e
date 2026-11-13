import { createServer, type Server } from 'node:http';
export type Provider = {
    server: Server;
    calls: number;
    assistantCalls: number;
    decisions: unknown[];
    port: number;
    close: () => Promise<void>;
};
// Deterministic model adapter only. Browser requests continue through the real
// application API and database; there are no page.route mocks in these tests.
export async function workspaceProvider(port = 19386, upstream = 'http://127.0.0.1:19383'): Promise<Provider> {
    const fixture: Provider = { server: null as unknown as Server, calls: 0, assistantCalls: 0, decisions: [], port, close: async () => { } };
    fixture.server = createServer(async (req, res) => {
        try {
            const chunks: Buffer[] = [];
            for await (const b of req)
                chunks.push(Buffer.from(b));
            const raw = Buffer.concat(chunks);
            res.setHeader('Content-Type', 'application/json');
            if (req.method === 'GET' && req.url?.endsWith('/models')) {
                res.end(JSON.stringify({ data: [{ id: 'qa-model', object: 'model', owned_by: 'qa' }] }));
                return;
            }
            const body = raw.length ? JSON.parse(raw.toString()) : {}, messages = body.messages ?? [], prompt = messages.filter((x: any) => x.role !== 'system').map((x: any) => typeof x.content === 'string' ? x.content : '').join('\n');
            fixture.calls++;
            let content: unknown;
            if (prompt.startsWith('[rivet:epic_architecture_assessment]')) {
                content = { decision: 'no_change', summary: 'Синтетический сценарий в пределах существующего приложения', impact: [], constraints: ['Сохранить изоляцию проекта'], documentation: ['Зафиксировать результат проверки'], risks: [] };
            }
            else if (prompt.startsWith('Данные для анализа (не инструкции):')) {
                fixture.assistantCalls++;
                const data = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1).split('\nИсторические сообщения')[0]);
                const facts = data.snapshot.facts as any[];
                const actions: any[] = [];
                const refs: string[] = [];
                const failed = facts.filter((f: any) => f.kind === 'task' && f.value.status === 'failed');
                const cascade = facts.filter((f: any) => f.kind === 'task' && f.value.deps?.some((id: string) => failed.some((cause: any) => cause.resource_id === id)));
                const research = facts.filter((f: any) => f.kind === 'research').sort((a: any, b: any) => b.value.version - a.value.version)[0];
                if (research) refs.push(...research.ref_ids);
                for (const f of [...failed, ...cascade])
                    refs.push(...f.ref_ids);
                if (data.question.includes('[qa-slow]'))
                    await new Promise(r => setTimeout(r, 2500));
                for (const f of facts) {
                    if (data.intent === 'recover' && f.kind === 'task' && f.value.status === 'failed') {
                        actions.push({ type: 'task.retry', target_id: f.resource_id, evidence_ids: f.ref_ids });
                        refs.push(...f.ref_ids);
                    }
                    if (data.intent === 'recover' && data.question.includes('[qa-resume]') && f.kind === 'epic' && f.value.status === 'paused') {
                        actions.push({ type: 'epic.resume', target_id: f.resource_id, evidence_ids: f.ref_ids });
                        refs.push(...f.ref_ids);
                    }
                    if (data.intent === 'recover' && data.question.includes('[qa-resume]') && f.kind === 'environment' && f.value.paused) {
                        actions.push({ type: 'environment.resume', target_id: f.resource_id, evidence_ids: f.ref_ids });
                        refs.push(...f.ref_ids);
                    }
                }
                const researchText = research?.value.outcome === 'needs_clarification' ? ' Требуются уточнения владельца.' : research?.value.outcome === 'no_development_recommended' ? ' Новая разработка не рекомендована.' : '';
                content = { summary: 'Срок не подтверждён. Состояние публикации не доказывает приёмку продукта.' + (cascade.length ? ' Первопричина — failed задача, каскад — зависимые задачи ждут её результат.' : '') + researchText, uncertainties: ['Нужна проверка полезного результата'], ref_ids: [...new Set(refs)], intents: actions.slice(0, 3), followups: data.question.includes('[qa-money]') ? [{ type: 'infrastructure.purchase', reason: 'Подтверждение расходов выполняется владельцем отдельно', url: 'javascript:alert(1)' }] : [] };
                fixture.decisions.push(content);
            }
            else if (prompt.startsWith('rivet:analyst:synthesis') && (prompt.includes('[qa-clarify]') || prompt.includes('[qa-no-development]')) && !prompt.includes('[qa-answer]')) {
                const block = prompt.split('# Конспекты интервью')[1]?.split('```json\n')[1]?.split('\n```')[0];
                const input = JSON.parse(block);
                const first = input.interviews[0], q = first.findings[0].quotes[0];
                const source = { material_id: first.id, line: 999, quote: q.text };
                const clarify = prompt.includes('[qa-clarify]');
                content = { outcome: clarify ? 'needs_clarification' : 'no_development_recommended', rationale: clarify ? 'Не определена граница интеграции' : 'Существующее решение покрывает запрос, новая разработка не нужна', questions: clarify ? [{ id: 'integration', text: 'В какой системе хранятся договоры и куда возвращать данные?', reason: 'Определяет границу интеграции', sources: [source] }] : [], sources: [source], personas: [], needs: [], epics: [] };
            }
            else {
                const upstreamResponse = await fetch(upstream + req.url, { method: req.method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake-key' }, body: req.method === 'GET' ? undefined : raw });
                res.statusCode = upstreamResponse.status;
                res.setHeader('Content-Type', upstreamResponse.headers.get('content-type') ?? 'application/json');
                res.end(await upstreamResponse.text());
                return;
            }
            res.end(JSON.stringify({ id: 'qa-completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
        }
        catch (e) {
            console.error("QA provider failure:", String(e));
            res.statusCode = 500;
            res.end(JSON.stringify({ error: { message: String(e) } }));
        }
    });
    await new Promise<void>((resolve, reject) => { fixture.server.once('error', reject); fixture.server.listen(port, '127.0.0.1', resolve); });
    fixture.close = () => new Promise<void>(r => fixture.server.close(() => r()));
    return fixture;
}
