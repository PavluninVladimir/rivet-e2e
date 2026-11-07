import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'

// Порты и каталог e2e-стенда. Их же читает scripts/e2e-stand.sh из
// rivet-service: E2E_HTTP_PORT (консоль и API), E2E_GRPC_PORT (runner'ы),
// E2E_LLM_PORT (fake-llm) и E2E_STAND_DIR (бинарники, токены, репозитории).
// Задан только E2E_HTTP_PORT — остальное выводится из него: gRPC +10,
// fake-llm +2, каталог с портом в имени. Второй стенд поднимается рядом с
// первым одной переменной: без общих портов и без rm -rf чужого каталога.
// По умолчанию (8281) значения совпадают с умолчаниями e2e-stand.sh.
const http = Number(process.env.E2E_HTTP_PORT || 8281)

export const STAND = {
  httpPort: String(http),
  grpcPort: process.env.E2E_GRPC_PORT || String(http + 10),
  llmPort: process.env.E2E_LLM_PORT || String(http + 2),
  // Абсолютный путь: стенд и тестовые программы запускаются из разных
  // каталогов, относительный E2E_STAND_DIR они поняли бы по-разному.
  dir: path.resolve(process.env.E2E_STAND_DIR || (http === 8281 ? '/tmp/rivet-e2e-stand' : `/tmp/rivet-e2e-stand-${http}`)),
}

// Окружение для e2e-stand.sh: те же значения, что видят сценарии.
export const STAND_ENV: Record<string, string> = {
  E2E_HTTP_PORT: STAND.httpPort,
  E2E_GRPC_PORT: STAND.grpcPort,
  E2E_LLM_PORT: STAND.llmPort,
  E2E_STAND_DIR: STAND.dir,
}

// rivet-service рядом с rivet-e2e (структура как локально и в CI):
// отсюда сценарии запускают тестовые программы стенда через go run.
export const SERVICE_DIR = path.resolve(__dirname, '..', '..', 'rivet-service')

// Fake-провайдер моделей стенда (OpenAI-совместимый, ключ fake-key).
export const LLM_URL = `http://localhost:${STAND.llmPort}/v1`

// Песочница команд агента по пробе самого runner'а. e2e-stand.sh пишет
// журнал каждого runner'а в $E2E_STAND_DIR/runner-<id>.log, а runner при
// старте пишет итог пробы одной из двух строк (cmd/rivet-runner/run.go).
// Флаг -unsandboxed песочницу не выключает, а только разрешает работать
// без неё: если проба прошла, команды агента всё равно идут в песочнице без
// сети. Ожидание берётся из журнала, а не из того же GET /runners, который
// рисует консоль, поэтому ошибка передачи флага при регистрации видна.
// undefined — строки пробы в журнале ещё нет.
export async function runnerSandbox(id: string): Promise<boolean | undefined> {
  let log: string
  try {
    log = await readFile(path.join(STAND.dir, `runner-${id}.log`), 'utf-8')
  } catch {
    return undefined
  }
  const isolated = log.includes('команды агента выполняются в песочнице без сети')
  const open = log.includes('ВНИМАНИЕ: песочница недоступна')
  if (isolated && open) throw new Error(`runner ${id}: в журнале обе строки пробы песочницы`)
  return isolated ? true : open ? false : undefined
}

// issueRunnerToken выпускает через API токен регистрации для runner'ов ids
// (пустой список привяжется к первому зарегистрированному) и кладёт секрет в
// файл 0600 каталога стенда, как требует runner. Токен стенда выпущен
// только для runner'ов стенда (add-runner-identity), поэтому сценарий с
// собственным идентификатором выпускает себе свой. Возвращает путь файла.
export async function issueRunnerToken(page: Page, name: string, ids: string[]): Promise<string> {
  const res = await page.request.post('/api/v1/runner-tokens', { data: { name, runner_ids: ids } })
  if (res.status() !== 201) throw new Error(`выпуск токена ${name}: ${res.status()} ${await res.text()}`)
  const { secret } = await res.json() as { secret: string }
  const file = path.join(STAND.dir, `token-${name}`)
  await writeFile(file, secret + '\n', { mode: 0o600 })
  return file
}
