# План: Telegram-канал Majordomo (с голосовыми)

Реализация решения из research-документа «Telegram как канал Majordomo» (срез источников 3 октября 2026; удалён из репозитория 4 октября 2026 вместе с `docs/research`, в git не попадал): вебхук на production-домене, Vercel Chat SDK (`chat` + `@chat-adapter/telegram` + `@chat-adapter/state-pg`), своя история в Neon, общий ход агента для HTTP и Telegram, вход в ChatGPT карточкой. Сверх документа план сразу включает **голосовые сообщения**: распознавание речи и ход агента по тексту. Упоминания «эскиз N research-документа» ниже — ссылки на разделы того документа; всё, что из них нужно для реализации, пересказано в этапах вместе с поправками spike.

Дата: 4 октября 2026. Версии пакетов Chat SDK на npm: `chat`, `@chat-adapter/telegram`, `@chat-adapter/state-pg` — 4.41.1.

## 1. Что уже проверено по исходникам 4.41.1

Тарболы скачаны с registry.npmjs.org и прочитаны. Это снимает часть вопросов spike из research-документа.

| Вопрос                           | Факт                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Как приходит голосовое           | `extractAttachments` превращает `raw.voice` во вложение `{ type: "audio", mimeType: raw.voice.mime_type, size, fetchMetadata: { fileId, fileUniqueId }, fetchData }`. `raw.audio` (музыкальный файл) приходит так же, с `name`. `raw.video_note` (кружок) — вложение `type: "video"`.                                                                                                                |
| Текст голосового                 | `message.text` = подпись (`caption`) или `""`. Заглушки вроде «🎤 Voice» нет (`describeNonFileContent` голосовые не описывает).                                                                                                                                                                                                                                                                      |
| Скачивание                       | `fetchData()` → `downloadFile(fileId)`: `getFile`, затем `fetch` на `${apiBaseUrl}/file/bot<TOKEN>/<path>` с таймаутом. URL содержит токен бота и наружу не отдаётся; бросает `ResourceNotFoundError` / `NetworkError`.                                                                                                                                                                              |
| Вложения сообщений из очереди    | `drainQueue` / `debounceLoop` прогоняют каждую запись очереди через `rehydrateMessage`, который вызывает `adapter.rehydrateAttachment` для вложений без `fetchData`. Голосовое, пришедшее во время хода, после очереди скачивается.                                                                                                                                                                  |
| Схема таблиц state-pg            | `postgresSchemaStatements` и все запросы используют **неквалифицированные** имена (`chat_state_locks` и т. д.), то есть `search_path` соединения. Опции схемы нет. При `autoCreateSchema: false` адаптер на connect выполняет `schemaProbe` и падает с «PostgreSQL state schema is not ready», если таблиц не видно: ошибка громкая, не тихая.                                                       |
| Пул для state-pg                 | `createPostgresState({ client: pg.Pool, autoCreateSchema: false, keyPrefix })`.                                                                                                                                                                                                                                                                                                                      |
| `queueEntryTtlMs` по умолчанию   | 90 000 мс.                                                                                                                                                                                                                                                                                                                                                                                           |
| Аудио в модель напрямую          | Невозможно: `@fieldwork-ai/codex-transport` 0.1.7 передаёт в Codex только текст и картинки, остальные файлы заменяет текстовой пометкой (`fileContentOf`). Нужна отдельная транскрипция.                                                                                                                                                                                                             |
| Транскрипция по подписке ChatGPT | Диктовка Codex Desktop/CLI отправляет аудио multipart-запросом (поле `file`) на `POST https://chatgpt.com/backend-api/transcribe` с тем же OAuth-токеном и `ChatGPT-Account-Id`. Маршрут приватный и не документирован. Источники в разделе 10. **Spike 0.8: для нашего клиента закрыт Cloudflare (403)**, так что строка research-документа «подписка её, скорее всего, не даёт» на практике верна. |
| Контракт AI SDK для транскрипции | `TranscriptionModelV4` в `@ai-sdk/provider` 4.0.19 (`doGenerate`, необязательный `doStream`); вызывается через `transcribe()` из `ai` 7.0.122. `transcribe()` бросает при ошибке.                                                                                                                                                                                                                    |

## 2. Решения владельца

1. **Зависимости — одобрены (4 октября 2026).** В `@repo/core`: `chat@4.41.1`, `@chat-adapter/telegram@4.41.1`, `@chat-adapter/state-pg@4.41.1`, версии закреплены точно (выходят раз в 1–2 недели). Для голосовых: `@ai-sdk/groq` в `@repo/core`, версия закрепляется точно (выбран вместе с провайдером, п. 2.2). `zod` в `@repo/openai-subscription` больше не нужен: он был только для ответа `/backend-api/transcribe`.
2. **Провайдер распознавания речи — Groq, `whisper-large-v3` (решено 4 октября 2026).** Причины: бесплатный план (20 запросов в минуту, 28 800 аудиосекунд в день) с запасом покрывает объём одного владельца, сверх него — около $0,11 за час; Groq не обучает на данных, ZDR включается в настройках; готовый `@ai-sdk/groq` с `transcribe()`; OGG/Opus из Telegram принимается без конвертации. Компромисс: качество на уровне Whisper, иногда выдумывает текст на тишине — проверяется на настоящих голосовых до кода (этап 5, 8.0), запасной вариант — ElevenLabs `scribe_v2`. Отклонены: OpenAI и Gemini (Россия не в списках поддерживаемых стран; у Gemini бесплатный тариф обучается на данных), ElevenLabs, Mistral и Deepgram (по умолчанию используют данные для обучения), Yandex SpeechKit (нет провайдера AI SDK, синхронный режим до 30 с, нерезиденты — только бизнес), локальный Whisper (не помещается в Vercel, нужен декодер OGG). Правило AGENTS.md о моделях уточняется (8.0). История выбора: исходное решение — подписка ChatGPT, его опроверг spike 0.8 (маршрут закрыт Cloudflare, 403 до API; подделывать клиента Codex не будем). ~~Подписка ChatGPT.~~ Приватный `/backend-api/transcribe`, код в `@repo/openai-subscription`. Соответствует правилу AGENTS.md «модели только из `@repo/openai-subscription`», без ключей и счетов. Риски: маршрут не документирован и может измениться; запрос может требовать заголовков Codex Desktop (в одной из реализаций видели `x-oai-attestation`); используется чатовая подписка не по прямому назначению (по этой причине Hermes отказался от такого PR). Если spike (п. 0.8) покажет, что маршрут недоступен, голосовые откладываются и вопрос о другом провайдере (`@ai-sdk/openai` с ключом Platform, нарушает правило AGENTS.md) возвращается владельцу; заранее он не готовится.
3. **Таблицы Chat SDK — в схеме `chat_sdk`, state-pg на отдельном прямом пуле (решено 4 октября 2026 по п. 0.6 spike).** Пулер Neon отклоняет `search_path` в `options`, прямое подключение его держит. Пул: `DATABASE_URL_UNPOOLED` (интеграция Neon уже задаёт его во всех окружениях), `max: 2`, `options=-c search_path=chat_sdk`. Правило database.md «`public` не используется» сохраняется. Сравнение вариантов ниже — обоснование.
4. **Распознанный текст владельцу не показывается (решено).** Агент сразу отвечает; транскрипт хранится в истории, и на вопрос «что ты услышал?» агент ответит по ней.

