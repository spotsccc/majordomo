# @repo/core

Сервер ассистента на Next.js 16 (App Router), деплоится на Vercel. Принимает запросы агента, отвечает моделью OpenAI по подписке ChatGPT и сам поддерживает эту подписку в рабочем состоянии.

## API

Все ручки, кроме `/api/health` и cron, требуют заголовок `Authorization: Bearer $MAJORDOMO_API_TOKEN`.

| Ручка                          | Что делает                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `POST /api/agent`              | ход агента: `{ messages: UIMessage[] }` → поток UI-сообщений AI SDK (совместим с `useChat`)               |
| `POST /api/openai/login`       | начать вход в ChatGPT или вернуть уже начатый: `{ verificationUrl, userCode, expiresAt, pollIntervalMs }` |
| `GET /api/openai/login`        | проверить, ввёл ли владелец код: `{ state: "pending" \| "complete" \| "none" \| "failed" }`               |
| `GET /api/openai/status`       | состояние сессии: `logged_out`, `active` или `reauth_required`                                            |
| `POST /api/openai/logout`      | выйти и отозвать refresh-токен                                                                            |
| `GET /api/cron/openai-refresh` | Vercel Cron раз в сутки продлевает сессию (`Authorization: Bearer $CRON_SECRET`)                          |
| `GET /api/health`              | проверка живости                                                                                          |

## Вход в ChatGPT с клиента

1. Клиент отправляет запрос в `/api/agent`.
2. Если сессии ещё нет или она умерла, сервер отвечает `409`:

   ```json
   {
     "error": "openai_login_required",
     "message": "Вход в ChatGPT не выполнен.",
     "login": {
       "verificationUrl": "https://auth.openai.com/codex/device",
       "userCode": "ABCD-1234",
       "expiresAt": "…",
       "pollIntervalMs": 5000
     }
   }
   ```

3. Клиент показывает ссылку и код. Владелец открывает ссылку (можно на том же телефоне), входит в ChatGPT и вводит код.
4. Клиент раз в `pollIntervalMs` вызывает `GET /api/openai/login`, пока не получит `complete`, и повторяет исходный запрос. При `failed` (код отклонён) клиент запрашивает новый код через `POST /api/openai/login`.

Пока код действует (15 минут), повторные запросы получают тот же код. Дальше сессия продлевается сама: токен обновляется при запросах и раз в сутки по cron.

## Локальный запуск

```sh
cp apps/core/.env.example apps/core/.env.local   # заполнить
pnpm --filter @repo/db migrate                       # нужен DATABASE_URL_UNPOOLED
pnpm --filter @repo/core dev
```

Как устроены база, миграции и секреты и что нужно для первого деплоя, описано в [docs/architecture/database.md](../../docs/architecture/database.md).
