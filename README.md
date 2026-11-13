# rivet-e2e

End-to-end tests for [Rivet](https://github.com/PavluninVladimir/rivet), an
orchestrator for autonomous software development with AI coding agents. The
Playwright scenarios drive a real browser against the built web console, a
live `rivetd` and PostgreSQL, with fake SCM and runners of the built-in Rivet
agent on top of a fake model provider. Documentation is in Russian.

Сквозные тесты Rivet на Playwright. Сценарии гоняют браузер против собранной
консоли [rivet-web](https://github.com/PavluninVladimir/rivet-web), живого
rivetd и Postgres.

## Стенд

Стенд поднимает `rivet-service/scripts/e2e-stand.sh` из
[основного репозитория](https://github.com/PavluninVladimir/rivet): чистая
база на каждый прогон, fake SCM, локальный bare-репозиторий вместо GitHub и
`fake-llm`, OpenAI-совместимый провайдер с детерминированными сценариями.
Playwright запускает стенд сам как `webServer`.

Все runner'ы стенда работают на встроенном агенте Rivet (`rivet-runner
-agent rivet`): агентский цикл настоящий, модель — `fake-llm`. Стенд до
старта runner'ов создаёт через API подключение `e2e-llm` к `fake-llm` и
назначает агенту модель по умолчанию `e2e-llm/fake-small`. У `fake-small`
и `fake-large` в каталоге есть цены, поэтому сессии сообщают стоимость.
Runner'ы: `e2e-worker` и `e2e-worker2` (coding), `e2e-reviewer` и
`e2e-reviewer2` (review), `e2e-deployer` (выкатка, без агента). Песочница
команд агента есть не на всех машинах, поэтому runner'ы стенда запускаются
с `RIVET_RUNNER_UNSANDBOXED=1`: без песочницы, если она недоступна. Журнал
каждого runner'а стенд пишет в `$E2E_STAND_DIR/runner-<id>.log`.

Поведение агента задают метки в названии и описании задачи, их разбирает
`fake-llm` (`rivet-service/cmd/fake-llm/native.go`): `[e2e-slow]` держит
сессию открытой, `[e2e-block]` задаёт вопрос человеку, `[e2e-fail]`
проваливает реализацию, `[e2e-native-changes]`, `[e2e-tester-changes]` и
`[e2e-changes]` возвращают замечания ревьюера, тестировщика и шага prompt.
`[e2e-conflict]` обрабатывает fake SCM: первый merge отклоняется.

Для публикации через GitOps стенд держит репозиторий конфигурации
`e2e/gitops`. fake SCM коммитит в него версию настоящим коммитом, а
окружение стенда (`rivet-service/scripts/e2e-gitops-env`) отвечает на
`GET /<путь файла>` содержимым этого файла в ветке `main`, как приложение
после синхронизации, и `404`, пока файла нет. Порт окружения выбирает ОС,
адрес лежит в `$E2E_STAND_DIR/gitops-env.addr`.

Репозитории должны лежать так:

```
rivet/                 # git clone https://github.com/PavluninVladimir/rivet.git
├── rivet-service/
├── rivet-web/         # git clone https://github.com/PavluninVladimir/rivet-web.git
└── rivet-e2e/         # этот репозиторий
```

Нужны Go, Node.js 24, git, curl и PostgreSQL, доступный по
`RIVET_DATABASE_URL` (по умолчанию
`postgres://rivet:rivet@localhost:5432/rivet?sslmode=disable`; подойдёт
`docker compose up -d postgres s3` в `rivet-service` с `.env` из
`.env.example`). S3-хранилище (RustFS) нужно сценариям с транскриптами
сессий.

Пароль bootstrap-администратора и ключ шифрования стенд берёт свои на
каждый прогон: rivetd не стартует с паролем или ключом, опубликованными в
репозитории. Пароль задаёт `e2e/stand.ts` (или `E2E_ADMIN_PASSWORD`),
`e2e-stand.sh` кладёт его в `$E2E_STAND_DIR/admin-password`, чтобы войти в
консоль стенда руками.

## Запуск

```sh
cd rivet/rivet-web && npm ci
cd ../rivet-e2e && npm ci
npx playwright install chromium
npx playwright test
```

Стенд занимает порты 8281 (API и консоль), 8291 (gRPC runner'ов) и 8283
(fake-провайдер моделей) и каталог `/tmp/rivet-e2e-stand`. Их задают
`E2E_HTTP_PORT`, `E2E_GRPC_PORT`, `E2E_LLM_PORT` и `E2E_STAND_DIR` (см.
`e2e/stand.ts`). Если задан только `E2E_HTTP_PORT`, остальное выводится из
него: gRPC на 10 больше, fake-llm на 2 больше, каталог
`/tmp/rivet-e2e-stand-<порт>`. Так второй стенд поднимается рядом с первым:

```sh
E2E_HTTP_PORT=8581 npx playwright test
```

Два стенда из одной копии дерева одновременно не запускайте: оба собирают
консоль в `rivet-service/internal/webui/dist`.

Сценарий отказа стороннего агента запускает тестовый gRPC-клиент
`rivet-service/scripts/e2e-register` через `go run`: настоящий
`rivet-runner` сторонний агент не запускает вовсе.

Флаг `-unsandboxed` песочницу не выключает, а только разрешает работать без
неё. Где проба песочницы проходит (Linux с user namespaces), команды агента
идут в песочнице без сети. Поэтому проверка песочницы runner'ов берёт
ожидание из пробы в журнале runner'а и сверяет с ним `NetworkIsolated` в API
и предупреждение о сети в консоли.

## CI

`.github/workflows/e2e.yml` повторяет ту же раскладку: клонирует `rivet` и
`rivet-web`, поднимает Postgres и S3 (RustFS) и гоняет сценарии в Chromium.
Секреты не нужны, токену workflow хватает чтения.

Ветки `rivet` и `rivet-web` берутся одноимённые ветке e2e, если такая ветка
есть, иначе `main`. Ветка ищется точным `refs/heads/<имя>`. Ошибка сети или
доступа валит прогон, а не подменяет ветку на `main`. Выбранные ветки и
коммиты видны в summary прогона.

## Участие

Порядок правок, проверки и CLA описаны в [CONTRIBUTING.md](CONTRIBUTING.md).
Об уязвимостях сообщайте приватно, как описано в [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 Vladimir Pavlunin. Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only),
with an additional permission under section 7 ([LICENSE-EXCEPTION](LICENSE-EXCEPTION)).

Полный текст лицензии в файле [LICENSE](LICENSE), дополнительное
разрешение по разделу 7 в [LICENSE-EXCEPTION](LICENSE-EXCEPTION). Сценарии
ничего стороннего не распространяют: Playwright и другие зависимости ставит
`npm ci`. Основной репозиторий проекта:
[PavluninVladimir/rivet](https://github.com/PavluninVladimir/rivet).


## Локальная Docker-публикация

`npm run test:local-docker` проверяет весь пользовательский путь на отдельной
БД и временном git-репозитории: ранняя подготовка стенда, публикация,
перезапуск, redeploy, ошибка сборки с сохранением прежнего адреса, логи,
остановка и очистка через форму. Окружения основного стенда и CRM не используются.
Перед прогоном соберите соседний `rivet-web` командой `npm run build`.
Пути можно переопределить через `RIVET_SERVICE_DIR` и `RIVET_WEB_DIR`.
Нужны локальные Docker и PostgreSQL с правом создавать тестовые БД.
Перезапуск Docker этот браузерный сценарий не выполняет.

### Ассистент, дизайн и исходы исследования

`e2e/workspaces.spec.ts` проходит через настоящие API, PostgreSQL, S3 и встроенную консоль. Подменяется только локальная модель из `e2e/fixtures/workspace-provider.ts`, сетевые запросы браузера не перехватываются. Фикстура проверяет исполнение и guards, а не качество реальной модели.

Стенд записывает имя свежей базы в `$E2E_STAND_DIR/database-name`. Подготовка failed/legacy-состояний разрешена только для базы `rivet_e2e_<pid>_<timestamp>` и тестовых портов 8281/19381. Используется локальный `psql`, либо Docker-контейнер из `E2E_POSTGRES_CONTAINER` (по умолчанию `rivet-service-postgres-1`). Рабочая база не изменяется.

Для screenshot handoff нужен доверенный Chromium с работающей песочницей. Путь задаётся `RIVET_DESIGN_CHROMIUM_PATH`. Отсутствие renderer возвращает явную ошибку, тест не подменяет её фиктивным PNG и не выключает sandbox. Изолированный уже поднятый стенд можно проверить отдельно:

```sh
E2E_HTTP_PORT=19381 E2E_STAND_DIR=/tmp/rivet-workspaces-stand \
  npx playwright test --config playwright.workspaces.config.ts
```

Покрыты retry/resume/stop, повторный timeout и отзыв прав, три исхода исследования с Ada до планирования, правки и конфликты дизайна, anchored threads, private assets, immutable PNG/handoff и проверка настоящего Git commit с manifest. Историческое изображение проверяется после удаления из текущей версии и истечения capability: SQL меняет только тестовую БД, часы браузера вызывают обновление ссылки, затем проверяются реальные bytes и naturalWidth. Снимки с SHA содержимого и Git SHA различаются. Комментарий или связь не запускают merge.

### Архитектурный этап в положительных сценариях

Положительные сценарии ручного планирования явно используют `createAssessedEpic`.
Он создаёт Epic обычными действиями в UI, дожидается реальной оценки Ады для
текущей revision и проверяет, что интерфейс разрешил добавление задачи. Для
сценария с собственным созданием Epic доступны `withFakeArchitect` и
`waitForEpicAssessment`. Обычный `createEpic` остаётся без автоматической
настройки модели, чтобы проверять ожидание и отказы gate.

`e2e/fixtures/architecture-model.ts` дополняет локальный fake-провайдер ответом
на задание архитектурной оценки. Это настройка тестового стенда через штатные
API, а не подмена ответов браузеру. Модель Ады назначается только на время
явного положительного fixture, затем прежние поля восстанавливаются с проверкой
версии. Planner и шаблоны ролей не меняются. Временное подключение удаляется
после успешного восстановления, без удаления ссылки при конкурентном изменении.
Поэтому эти сценарии выполняются с `workers: 1`, как задано в конфигурации.

`architecture-fixture.spec.ts` отдельно проверяет восстановление настроек и
закрытый gate нового Epic без модели. Оценка не заменяет обычные проверки и
review задач, не запускает Epic автоматически и не записывает статусы через SQL.


Справочная стоимость архитектурной оценки проверяется отдельно от gate.
По умолчанию provider сообщает `prompt_tokens=10`, `completion_tokens=5`,
`total_tokens=15`. До назначения Аде fixture через обычный API каталога задаёт
синтетические `input_price=output_price=1_000_000` микродолларов за миллион
токенов. Это тестовые положительные ставки, не оплата реальной модели.
Ожидаемая сохранённая стоимость одного assessment равна `$0.000015`.
`overview.spec.ts` проверяет её вместе с ненулевой стоимостью coding и полной
суммой уже после удаления временного подключения.

Явный `createAssessedEpic(page, title, { reportedUsage: null })` проходит тот же
архитектурный этап, но provider не передаёт usage. Отдельный отрицательный
сценарий требует `partial_cost=true`, известную ненулевую coding-сумму,
обязательную `*` и пояснение неполноты в UI. Отсутствующий usage не подменяется
нулём, обзор и БД не мокируются. Опции передаются одним fixture-вызовом без
вложенной блокировки `withFakeArchitect`.