### Таблицы Chat SDK: `chat_sdk` или `public`

state-pg обращается к таблицам без имени схемы, поэтому всё упирается в `search_path` соединений адаптера.

|                   | Схема `chat_sdk`                                                                                                                                                                                                                                                                                                                          | `public` с исключением в database.md                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Договорённости    | Соответствует database.md: `public` не используется, у библиотеки своя схема, как у `dbos`.                                                                                                                                                                                                                                               | Нарушает правило «`public` не используется», нужна явная строка-исключение.                                                                                                                            |
| Настройка         | Адаптеру нужен `search_path=chat_sdk`. Варианты: `options=-c search_path=chat_sdk` в строке подключения (пулер Neon его отклоняет, поэтому отдельный пул на `DATABASE_URL_UNPOOLED`, `max: 2`, расходует прямые подключения Neon) или `ALTER ROLE … SET search_path` (неявная настройка базы вне кода, действует на все соединения роли). | Ничего: адаптер работает с общим пулом `getPool()` как есть.                                                                                                                                           |
| Миграция          | SQL пакета переписывается под схему (квалификация имён или `SET LOCAL search_path` в миграции); при обновлении пакета сравнение с исходником чуть сложнее.                                                                                                                                                                                | SQL `postgresSchemaStatements` копируется дословно; обновление пакета — прямой diff.                                                                                                                   |
| Доступ и изоляция | Схему можно закрыть отдельной ролью; видно, что эти таблицы принадлежат библиотеке.                                                                                                                                                                                                                                                       | Таблицы с префиксом `chat_state_*` рядом с пустым `public`; разграничить доступ схемой нельзя. Если spike покажет, что `chat_state_cache` хранит тексты сообщений, они окажутся вне закрываемой схемы. |
| Риск ошибки       | Если `search_path` потеряется, адаптер громко упадёт на `schemaProbe` при `autoCreateSchema: false`, а не создаст таблицы молча.                                                                                                                                                                                                          | Минимальный.                                                                                                                                                                                           |

Итог (раздел «Результаты spike»): пулер отклоняет `options=-c search_path=chat_sdk`, прямое подключение держит его на каждом запросе. Выбрана **схема `chat_sdk` с отдельным прямым пулом**. Цена — до 2 прямых подключений на экземпляр функции; для бота одного владельца это далеко от лимита Neon. Рассмотренные и отклонённые варианты:

