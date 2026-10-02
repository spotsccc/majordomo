# Majordomo

Личный ассистент. Монорепозиторий на [Turborepo](https://turborepo.dev) и pnpm.

## Структура

- `apps/core` — сервер ассистента на Next.js (Vercel): запросы агента, вход в ChatGPT
- `packages/db` — схема Postgres (Drizzle), миграции, шифрование секретов
- `packages/openai-subscription` — модели OpenAI по подписке ChatGPT: вход на сервере, автообновление токенов, модель для AI SDK
- `packages/eslint-config` — общие конфигурации ESLint
- `packages/typescript-config` — общие `tsconfig.json`
- `docs/architecture` — решения по устройству системы (база данных и миграции)
- `docs/research` — исследование архитектуры и его ревью

## Команды

```sh
pnpm install
pnpm build
pnpm dev          # Postgres в Docker + миграции + dev-серверы (нужен запущенный Docker)
pnpm lint
pnpm check-types
pnpm test
```
