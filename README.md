# rivet-e2e

Сквозные тесты Rivet на Playwright. Сценарии гоняют браузер против собранной консоли rivet-web, живого rivetd и Postgres.

Стенд поднимает `rivet-service/scripts/e2e-stand.sh`: чистая база, fake SCM, fake-агенты, локальный git. Репозитории rivet, rivet-web и rivet-e2e должны лежать рядом внутри общей папки rivet.

Запуск: `npm ci && npx playwright test`
