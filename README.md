# rivet-e2e

End-to-end tests for [Rivet](https://github.com/PavluninVladimir/rivet), an
orchestrator for autonomous software development with AI coding agents. The
Playwright scenarios drive a real browser against the built web console, a
live `rivetd` and PostgreSQL, with fake SCM, fake agents and a fake model
provider. Documentation is in Russian.

Сквозные тесты Rivet на Playwright. Сценарии гоняют браузер против собранной
консоли [rivet-web](https://github.com/PavluninVladimir/rivet-web), живого
rivetd и Postgres.

## Стенд

Стенд поднимает `rivet-service/scripts/e2e-stand.sh` из
[основного репозитория](https://github.com/PavluninVladimir/rivet): чистая
база на каждый прогон, fake SCM, fake-агенты, fake-провайдер моделей,
локальный bare-репозиторий вместо GitHub. Playwright запускает его сам как
`webServer`.

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
`docker compose up -d postgres minio` в `rivet-service`). MinIO нужен
сценариям с транскриптами сессий.

## Запуск

```sh
cd rivet/rivet-web && npm ci
cd ../rivet-e2e && npm ci
npx playwright install chromium
npx playwright test
```

Стенд занимает порты 8281 (API и консоль), 8291 (gRPC runner'ов) и 8283
(fake-провайдер моделей); адрес консоли для тестов задан в
`playwright.config.ts`.

## CI

`.github/workflows/e2e.yml` повторяет ту же раскладку: клонирует `rivet` и
`rivet-web`, поднимает Postgres и MinIO и гоняет сценарии в Chromium.
Секреты не нужны.

## License

Copyright (C) 2026 Vladimir Pavlunin. Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only).

Полный текст лицензии — в файле [LICENSE](LICENSE). Основной репозиторий
проекта: [PavluninVladimir/rivet](https://github.com/PavluninVladimir/rivet).