- `ALTER ROLE … IN DATABASE … SET search_path` для роли приложения (рекомендация Neon для пуловых подключений): неявная настройка базы на все подключения роли, таблица без схемы тихо уезжает в `chat_sdk`.
- Отдельная роль Neon только для `chat_sdk`: лучшая изоляция, но роль вне Drizzle, ещё один секрет и настройка локального Docker.
- Свой `StateAdapter` на Drizzle: своя реализация lock, очередей и TTL.
- `@chat-adapter/state-redis` (Upstash): новый внешний сервис.
- Опция `schema` в state-pg: её нет и её не просили ([vercel/chat#722](https://github.com/vercel/chat/issues/722) дал только `autoCreateSchema`); PR возможен позже, тогда отдельный пул убирается.

## 3. Этап 0. Spike на dev-боте (2–3 часа)

Без коммитов в `main`: скрипты в `scratchpad`/ветке, результат — короткая запись в разделе «Результаты spike» этого файла.

Из research-документа (раздел 10), без изменений:

1. Убить функцию посреди хода: сколько держится lock, доставится ли очередь, что лежит в `chat_state_*`.
2. Очередь при `queue`: A идёт (модель удерживается управляемым потоком), отправить B, C, D, завершить A. Ожидается один ход: D в `message`, B и C в `context.skipped`, порядок сохранён. **Одно из B/C/D — голосовое**: проверить, что `fetchData()` работает после очереди (по исходникам — да).
3. Ошибка модели посреди `fullStream`: отклоняется ли `thread.post`, что видит владелец.
4. `nativeStreaming`: черновик в Telegram для iOS и macOS, tool дольше 30 с.
5. Чужой аккаунт: сообщение и `callback_query` без ответа и без записи в state; `TELEGRAM_OWNER_ID=" "` → `ConfigurationError`.
6. **Схема state-pg.** ~~Держит ли Neon `search_path=chat_sdk`~~ — проверено: пулер отклоняет, прямое подключение держит (раздел «Результаты spike»). Осталось: что именно адаптер кладёт в `chat_state_cache` (тексты сообщений?).
7. Карточка с `/** @jsxImportSource chat */` собирается в Next.js рядом с React.

Голосовые:

8. **Маршрут транскрипции.** Скриптом с настоящей сессией (локальная база, `createOpenAIAuth`) отправить на `/backend-api/transcribe` байты из `fetchData()` голосового Telegram **как есть** (OGG/Opus, без перекодирования — на Vercel нет ffmpeg) через `createAuthenticatedFetch` с заголовками атрибуции, которые уже шлёт `codex-transport`. Записать: нужен ли `x-oai-attestation` и прочие заголовки Codex Desktop; принимается ли `audio/ogg`; форма ответа (JSON с `text`?); ответ на пустой и битый файл; предел размера/длительности (проверить файлы 1, 5 и 15 минут); время ответа на 1 и 5 минутах (основа для `TRANSCRIBE_TIMEOUT_MS`); поведение при 401 и 429.
9. Голосовое с подписью: `text` = подпись, вложение `audio` есть.
10. Кружок (`video_note`): что именно приходит, чтобы ответить «пока не понимаю».

**Выход из spike.** Если п. 1–3 дают неприемлемое поведение — альтернатива из research-документа (свой клиент Bot API). Если п. 8 не проходит без attestation — голосовые этапа 5 откладываются, вопрос о провайдере возвращается владельцу (п. 2.2); этапы 1–4 идут без изменений.

## 4. Этап 1. Общий ход агента

Цель — одна функция хода для обоих каналов; контракт `/api/agent` и `chat.tsx` не меняются.

- `apps/core/src/lib/agent.ts`: `SYSTEM_PROMPT` и `runAgentTurn({ messages, signal })` по эскизу 5.4 research-документа. Возвращает `NotLoggedInError | ReauthRequiredError | Error | { stream, finished }`; `finished: Promise<Error | ResponseMessage[]>` (ошибки модели приходят в `onError`, `streamText` не бросает). Абстракция обоснована двумя вызывающими: `/api/agent` и Telegram.
- `apps/core/src/app/api/agent/route.ts`: вызывает `runAgentTurn`; при login required — прежний `loginRequiredResponse` (409); поток — через `toUIMessageStream`, как сейчас.
- В `onError` ошибка сохраняется как есть (без обёртки), чтобы канал мог отличить ошибку входа (`isLoginRequired`) от прочих: токен может умереть уже после предварительной проверки (401 → неудачный refresh → `ReauthRequiredError` из `provider.ts`).
- Тесты. Существующий `test/agent.test.ts` проверяет только 401 и 400, до изменяемой логики, поэтому добавить в него сценарии `POST /api/agent` с валидным сообщением (сеть Codex — через `vi.stubGlobal("fetch")`; `createOpenAIAuth` через `vi.mock("@/lib/openai")` отдаёт настоящий `OpenAISubscriptionAuth` с `MemoryCredentialStore` из пакета, а `createDeviceLoginStore` — настоящий `PostgresDeviceLoginStore` поверх PGlite с миграциями, как в `packages/db/test/openai-store.test.ts`): нет сессии → 409 с `login`; ответ модели → читаемый UI-поток с ожидаемым текстом; ошибка посреди потока → текст «Модель не ответила…». Отдельно `runAgentTurn` с `vi.stubGlobal("fetch")` для Codex: ответ → `finished` резолвится сообщениями; ошибка посреди потока → `finished` резолвится ошибкой; 401 и неудачный refresh посреди хода → `finished` резолвится `ReauthRequiredError` (проверка `isLoginRequired`).

## 5. Этап 2. Данные

Перед началом перечитать [database.md](../architecture/database.md).

**Схема `chat`** (Drizzle, `packages/db/src/schema/chat.ts`, добавить в `schema/index.ts` и `schemaFilter`):

| Таблица              | Поля                                                                                                                                                         | Зачем                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `chat.conversations` | `id`, `channel` (`telegram`), `external_id` (thread.id), `created_at`, `closed_at` (nullable); уникальный индекс на открытый диалог `(channel, external_id)` | Один открытый диалог на чат; `/new` закрывает текущий.                                          |
| `chat.messages`      | `id`, `conversation_id`, `seq`, `ui_message jsonb` (роль — внутри `UIMessage`), `voice jsonb` (nullable), `created_at`; уникальный `(conversation_id, seq)`  | История в формате `UIMessage`. `voice` — см. ниже.                                              |
| `chat.turns`         | `id`, `conversation_id`, `status` (`processing`/`awaiting_login`/`done`/`failed`), `started_at`, `deadline_at`, `error`, `reported_at` (nullable)            | Видимость сбоев. `lost` = `processing` с прошедшим `deadline_at`, `reported_at` — уже сообщили. |

`chat.messages.voice` (для голосовых): `{ fileId, fileUniqueId, durationSec, sizeBytes, mimeType, status: "pending" | "transcribed" | "failed" }`. Аудио в базе не хранится никогда, только `file_id` Telegram (действует долго, в отличие от ссылки `getFile`) и итоговый транскрипт в `ui_message` как обычная текстовая часть. Пометка «голосовое» — в `metadata` `UIMessage`, чтобы модель и будущий UI могли её учесть.

**Таблицы Chat SDK:** пустая миграция `pnpm --filter @repo/db db:generate --custom --name chat_sdk_state`, в неё — `CREATE SCHEMA chat_sdk;`, `SET LOCAL search_path TO chat_sdk;`, затем SQL из `postgresSchemaStatements` 4.41.1 дословно и `RESET search_path;` в конце (миграции Drizzle идут одной транзакцией, а журнал `drizzle.__drizzle_migrations` и наши миграции используют полные имена). Схему `chat_sdk` в `schemaFilter` не добавлять: drizzle-kit не должен считать эти таблицы своими. При обновлении `@chat-adapter/state-pg` сравнивать `postgresSchemaStatements`, изменения — новой миграцией.

**Хранилище** `apps/core/src/lib/chat-store.ts` (или `packages/db/src/chat-store.ts` рядом с `openai-store.ts` — по тому, где проще тестировать на PGlite; выбрать `packages/db`):

- `conversations.forTelegram(threadId)` — найти или создать открытый диалог.
- `turns.begin(conversationId, userMessages)` — в одной транзакции: строка хода `processing` с `deadline_at = now + 330 s` и сообщения пользователя по порядку.
- `turns.reportLost`, `turns.awaitLogin`, `turns.fail`, `turns.done`, `turns.resumeAwaiting`.
- `history.load(conversationId)` — последние N сообщений (окно по количеству, резюме — позже); `history.appendAssistant`.
- `voice.pending(conversationId)`, `voice.setTranscript(messageId, text)`, `voice.markFailed(messageId)`.

Все функции возвращают `Error | T`. `getStatePool()` в `apps/core/src/lib/db.ts` — отдельный пул для state-pg через существующий `createDatabase(url, { max: 2, options: "-c search_path=chat_sdk" }).pool` на `DATABASE_URL_UNPOOLED`, `attachDatabasePool`. Пуловый адрес (`-pooler`) отклоняется `ConfigurationError`, как в `migrate.ts`. Если строка подключения принесёт свои `options`, они перекроют наши, и адаптер громко упадёт на `schemaProbe` (`autoCreateSchema: false`), поэтому объединять их не нужно. Drizzle-клиент `getDb()` не меняется.

Тесты (`packages/db/test/chat-store.test.ts`, PGlite + миграции, как `openai-store.test.ts`): порядок сообщений серии; `reportLost` находит просроченный `processing` один раз; `/new` даёт новый диалог; голосовое сохраняется `pending`, после `setTranscript` попадает в `history.load` текстом. **Атомарность `turns.begin`:** серия, в которой второе сообщение нарушает ограничение БД (например, `ui_message` с `null` при `NOT NULL`, переданный в обход типов через `as never` в тесте), даёт `Error`, не оставляет ни строки хода, ни первого сообщения, а прежняя история цела.

## 6. Этап 3. Бот, вебхук, обработчик

Файлы по эскизам research-документа (разделы 5.1–5.3), с правками:

- `apps/core/src/lib/telegram/bot.ts` — `getBot()`: явные переменные, проверка `TELEGRAM_OWNER_ID` регуляркой, `state` с `autoCreateSchema: false`, `concurrency: { strategy: "queue", maxQueueSize: 20, queueEntryTtlMs: 600_000 }` (дефолт 90 с короче долгого хода).
- `apps/core/src/app/api/telegram/webhook/route.ts` — `createHandler`, `maxDuration = 300`, `bot.webhooks.telegram(request, { waitUntil: (task) => after(() => task) })`.
- `apps/core/src/lib/telegram/handlers.ts` — `onDirectMessage((thread, message, channel, context) => …)` → `handleOwnerMessages(thread, [...(context?.skipped ?? []), message])` (spike 0.2: `context` — четвёртый параметр, эскиз 5.3 research-документа ошибается); граница: обработчик не бросает, ошибки → `failed` и сообщение владельцу. Сбой модели не отклоняет `thread.post` и оставляет в Telegram оборванный ответ, неотличимый от законченного (spike 0.3): обработчик правит это сообщение — оставляет успевший текст и дописывает пометку «⚠️ Ответ оборвался, попробуйте ещё раз» — `thread.post` возвращает `SentMessage` с `edit()` (есть в типах `chat` 4.41.1).
- Команды: `onSlashCommand` — `/new` закрывает диалог, `/start` — приветствие, прочие — короткий ответ «не знаю такой команды». Без обработчика Chat SDK молча игнорирует всё, что начинается с `/` (spike).
- Порядок истории — порядок записи (обработки), `chat.messages.seq` растёт при вставке. `message_id` Telegram хранится в метаданных `UIMessage` для справки, но порядок по нему не строится. Причина (spike 0.1): после падения застрявшее сообщение `:16` обрабатывается после более нового `:17` и ответа на него. По `message_id` история хода `:16` была бы `14, 16, 17, ответ на 17` — отвечаемое сообщение в середине, последним идёт ответ ассистента. По порядку обработки — `14, 17, ответ, 16, ответ`, история связная. В обычной очереди (spike 0.2) оба порядка совпадают.
- Стратегия очереди: `queue` проверена (spike 0.2). Пересылка с комментарием приходит двумя сообщениями с разницей ~0,6 с и даёт два хода (spike 0.9); при реализации сравнить с `debounce` (`debounceMs` ~1500) и выбрать.
- Стриминг — режим по умолчанию (сообщение и правки), без `nativeStreaming` (spike 0.4).
- Конфигурация: если к началу этапа в `main` уже `apps/core/src/lib/config.ts`, переменные `TELEGRAM_*` и `DATABASE_URL_UNPOOLED` идут в его zod-схему, `.env.example` и `passThroughEnv` сборки в `turbo.json`, проверка `TELEGRAM_OWNER_ID` (`^[1-9]\d*$`, spike: пустой список отключает белый список) и запрет `-pooler` для `DATABASE_URL_UNPOOLED` — в схеме. `TELEGRAM_BOT_TOKEN` задаётся только в Production, а схема проверяется на сборке, поэтому токен и связанные переменные в схеме необязательны, а `getBot()` возвращает `ConfigurationError`, если их нет.
- Каждый вызов Chat SDK (`thread.post`, `fetchData`) — в `tryAsync`.
- **Ошибки входа не теряют тип.** Где ошибка может оказаться ошибкой входа (`thread.post(stream)`, `run.finished`), `tryAsync` вызывается с `catchFn`, возвращающим исходную ошибку: без него `tryAsync` оборачивает её в `UnhandledError`, а `isLoginRequired` проверяет только `instanceof`. Ошибка входа на любом шаге — до потока или из `run.finished` — переводит ход в `awaiting_login` и шлёт карточку, а не `failed`.
- Обработчик пропускает вложения, которые не умеет (картинки, документы, музыкальные файлы, кружки), с коротким ответом «Пока понимаю только текст» (до этапа 5 — и для голосовых; после него «Пока понимаю текст и голосовые»). Картинки — позже (`codex-transport` их принимает).

Тесты — два уровня, без `createMemoryState()`:

- `apps/core/test/telegram-webhook.test.ts`: настоящий Chat SDK в режиме webhook и настоящий state-pg, `vi.stubGlobal("fetch")` отвечает за Bot API и Codex. Сценарии: неверный `secret_token` → не 200 и без хода; чужой `from.id` → без ответа; сообщение владельца → `sendMessage`/`editMessageText` с ответом, ход `done`, история в базе; ошибка модели → `failed` и «Не получилось ответить»; 401 и неудачный refresh посреди потока → ход `awaiting_login` и карточка.
- `apps/core/test/telegram-state.test.ts` (интеграция state-pg): полноценный Postgres из `compose.yaml` (решение владельца: тесты могут поднимать настоящую базу). `globalSetup` Vitest в `apps/core` выполняет `docker compose up -d --wait` и пересоздаёт базу `majordomo_test`; адрес — дефолт compose, не из `.env.local`; миграции `packages/db`, `autoCreateSchema: false`. Новых зависимостей не нужно. Сценарии: адаптер стартует на мигрированной схеме; повтор того же `update_id` не даёт второго хода; два экземпляра `Chat` на одной базе — A держит lock (ответ модели удерживается управляемым потоком, без реального ожидания), B, C, D приходят во второй экземпляр, после A — один ход с D в `message` и B, C в `skipped`, порядок сохранён, голосовое среди них скачивается. PGlite здесь не подходит: state-pg требует `pg.Pool` с несколькими соединениями. `pnpm test` для `@repo/core` требует запущенного Docker, как и `pnpm dev`; без него `globalSetup` падает с понятным сообщением. В AGENTS.md («Tests and type checks do not need the env file») дописать, что тестам `@repo/core` нужен Docker.

## 7. Этап 4. Вход в ChatGPT из чата

- `apps/core/src/lib/telegram/login.tsx` — `postLoginCard(thread)` и `handleLoginCheck(event)` по эскизу 5.5; `complete` → `turns.resumeAwaiting` и повтор хода по сохранённой истории.
- **Уведомление о смерти сессии — из cron, не из `onReauthRequired`.** Колбэк синхронный (`(info) => void`) и вызывается без `await` (`auth.ts`, `reportReauth`), поэтому отправка из него может оборваться, когда функция Vercel завершится. Вместо этого `/api/cron/openai-refresh` при `refreshIfDue()` → `{ state: "reauth_required" }` сам ждёт отправки карточки через `bot.openDM(ownerId)` (ошибка отправки логируется, ответ cron остаётся 200 с результатом проверки). Пока сессия мертва, владелец получает напоминание раз в сутки. В ходе Telegram карточку и так шлёт обработчик. `TODO` в `openai.ts` удаляется, его смысл переезжает в doc-комментарий `createOpenAIAuth`.
- Тесты: нет сессии → карточка и ход `awaiting_login`; нажатие кнопки при `pending` → короткий ответ; при `complete` → ответ на отложенное сообщение; cron при `reauth_required` → `sendMessage` с карточкой выполнен до ответа route.

## 8. Этап 5. Голосовые сообщения

Провайдер — Groq, `whisper-large-v3` (п. 2.2). Начинается после этапов 3–4.

### 8.0 Подготовка и проверка качества

- Владелец создаёт ключ в console.groq.com и **включает Zero Data Retention** в настройках данных организации (по умолчанию Groq не обучает и не хранит данные, но до 30 дней может держать их для отладки и abuse; ZDR это выключает).
- Зависимость: `@ai-sdk/groq` в `@repo/core`, версия закрепляется точно (на 4 октября 2026 — 4.0.54; зависит от `@ai-sdk/provider` 4.0.21 — сверить с версией в `@repo/openai-subscription` при установке).
- AGENTS.md: правило «Models come only from `@repo/openai-subscription`» уточняется — языковые модели только из подписки, распознавание речи — Groq через `@ai-sdk/groq` (подписка его не даёт, spike 0.8).
- Переменная `GROQ_API_KEY`: в схему `config.ts` (необязательная — без неё голосовые отвечают «Распознавание голосовых не настроено», остальной бот работает), `.env.example`, `passThroughEnv` в `turbo.json`, таблица переменных database.md. На Vercel — Production; локально — свой ключ.
- **Проверка качества до кода:** одноразовый скрипт (не в `main`) прогоняет 5–10 настоящих голосовых владельца через `transcribe({ model: groq.transcription("whisper-large-v3") })` дважды — с `language: "ru"` и без языка. Владелец сравнивает расшифровки. Решается: задавать ли `language: "ru"` (точнее и быстрее на русском, но портит голосовые на других языках); если качество неприемлемо — возврат к выбору провайдера (запасной — ElevenLabs `scribe_v2` с выключенным обучением).

### 8.1 Распознавание

- `apps/core/src/lib/telegram/voice.ts`: прямой вызов `transcribe({ model: createGroq({ apiKey: config.GROQ_API_KEY }).transcription("whisper-large-v3"), audio: bytes, providerOptions: { groq: { language } }, abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS) })` в `tryAsync` с `catchFn`, сохраняющим исходную ошибку. Своей модели или обёртки не нужно: провайдер готовый, вызывающий один.
- Аудио — байты из `fetchData()`, OGG/Opus как есть (Groq принимает `ogg`, до 25 МБ на бесплатном плане; Telegram отдаёт боту не больше 20 МБ). Ссылку `getFile` не передавать.
- `TRANSCRIBE_TIMEOUT_MS` — 60 000 для начала (Groq обрабатывает минуту аудио за доли секунды); уточнить по замерам проверки 8.0.
- Бесплатный план Groq: 20 запросов в минуту и 28 800 аудиосекунд в день — с большим запасом для одного владельца; оплата при превышении — около $0,11 за час аудио (минимум 10 с за запрос). 429 от Groq — та же ветка «не смог распознать».

### 8.2 Поток в обработчике

```
серия [...skipped, message]
  → для каждого сообщения по порядку: текст / голосовое / неподдерживаемое
  → turns.begin: пишет все сообщения; голосовые — с voice.status = pending, без текста
  → transcribePending(conversationId): для каждого pending по порядку
       проверка лимитов → fetchData() → transcribe() → voice.setTranscript
  → history.load → runAgentTurn → thread.post → turns.done
```

- `transcribePending(bot, conversationId)`: скачивание по сохранённому `fileId` через `adapter.rehydrateAttachment({ type: "audio", fetchMetadata: { fileId } }).fetchData()` — одинаково для свежих сообщений, сообщений из очереди (spike 0.2) и недораспознанных после падения функции.
- **Распознавание не зависит от сессии ChatGPT.** Если сессии нет, голосовые всё равно распознаются и сохраняются текстом, ход уходит в `awaiting_login`, после входа повторяется по уже сохранённой истории. `pending` после хода значит только «функция умерла до распознавания»; следующий ход распознаёт такие голосовые первыми.
- **Лимиты до скачивания:** `size > 20 MB` или `duration > VOICE_MAX_SECONDS` (900 с для начала: Groq укладывается в бюджет 300 с с большим запасом) → сообщение `failed`, владельцу «Голосовое слишком длинное, разбейте на части», ход продолжается по остальным сообщениям серии; если других нет — ход `done` без вызова модели.
- **Порядок:** транскрипт встаёт на место своего сообщения (`seq`), смешанная серия «текст, голос, текст» уходит в модель в исходном порядке.
- **Пересылка с комментарием** приходит двумя сообщениями (spike 0.9); при `queue` это два хода, при `debounce` — один (выбор в этапе 3). Подписи у голосового, записанного в Telegram, не бывает; если `caption` всё же есть — одна текстовая часть `«<транскрипт>\n\n<подпись>»`.
- **Пометка голоса:** транскрипт хранится обычной текстовой частью `UIMessage`, `metadata.voice = { durationSec }`; модели перед текстом добавляется «(голосовое)», чтобы она учитывала возможные ошибки распознавания. Распознанный текст владельцу не показывается (п. 2.4).
- **Ошибка распознавания** (сеть, 5xx, 429, таймаут, пустой текст, отказ скачивания): сообщение `failed`, владельцу «Не смог распознать голосовое, повторите текстом или ещё раз»; если в серии есть другие сообщения — ход по ним и `done`, иначе ход `failed`.
- **Галлюцинации Whisper на тишине:** известная особенность; отдельной защиты не делаем, пока не встретится на практике (решение по итогам 8.0).
- **Кружки и музыкальные файлы:** вне объёма. Обрабатывается только `raw.voice`; кружок (`type: "video"`, spike 0.10) и присланный аудиофайл (`raw.audio`) получают общий ответ о неподдерживаемом вложении.
- **Безопасность:** ссылку `getFile` (содержит токен бота) не логировать и не передавать никуда; в логах — `fileUniqueId` и длительность, не текст. Голосовые уходят в Groq — третью сторону; ZDR включён (8.0).
- **Индикатор:** на время распознавания `thread.startTyping()`, если адаптер поддерживает.

### 8.3 Тесты

`apps/core/test/telegram-voice.test.ts`, тот же стенд, что в этапе 3; `vi.stubGlobal("fetch")` отвечает за Bot API (`getFile`, скачивание файла), `api.groq.com` (`/openai/v1/audio/transcriptions`) и Codex:

- голосовое → запрос в Groq с файлом `audio/ogg` и ключом, транскрипт в истории текстом с `metadata.voice`, ответ модели по нему, байты не в базе;
- серия «текст, голос» → модель получает оба в исходном порядке;
- серия «текст A, голосовое с 5xx от Groq, текст B» → модель получает A и B по порядку, голосовое `failed`, ход `done`;
- лимиты: длительность больше лимита при допустимом размере и размер больше 20 МБ при допустимой длительности → без скачивания и без запроса в Groq, ответ про длину; значения ровно на границах → распознаются; одиночное отклонённое голосовое → ход `done` без вызова модели;
- нет сессии ChatGPT → голосовое распознано и сохранено, ход `awaiting_login`, карточка; после «Я ввёл код» → ответ по сохранённому транскрипту без повторного запроса в Groq;
- одиночное голосовое: 5xx и 429 от Groq, пустой транскрипт, ошибка `getFile`/скачивания → «Не смог распознать», ход `failed`;
- зависший ответ Groq → отмена по таймауту (`vi.useFakeTimers()`), «Не смог распознать»;
- нет `GROQ_API_KEY` → «Распознавание голосовых не настроено», текстовые сообщения серии обрабатываются;
- кружок и аудиофайл → ответ о неподдерживаемом вложении, модель не вызывается.

## 9. Этап 6. Эксплуатация и документация

- `apps/core/scripts/telegram-webhook.ts` — регистрация вебхука (эскиз 9 research-документа), `allowed_updates: ["message", "callback_query"]`, токен не печатать.
- `apps/core/scripts/telegram-dev.ts` — dev-бот в режиме polling (локальный Postgres из Docker, не `createMemoryState`, чтобы проверять ту же схему).
- Ежедневный cron (`/api/cron/openai-refresh` или соседний) дополнительно проверяет `getWebhookInfo` (`pending_update_count`, `last_error_message`) и находит просроченные ходы.
- `apps/core/.env.example`, таблица переменных в database.md: `TELEGRAM_BOT_TOKEN` (только Production, локально — dev-бот), `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OWNER_ID`, `TELEGRAM_BOT_USERNAME`; с этапа 5 — `GROQ_API_KEY`.
- database.md: в таблицу схем — `chat` (Drizzle) и `chat_sdk` (state-pg Chat SDK, SQL пакета в нашей миграции, сравнивать `postgresSchemaStatements` при обновлении); `chat_sdk`, как `dbos`, не попадает в `schemaFilter`. В таблице переменных `DATABASE_URL_UNPOOLED` теперь нужен и в рантайме: прямой пул state-pg (почему не пуловый — пулер Neon отклоняет `search_path`).
- `apps/core/README.md`: ручка `/api/telegram/webhook`, настройка ботов у @BotFather (`/setjoingroups` выключить), голосовые и их лимиты.

## 10. Порядок, проверки и источники

Порядок: 0 → 1 → 2 → 3 → 4 → 5 → 6. Этап 1 можно делать параллельно со spike. Каждый этап — отдельный коммит/PR и заканчивается `pnpm format`, `pnpm check-types`, `pnpm lint`, `pnpm test` без ошибок. Тесты — по навыку `minimal-mock-testing`: настоящие Chat SDK, state-pg, PGlite/Postgres из Docker и миграции; подменяется только сеть (`vi.stubGlobal("fetch")`) и время (`vi.useFakeTimers()` для `deadline_at` и таймаута транскрипции).

Позже, вне плана: Vercel Workflow (раздел 7 research-документа), подтверждения действий кнопками, картинки, резюме длинной истории, ответы голосом.

Риски:

- Качество распознавания русского у Whisper может не устроить владельца — проверка на настоящих голосовых до кода (8.0), запасной провайдер — ElevenLabs. Голосовые уходят третьей стороне (Groq, ZDR включён).
- Длинные голосовые съедают бюджет 300 с хода: лимит длительности обязателен.
- Голосовые проходят через серверы OpenAI так же, как текст: решение о допустимости то же, что для выбора LLM.

Источники по транскрипции:

- [openai/codex#20668](https://github.com/openai/codex/issues/20668): диктовка Codex Desktop шлёт multipart на `/backend-api/transcribe`, API-ключ не принимается.
- [NousResearch/hermes-agent#77840](https://github.com/NousResearch/hermes-agent/pull/77840): распознавание голосовых через Codex OAuth, OGG проходил; PR закрыт из-за приватности маршрута.
- [can1357/oh-my-pi#12853](https://github.com/can1357/oh-my-pi/pull/12853): поле `file`, WAV, заголовки Codex Desktop включая `x-oai-attestation`.
- Groq: [speech-to-text](https://console.groq.com/docs/speech-to-text) (форматы, лимиты, цена), [rate limits](https://console.groq.com/docs/rate-limits) (бесплатный план), [your data](https://console.groq.com/docs/your-data) (обучение, хранение, ZDR); документация `@ai-sdk/groq` 4.0.54 (`groq.transcription`, `providerOptions.groq.language`).
- Сравнение провайдеров распознавания (4 октября 2026): [OpenAI supported countries](https://developers.openai.com/api/docs/supported-countries), [Gemini available regions](https://ai.google.dev/gemini-api/docs/available-regions), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [ElevenLabs и обучение](https://elevenlabs.io/docs/help-center/legal/is-my-data-used-to-improve-eleven-labs-ai-models), [Deepgram MIP](https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program), [Mistral opt-out](https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training), [Yandex SpeechKit](https://aistudio.yandex.ru/docs/en/speechkit/stt/), [Telegram transcribeAudio](https://core.telegram.org/method/messages.transcribeAudio).
- `ai/docs/03-ai-sdk-core/36-transcription.mdx`, `@ai-sdk/provider` 4.0.19 `TranscriptionModelV4`.
- Исходники `@chat-adapter/telegram` 4.41.1 (`extractAttachments`, `downloadFile`, `rehydrateAttachment`), `chat` 4.41.1 (`drainQueue`, `rehydrateMessage`), `@chat-adapter/state-pg` 4.41.1 (`postgresSchemaStatements`, `schemaProbe`).

## Результаты spike

**0.6, `search_path` на пулере Neon — 4 октября 2026.** Скрипт `packages/db/scripts/check-search-path.ts` на ветке Neon, пуловый адрес. Подключение с `options=-c search_path=chat_sdk` отклонено:

> `08P01 unsupported startup parameter in options: search_path. Please use unpooled connection or remove this parameter from the startup package.`

Второй прогон в тот же день, прямой адрес той же ветки: пул с `options` — 250 из 250 запросов видят `chat_sdk` (10 серверных подключений, отдельные запросы и явные транзакции), контрольный пул — 250 из 250 `"$user", public`. Общих серверных подключений 0, как и ожидается без пулера.

Вывод: схема `chat_sdk` и отдельный прямой пул для state-pg (п. 2.3).

Попутно: `pg` предупреждает, что `sslmode=require` сейчас трактуется как `verify-full`, а в pg 9 станет слабее (семантика libpq). Касается и `DATABASE_URL` приложения; решается отдельно, явным `sslmode=verify-full`, до обновления на pg 9.

**0.8, `/backend-api/transcribe` по подписке — 4 октября 2026. Не проходит.** Одноразовый скрипт spike (Chat SDK в режиме webhook, relay через `getUpdates`, тестовая модель; код не сохранялся): голосовое 3 с из Telegram, `fetchData()` вернул 16 264 байта `audio/ogg`. `POST https://chatgpt.com/backend-api/transcribe` (multipart `file`) с `Authorization` + `ChatGPT-Account-Id`, а также с ними и подписью `originator: majordomo` / `User-Agent` из `defaultAttribution()`: оба ответа **403 за 30–45 мс, HTML-страница Cloudflare** (`cf-ray`), до API запрос не доходит. Сторонние реализации проходят этот экран, подделывая отпечаток клиента Codex Desktop; так мы не делаем (обход защиты от ботов). Вывод: голосовые этапа 5 отложены, вопрос о провайдере распознавания возвращается владельцу (п. 2.2).

**0.2, очередь при `queue` — 4 октября 2026. Работает как ожидалось.** Режим webhook, обновления через relay с немедленным подтверждением. A = 60-секундный ответ тестовой модели; во время него пришли `B`, голосовое 4 с и `D` — `message-queued`, глубина 1→2→3, lock продлевается heartbeat-ом (`updated_at` каждые ~10 с, `expires_at` +30 с). После A — один вызов обработчика: `message` = D, `context.skipped` = [B, голосовое], порядок сохранён; `fetchData()` голосового из очереди вернул 19 185 байт `audio/ogg` (`rehydrateAttachment` срабатывает). `expires_at` записей очереди = постановка + `queueEntryTtlMs` (600 с).

**0.1, падение посреди хода — 4 октября 2026.** Процесс убит во время 60-секундного ответа (SIGINT, без снятия lock). Итоги:

- Lock умершего процесса истекает сам: TTL 30 с от последнего продления, heartbeat примерно раз в 10 с. Чат не блокируется надолго.
- Сообщение, пришедшее, пока висит мёртвый lock, ставится в очередь, и разбирать её некому: очередь разбирает только держатель lock. Оно ждёт следующего входящего сообщения, а без него пропадает молча через `queueEntryTtlMs`.
- Следующее сообщение берёт новый lock и обрабатывается **первым**; застрявшее идёт после него **отдельным ходом**, не одной серией. Порядок обработки не совпадает с порядком отправки.
- Оборванный ответ остаётся в Telegram как есть.

Следствия для этапов 2–3: `chat.messages.seq` — порядок обработки, не `message_id` Telegram (разбор — в этапе 3: по `message_id` история застрявшего хода получилась бы несвязной); потерянный ход виден через `chat.turns` (`lost`). Сообщение, застрявшее в очереди после падения, — известная граница гарантий этапа 1 (раздел 4.3 research-документа), закрывается только долговечной записью до 200.

- Неизвестные слэш-команды (`/slow`, `/state` без `onSlashCommand`) Chat SDK молча игнорирует, владелец не видит реакции. Нужен обработчик `onSlashCommand` с `/new` и коротким ответом на прочие команды.

**0.3, ошибка модели посреди `fullStream` — 4 октября 2026.** Тестовая модель выдаёт половину текста и `error`. `streamText` вызывает `onError`, а `thread.post(fullStream)` **разрешается успешно** — по нему сбой не виден. В Telegram остаётся успевшая уйти часть ответа, оборванная на полуслове, без признака ошибки (Telegram для iOS); старый клиент для macOS показывал на её месте пустой пузырь — особенность клиента, не разбиралась. Владелец не отличит оборванный ответ от законченного. Следствия для этапа 3: о сбое обработчик узнаёт только из `run.finished` (`onError`), как и заложено; оборванный ответ правится через результат `thread.post` (`SentMessage.edit()`, есть в типах `chat` 4.41.1): к успевшему тексту дописывается пометка о сбое.

**0.4, черновики (`nativeStreaming`) — 4 октября 2026.** Ответ с паузой 40 с посередине. На телефоне: печать начинается, останавливается, через ~30 с без обновлений ответ пропадает, в конце весь текст печатается заново. Адаптер не продлевает черновик во время паузы. Решение: режим по умолчанию (сообщение и правки), `nativeStreaming` не включать, пока адаптер не держит черновик живым; вернуться к вопросу, когда у агента появятся долгие tools.

**0.9, голосовое и подпись — 4 октября 2026.** Голосовое без подписи: `message.text === ""`, одно вложение `audio`, `mimeType: "audio/ogg"`, `raw.voice.duration` — секунды. «Голосовое с подписью» на практике — пересылка с комментарием, и Telegram присылает **два сообщения**: сначала текст комментария, через ~0,6 с само голосовое. При `queue` обработчик уже взял текст, поэтому получаются два хода: ответ на комментарий раньше, чем на голосовое. Для этапа 3 рассмотреть стратегию `debounce` (`debounceMs` ~1500): серия, пришедшая в окне, обрабатывается одним ходом ценой задержки ответа; решить при реализации.

**0.10, кружок.** Вложение `type: "video"`, `raw.video_note.duration` — секунды, `text === ""`. Ответ «пока не понимаю» реализуем без особенностей.

**0.6, что хранит Chat SDK.** `chat_state_cache` — только флаги дедупликации без текста: `telegram:webhook-update:<hash>:<update_id>` на 24 ч и `dedupe:telegram:<chat>:<message>` на 10 мин. `chat_state_lists` — **история чата**: `msg-history:telegram:<chat>`, сериализованные сообщения целиком (текст, `formatted`, сырой Telegram-объект), TTL 7 дней. Тексты переписки лежат и в схеме `chat_sdk`; учесть в решении о шифровании и доступе (открытые вопросы раздела 6 research-документа).

**Попутные находки.**

- `onDirectMessage(thread, message, channel, context)`: третий параметр — `channel`, `context.skipped` — в четвёртом. Эскиз 5.3 research-документа читает `context` из третьего и молча теряет серию.
- Сообщения, начинающиеся с `/` (`/start`), Chat SDK отдаёт обработчикам слэш-команд (`onSlashCommand`), а не `onDirectMessage`. `/new` регистрируется через `onSlashCommand`; без обработчика команда игнорируется.
- `allowedUserIds: [" "]` после `trim().filter(Boolean)` становится пустым списком, и адаптер отключает проверку (исходник `@chat-adapter/telegram` 4.41.1): бот открыт всем. Строгая проверка `TELEGRAM_OWNER_ID` в конфигурации обязательна; отдельный spike-пункт не нужен.

**Не проверялись:** п. 0.5 (чужой аккаунт) — поведение `allowedUserIds` подтверждено по исходнику, проверяется тестами этапа 3; п. 0.7 (карточка на JSX в Next.js) — проверяется на этапе 4.

**Итог spike.** Chat SDK подходит: очередь, lock, дедупликация и восстановление после падения ведут себя предсказуемо, альтернатива со своим клиентом Bot API не нужна. Голосовые через подписку ChatGPT невозможны (0.8) — распознавание вынесено в Groq (п. 2.2). Код spike, его ветка и база `majordomo_spike` удалены после проверки; в `main` ничего не попало.
