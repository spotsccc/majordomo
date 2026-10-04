# Majordomo

Личный ассистент. Монорепозиторий на [Turborepo](https://turborepo.dev) и pnpm.

## Структура

- `apps/core` — сервер ассистента на Next.js (Vercel): запросы агента, вход в ChatGPT
- `packages/db` — схема Postgres (Drizzle), миграции, шифрование секретов
- `packages/handler` — обёртка route handlers: валидация запроса через zod, request id, единый формат ошибок
- `packages/errors` — общие доменные ошибки (`NotFoundError`, `ValidationError`)
- `packages/openai-subscription` — модели OpenAI по подписке ChatGPT: вход на сервере, автообновление токенов, модель для AI SDK
- `packages/typescript-config` — общие `tsconfig.json`
- `docs/architecture` — решения по устройству системы (база данных и миграции)
- `docs/research` — исследование архитектуры и его ревью

## Команды

```sh
pnpm install
pnpm build
pnpm dev          # Postgres в Docker + миграции + dev-серверы (нужен запущенный Docker)
pnpm lint         # oxlint, конфиг .oxlintrc.json
pnpm format       # oxfmt, конфиг .oxfmtrc.json
pnpm check-types
pnpm test
```
