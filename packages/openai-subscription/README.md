# @repo/openai-subscription

Доступ к моделям OpenAI по подписке ChatGPT (Plus/Pro/Business) вместо API-ключа. Пакет умеет входить в аккаунт на удалённом сервере, хранить и сам обновлять токены. Для AI SDK он даёт готовую модель.

Протокол и сама модель берутся из [`@fieldwork-ai/codex-transport`](https://www.npmjs.com/package/@fieldwork-ai/codex-transport), порта протокола Codex CLI. Он даёт OAuth по коду устройства и через браузер, обновление токенов с арендой (lease) и `LanguageModelV4`. Этот пакет добавляет к нему:

- хранилище токенов, общее для нескольких процессов;
- фоновое продление сессии;
- повтор запроса после 401;
- CLI для входа.

## Вход на сервере

```sh
pnpm --filter @repo/openai-subscription build
node packages/openai-subscription/dist/cli.js login
```

CLI покажет ссылку `https://auth.openai.com/codex/device` и код. Ссылку можно открыть на любом устройстве, хоть на телефоне. Войдите в ChatGPT, введите код, и сервер сам получит токены. От сервера не нужны открытые порты, туннели или копирование URL.

Если для аккаунта отключён вход по коду устройства, CLI сам переключится на вход через браузер (или запустите `login --browser`):

1. Откройте показанную ссылку в браузере на своём компьютере.
2. После входа браузер перейдёт на `localhost:1455` и покажет ошибку. Так и должно быть.
3. Скопируйте адрес этой страницы и вставьте его в CLI.

Остальные команды:

| Команда             | Что делает                                        |
| ------------------- | ------------------------------------------------- |
| `status`            | состояние сессии, аккаунт, тариф, лимиты подписки |
| `refresh`           | обновить токен прямо сейчас                       |
| `test [--model id]` | отправить модели короткий запрос                  |
| `logout`            | удалить токены и отозвать refresh-токен в OpenAI  |

Токены лежат в `~/.majordomo/openai-subscription.json` с правами `0600`. Путь можно поменять переменной `MAJORDOMO_OPENAI_AUTH_FILE` или флагом `--file`. Сервер и CLI должны смотреть в один и тот же файл.

## Использование в коде

```ts
import { generateText } from "ai";
import {
  FileCredentialStore,
  OpenAISubscriptionAuth,
  createOpenAISubscription,
  defaultCredentialFile,
} from "@repo/openai-subscription";

const auth = new OpenAISubscriptionAuth({
  store: new FileCredentialStore(defaultCredentialFile()),
  onReauthRequired: (info) =>
    notifyOwner(`Нужно заново войти в ChatGPT: ${info.reason}`),
});
auth.start(); // фоновое продление сессии

const openai = createOpenAISubscription({ auth });
const { text } = await generateText({
  model: openai("gpt-5.6-luna"),
  prompt: "Привет",
});
```

Известные ID моделей экспортируются как `OPENAI_SUBSCRIPTION_MODEL_ID_LIST`. Параметры запроса (`reasoningEffort`, `sessionId`, `promptCacheKey` и т. п.) передаются через `providerOptions["openai-subscription"]`.

Вход можно встроить в веб-интерфейс или push-уведомление. `startDeviceLogin(auth)` возвращает `{ userCode, verificationUrl, expiresAt, result, cancel }`, `startBrowserLogin(auth)` возвращает `{ authorizationUrl, complete(url) }`.

### Serverless (Vercel)

Процесс там не живёт между запросами, поэтому таймеры и ожидание в памяти не подходят:

- токены хранятся в базе: `PostgresCredentialStore` из `@repo/db` или своя реализация на основе `StateCredentialStore`;
- вместо `auth.start()` раз в сутки по cron вызывается `auth.refreshIfDue({ aheadMs: сутки })`;
- вход разбит на шаги. `beginDeviceLogin(auth)` возвращает `PendingDeviceLogin`: его сохраняют на сервере, а клиенту показывают только код и ссылку. `pollDeviceLogin(auth, pending)` вызывают при каждом опросе статуса.

Пример — `apps/core`.

## Как поддерживается авторизация

Refresh-токены OpenAI одноразовые: каждое обновление выдаёт новый, а старый становится недействительным. Если два клиента обновят сессию одним и тем же токеном, второй получит `refresh_token_reused` и сессия умрёт. Поэтому пакет сделан так:

1. **Перед запросом.** `getCredential()` обновляет токен, если до истечения осталось меньше 5 минут. Если обновление временно не удалось, а токен ещё действует, запрос уходит со старым токеном.
2. **В фоне.** `auth.start()` (или `refreshIfDue()` по cron) обновляет токен за 30 минут до истечения, но не раньше середины его срока жизни. Кроме того, токен обновляется не реже раза в 8 дней, как в Codex. При временных ошибках повторяет попытку с растущей паузой от 30 секунд до 15 минут. Таймеры не держат процесс.
3. **После 401.** Запрос повторяется один раз с обновлённым токеном. Если токен к этому моменту уже обновил кто-то другой, повторного обновления не будет.
4. **Между процессами.** Обновление идёт под арендой в хранилище: номер поколения плюс блокировка, файл записывается атомарно. Процессы, которые не взяли аренду, ждут и берут готовый результат. Обновление внутри одного процесса тоже выполняется один раз.
5. **Мёртвая сессия.** 401, `invalid_grant`, `refresh_token_expired`/`reused`/`invalidated` означают, что сессию не восстановить. Пакет записывает это в хранилище, один раз вызывает `onReauthRequired` и дальше бросает `ReauthRequiredError` без сетевых запросов. Новый `login` снимает этот флаг, и фоновое продление подхватывает новую сессию без перезапуска сервера.

## Ограничения

- Бэкенд `chatgpt.com/backend-api/codex` не является публичным API. OpenAI может его изменить, и тогда нужно обновить `@fieldwork-ai/codex-transport`. Пакет молодой (сентябрь 2026) и у него один сопровождающий, поэтому версия закреплена точно.
- Не переносите сюда `~/.codex/auth.json` от Codex CLI. У них будет общий refresh-токен, и обновление в одном клиенте разлогинит другой. Для сервера нужен отдельный вход.
- Файл токенов не шифруется. Для хранения в PostgreSQL с шифрованием реализуйте интерфейс `CredentialStore`: `load`, `tryAcquire`, `commit`, `release`, `replace`, `markReauthRequired`.
- При `transport: "websocket"` повтор после 401 не работает. По умолчанию используется SSE.
