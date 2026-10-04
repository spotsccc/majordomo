# Vercel Workflow вместо DBOS

Срез источников: 30 сентября 2026. Объект: раздел «DBOS» в [database.md](../architecture/database.md#dbos) (строки 73–87) и связанный с ним код.

Методика. Все утверждения о Vercel Workflow и DBOS взяты из официальной документации, npm-реестра и GitHub. Ссылка стоит у каждого утверждения. Выводы без источника помечены как «инженерная оценка». Код ниже — эскизы, **не запускались**.

## 1. Вывод

- **Если сервер остаётся на Vercel без отдельного воркера, Vercel Workflow подходит лучше DBOS.** Рекомендованная DBOS схема для Vercel требует cron раз в минуту, а на Hobby такой cron не пройдёт деплой. Vercel Workflow двигает `sleep`, повторы и ожидания через Vercel Queues, поэтому cron ему не нужен.
- **Если появится постоянно работающий воркер (Fly.io, Railway, VPS), DBOS сильнее.** Его состояние лежит в нашей Neon, а отметка шага пишется в одной транзакции с предметными данными. Vercel Workflow хранит состояние у Vercel, и эта атомарность теряется.
- **Цена перехода на Workflow:**
  - секреты и чувствительные данные нельзя передавать между шагами;
  - каждая запись в базу внутри шага должна быть идемпотентной;
  - история запусков ведётся в своих таблицах, потому что на Hobby Vercel хранит её 1 день;
  - нужно следить за бюджетом событий: на Hobby это 50 тыс. в месяц.
- **Зрелость.** Workflow с апреля в GA, и это сильнее DBOS-интеграции с AI SDK, которая ещё до 1.0. Но `workflow@5.0.0` вышел сегодня, 30.09, с ломающими изменениями. Версии нужно закреплять точно, как раньше требовали для Eve и DBOS.

## 2. Как планировалось использовать DBOS

Из [database.md](../architecture/database.md#dbos), [migrate.ts](../../packages/db/src/migrate.ts) и [client.ts](../../packages/db/src/client.ts):

| Решение                                                                                       | Зачем                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Схема `dbos` в той же базе Neon (`systemDatabaseSchemaName`)                                  | Одна база, одна резервная копия. Шаг-транзакция DBOS пишет в `finance`/`memory` и отмечает своё выполнение в одной транзакции. |
| Подключение через `DATABASE_URL_UNPOOLED`, пул 2–3 соединения                                 | DBOS не работает с PgBouncer в режиме транзакций. У Neon мало прямых подключений.                                              |
| `DBOS.migrate(url, { schemaName: "dbos" })` в `migrate.ts`, сам DBOS с `runMigrations: false` | DDL выполняется только при сборке, а не при холодном старте десятков экземпляров.                                              |
| Явный `applicationVersion`                                                                    | Незавершённые workflow прошлой версии не остаются без исполнителя после деплоя.                                                |
| Отдельный route-воркер, который будит Vercel Cron; Next.js ставит задачи через `DBOSClient`   | Это рекомендация DBOS не запускать его внутри процесса Next.js.                                                                |

Применение по исследованию ([personal-agent-architecture-review.md](personal-agent-architecture-review.md), вариант A):

- долговечный агентный цикл через `@dbos-inc/vercel-ai` (`durableCalls`, `durableTools`);
- `sleep` и cron-расписания в базе для проактивных правил;
- `send/recv` и `setEvent/getEvent` для ожиданий решения пользователя (HITL);
- очереди с лимитами.

**Где план не сходится с реальностью Vercel Hobby.** DBOS для Vercel документирует такую схему ([docs.dbos.dev/integrations/vercel](https://docs.dbos.dev/integrations/vercel)):

1. `DBOSClient.enqueue` вызывается из Next.js.
2. Route-воркер с `waitUntil(waitForQueuedWorkflowsToComplete(300000))` выполняет задачи.
3. Vercel Cron с расписанием `"* * * * *"` будит воркер.
4. Workflow, не успевшие завершиться, восстанавливаются при следующем старте воркера.

На Hobby cron разрешён не чаще раза в сутки с точностью ±59 минут. Выражение чаще раза в сутки падает на деплое ([cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing)).

- `sleep(1h)`, очередь и ожидание решения продвинулись бы раз в сутки.
- Напоминание «через 20 минут» не реализуется.
- Без внешнего воркера DBOS на Hobby работает как ежедневный пакетный обработчик.

Исследование изначально предполагало свой постоянный сервер. Деплой на Vercel serverless поменял это условие, и вместе с ним поменялось сравнение.

Conductor у DBOS — только управляющий слой: восстановление, наблюдаемость, хранение. Исполнения он не касается, а self-hosted вариант для коммерческого использования платный ([architecture](https://docs.dbos.dev/architecture)). Проблему «некому будить воркер» он не решает.

## 3. Что такое Vercel Workflow сейчас

**Статус.** GA с 16.04.2026 после публичной беты с октября 2025. Vercel заявляет более 100 млн запусков и более 1500 клиентов ([блог](https://vercel.com/blog/a-new-programming-model-for-durable-execution)).

Версии на 30.09 ([npm](https://registry.npmjs.org/workflow)):

- `workflow` и `@workflow/next` — 5.0.0, опубликованы сегодня;
- ветка 4.x (4.8.10) получает исправления стабильности;
- **`@workflow/ai` (`DurableAgent`) устарел и не поддерживает `ai@7`**: peer `ai ^5 || ^6`;
- замена — `@ai-sdk/workflow` 2.0.57 (`WorkflowAgent`): зависит от `ai 7.0.x`, peer `workflow ^5.0.0-beta.42` ([npm](https://registry.npmjs.org/@ai-sdk/workflow)).

Для нашего `ai@^7` нужна связка **`workflow@5` + `@ai-sdk/workflow`**.

**Модель программирования** ([docs](https://workflow-sdk.dev/docs)):

- Функция с `"use workflow"` — детерминированная оркестрация в песочнице:
  - нет модулей Node, глобального `fetch`, `setTimeout` и `Buffer`;
  - `Date`, `Math.random` и `crypto.randomUUID` детерминированы;
  - `process.env` заморожен ([globals](https://workflow-sdk.dev/docs/api-reference/workflow-globals)).
- Функция с `"use step"` — обычный Node. Здесь работают Drizzle, `pg` и SecretBox. Аргументы и результаты сериализуются и записываются в журнал ([serialization](https://workflow-sdk.dev/docs/foundations/serialization)).
- Повторы:
  - по умолчанию `maxRetries = 3`;
  - `FatalError` отключает повтор;
  - `RetryableError({ retryAfter })` задаёт паузу ([errors](https://workflow-sdk.dev/docs/foundations/errors-and-retries)).
- `sleep()` без ограничения длительности ([pricing](https://vercel.com/docs/workflows/pricing)).
- Ожидания:
  - `createHook` / `defineHook` + `resumeHook(token, payload)`;
  - `createWebhook` с публичным URL ([hooks](https://workflow-sdk.dev/docs/foundations/hooks)).
- Поток:
  - шаги пишут в `getWritable()`;
  - клиент переподключается через `getRun(runId).getReadable(...)` ([streaming](https://workflow-sdk.dev/docs/foundations/streaming)). Для `WorkflowAgent` поток читается с начала, а `startIndex` клиента передаётся в `createModelCallToUIChunkTransform({ uiStartIndex })` ([ai-sdk.dev](https://ai-sdk.dev/v7/docs/agents/workflow-agent)).
- Ключ идемпотентности для внешних API — `getStepMetadata().stepId` ([docs](https://workflow-sdk.dev/docs/api-reference/workflow/get-step-metadata)).
- Отмена — `run.cancel()` и AbortSignal в шаги ([cancellation](https://workflow-sdk.dev/docs/foundations/cancellation)).
- **Версионирование.** Запуск привязан к деплою, в котором начался. Для долгих циклов нужно завершать запуск и стартовать новый с `start(..., { deploymentId: "latest" })`. Запуски, привязанные к удалённому деплою, «never complete or fail on their own» ([versioning](https://workflow-sdk.dev/docs/foundations/versioning)). Это аналог `applicationVersion` у DBOS.

**Где лежит состояние.** Vercel World:

- код исполняют Vercel Functions;
- запуски диспетчеризует Vercel Queues;
- журнал событий хранится в управляемом хранилище Vercel, **в Neon ничего не попадает** ([vercel.com/docs/workflows](https://vercel.com/docs/workflows));
- flow-обработчик доступен только из Queues, публичного входа у него нет ([vercel world](https://workflow-sdk.dev/worlds/vercel)).

**Postgres World на Vercel не работает.** Ему нужен постоянный процесс graphile-worker. Документация прямо говорит: «does not work on serverless… For Vercel deployments, use the Vercel World» ([postgres world](https://workflow-sdk.dev/worlds/postgres)). Держать состояние Workflow в нашей Neon, оставаясь на Vercel, нельзя.

**Лимиты и цена** ([pricing](https://vercel.com/docs/workflows/pricing), [functions limits](https://vercel.com/docs/functions/limitations)):

|                                          | Hobby                                 | Pro                                    |
| ---------------------------------------- | ------------------------------------- | -------------------------------------- |
| Включено                                 | 50 тыс. событий и 1 ГБ записи в месяц | то же, сверх — $0.02 за 1 тыс. событий |
| Хранение данных запуска после завершения | **1 день**                            | 7 дней                                 |
| Длительность одного шага                 | до ~300 с (лимит функции)             | до 800 с                               |
| На запуск                                | 25 тыс. событий, 10 тыс. шагов        | то же                                  |
| Длительность запуска и `sleep`           | без ограничения                       | без ограничения                        |

Обычный шаг пишет 3 события плюс одно на каждый повтор. Что происходит на Hobby, когда 50 тыс. событий кончаются, документация не говорит (**не проверено**).

## 4. Соответствие решений

| Решение для DBOS                                       | Что делать с Vercel Workflow                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Схема `dbos` в Neon                                    | Не нужна. Состояние у Vercel. Строка из таблицы схем убирается.                                                                                              |
| `DATABASE_URL_UNPOOLED` и маленький пул                | Не нужны. Шаги ходят в Neon через тот же пуловый `DATABASE_URL`, что и обычные ручки.                                                                        |
| `DBOS.migrate` в `migrate.ts`                          | Не нужен. Миграций у Workflow нет.                                                                                                                           |
| `applicationVersion`                                   | Привязка запуска к деплою встроена. Для долгих циклов — «continue as new» с `deploymentId: "latest"`.                                                        |
| Route-воркер и cron каждую минуту                      | Не нужны. Queues будят функцию сами.                                                                                                                         |
| Отметка шага в одной транзакции с предметными данными  | **Теряется.** См. раздел 6.                                                                                                                                  |
| Cron-расписания в базе                                 | Встроенного cron нет, есть только RFC ([#1649](https://github.com/vercel/workflow/discussions/1649)). Нужен Vercel Cron → `start()` или цикл со `sleep`.     |
| `@dbos-inc/vercel-ai` (`durableCalls`, `durableTools`) | `WorkflowAgent` из `@ai-sdk/workflow`. Tools с `"use step"` становятся долговечными шагами ([ai-sdk.dev](https://ai-sdk.dev/v7/docs/agents/workflow-agent)). |
| `send/recv`, `setEvent/getEvent`                       | `createHook` / `resumeHook`. Для подтверждения tool — `needsApproval`: запуск завершается, решение приходит со следующим запросом.                           |

## 5. Кейсы

### 5.1. В этом репозитории

Порядок — по пользе.

**1. Точные напоминания и отложенные действия.** Это главный выигрыш. С DBOS на Hobby такое невозможно, с Workflow работает без воркера.

```ts
// Эскиз, не запускался.
import { sleep } from "workflow";

export async function reminderWorkflow(reminderId: string, fireAt: string) {
  "use workflow";
  await sleep(new Date(fireAt));
  await deliverReminder(reminderId);
}

async function deliverReminder(reminderId: string) {
  "use step";
  // Читает напоминание из Neon. Если оно отменено или уже доставлено, выходит.
  // Отправляет push с ключом дедупликации reminderId.
}
```

- Отмена: `run.cancel()` по `runId`, сохранённому в таблице напоминаний. Проверка статуса внутри шага нужна всё равно: отмена могла не успеть.

**2. Обновление токена ChatGPT по сроку, а не раз в сутки.** Сейчас [cron/openai-refresh](../../apps/core/src/app/api/cron/openai-refresh/route.ts) срабатывает раз в день и обновляет с запасом 26 часов из-за точности Hobby ±1 ч.

```ts
// Эскиз, не запускался.
export async function openaiTokenKeeper() {
  "use workflow";
  for (let i = 0; i < 30; i++) {
    const next = await refreshIfDueStep(); // шаг: createOpenAIAuth().refreshIfDue(...)
    if (!next) return; // владелец вышел, ключа нет
    await sleep(new Date(next.refreshAt)); // за N минут до истечения
  }
  await continueAsNewStep(); // шаг: start(openaiTokenKeeper, [], { deploymentId: "latest" })
}
```

- Ежедневный cron остаётся страховкой. Он проверяет, что живой запуск есть, и при необходимости стартует новый.
- Атомарного `start()` с ключом пока нет ([#2376](https://github.com/vercel/workflow/issues/2376)). Защита от двух параллельных циклов — advisory lock или уникальная строка в Neon внутри шага.
- Шаг возвращает только время следующего обновления, а не токен. Подробнее в разделе 6.

**3. Ход агента, переживающий обрыв соединения.** Сейчас [/api/agent](../../apps/core/src/app/api/agent/route.ts) стримит напрямую. Если клиент закрылся или функция упала, ход потерян.

```ts
// Эскиз, не запускался.
// workflows/agent-turn.ts
export async function agentTurn(conversationId: string) {
  "use workflow";
  const agent = new WorkflowAgent({
    model,
    instructions: SYSTEM_PROMPT,
    tools,
  });
  const messages = await loadMessages(conversationId); // шаг
  await agent.stream({
    messages,
    writable: getWritable(),
    stopWhen: stepCountIs(10),
  });
}

// app/api/agent/route.ts: requireOwner, затем
const run = await start(agentTurn, [conversationId]);
return createUIMessageStreamResponse({
  stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
  headers: { "x-workflow-run-id": run.runId },
});
// + GET /api/agent/[runId]/stream?startIndex=… для WorkflowChatTransport:
//   getReadable({ startIndex: 0 }) + createModelCallToUIChunkTransform({ uiStartIndex })
```

- Каждый вызов модели и каждый tool — отдельный шаг. Значит, лимит 300 с на Hobby применяется к одному шагу, а не к ходу целиком.
- **Открытый вопрос для прототипа:** как в `WorkflowAgent` подключить наш провайдер из `@repo/openai-subscription`. По исходникам `@ai-sdk/workflow` 2.0.57 (`doStreamStep` в `src/do-stream-step.ts`) модель передаётся в шаг аргументом и должна сериализоваться через `WORKFLOW_SERIALIZE` / `WORKFLOW_DESERIALIZE` ([serialization](https://workflow-sdk.dev/docs/foundations/serialization#custom-class-serialization)). Наш провайдер — объект с замыканиями (`auth`, `fetch`), поэтому нужен свой класс-обёртка, который сериализует только `modelId`, а `createOpenAIAuth()` вызывает внутри `doStream`. Не проверено, пропустит ли сборка workflow импорт `lib/openai.ts` (`pg`, `node:crypto`) из файла этого класса ([node-js-module-in-workflow](https://workflow-sdk.dev/docs/errors/node-js-module-in-workflow)).
- Переписка с моделью записывается в журнал Vercel. Это вопрос допустимости, а не техники. См. раздел 6.

**4. Подтверждение изменяющих действий (HITL).** У tool задаётся `needsApproval: true | async fn`. По исходникам (`src/workflow-agent.ts`) запуск при этом **не ждёт, а завершается**: в поток пишется `tool-approval-request`, и ход заканчивается. Клиент отправляет решение в истории сообщений следующим POST, новый `start()` обрабатывает его до вызова модели и выполняет tool. Протокол operationId из исследования ([personal-agent-architecture.md](personal-agent-architecture.md), «Выполнение действий») ложится так:

1. Шаг записывает намерение: operationId, точные аргументы, ссылку на задачу.
2. `needsApproval` проверяет права. При необходимости ход завершается с запросом решения.
3. После решения новый запуск перепроверяет актуальность и выполняет операцию с ключом идемпотентности. Ключ — `toolCallId`: он одинаков при повторах шага и в запуске после подтверждения, в отличие от `stepId`.
4. Результат и внешний ID пишутся в Neon.

- Ожидание решения не держит запуск, поэтому привязка к деплою здесь не мешает. Она остаётся проблемой для `sleep` в напоминаниях и циклах: на Hobby защищены только 3 последних production-деплоя ([deployment retention](https://vercel.com/docs/deployment-retention)).
- История с решением приходит от клиента. Чтобы подтверждение нельзя было подделать или подменить аргументы, включается `experimental_toolApprovalSecret` (HMAC над approvalId, toolCallId, именем tool и входом).
- «Продолжить с другого устройства» работает, только если история диалога хранится на сервере. Сейчас клиент присылает её целиком.
- Если проектируются свои ожидания через `createHook`, маршрут `resumeHook` защищается `requireOwner`: токен хука — «not an authentication mechanism» ([hooks](https://workflow-sdk.dev/docs/foundations/hooks)).

**5. Утренний обзор и еженедельный пересмотр плана.** Vercel Cron раз в сутки вызывает `start(morningBrief)`. Внутри шаги проверяют свежесть данных (сон, тренировки, календарь) и только потом вызывают модель. Еженедельная задача — тот же ежедневный cron с проверкой дня недели в шаге. Точность ±59 мин для обзора приемлема. Если нужно точное время, cron стартует запуск, а тот делает `sleep` до нужной минуты.

**6. Событие → анализ.** iPhone присылает новые тренировки из HealthKit, ручка пишет их в Neon обычным кодом и, если сработало правило, вызывает `start(analyzeWorkout, [workoutId])`. Это прямо совпадает с принципом исследования: импорт делает обычный код, а модель вызывается по правилу.

**7. Опрос device-login.** Можно перенести опрос из клиента ([openai/login](../../apps/core/src/app/api/openai/login/route.ts)) в workflow: `sleep(pollIntervalMs)` в цикле до complete или expired. Польза маленькая: клиент всё равно показывает код, а каждая итерация тратит события. Инженерная оценка: оставить как есть.

### 5.2. Во внешнем production

Это кейсы, которые опубликовал сам Vercel, а не независимые отзывы:

- **Mux:** долговечные видео-пайплайны в `@mux/ai` ([блог](https://vercel.com/blog/how-mux-shipped-durable-video-workflows-with-their-mux-ai-sdk), [шаблон](https://vercel.com/templates/next.js/mux-ai-vercel-workflows-starter));
- **Durable:** 3 млн клиентов, 6 инженеров ([блог](https://vercel.com/blog/360-billion-tokens-3-million-customers-6-engineers));
- **FLORA:** творческий агент на 50+ моделях изображений ([блог](https://vercel.com/blog/how-flora-shipped-a-creative-agent-on-vercels-ai-stack)).

Официальные примеры ([vercel/workflow-examples](https://github.com/vercel/workflow-examples)): `flight-booking-app` (агент с tools и подтверждением), `rag-agent`, `ai-sdk-workflow-patterns`, `birthday-card-generator` (`sleep` до даты). Ближе всего к Majordomo `flight-booking-app`.

## 6. Что меняется по сравнению с DBOS

1. **Секреты не должны попадать в журнал.**
   - Аргументы и результаты шагов хранятся у Vercel и видны владельцам команды ([docs](https://vercel.com/docs/workflows)).
   - Сейчас в Neon лежит только шифротекст SecretBox, а ключ есть только у Production.
   - Правило: между шагами передавать ID, а не токены и не данные здоровья и финансов. Расшифровывать внутри шага, наружу отдавать только то, что нужно оркестрации.
   - Сообщения агенту это правило не покрывает. Для категорий «здоровье» и «финансы» это то же решение о допустимости, что и выбор LLM-провайдера.
2. **Нет общей транзакции с предметными данными.**
   - Шаг может записать в Neon и упасть до того, как Vercel отметит его выполненным. Тогда шаг выполнится ещё раз.
   - Все записи в шагах — upsert по `stepId` или operationId.
   - Драйвер Neon используется только внутри `"use step"`.
3. **История запусков — в своих таблицах.** На Hobby данные завершённого запуска удаляются через день, и сохранённый `runId` перестаёт открываться. Это совпадает с принципом исследования: в своей БД хранятся задачи, команды, операции и ссылки на запуски. Как хранение влияет на запуски, которые ещё спят или ждут, **не проверено**.
4. **Бюджет событий.** Инженерная оценка: ход агента с 3 вызовами модели и 2 tools — около 5 шагов, примерно 15–20 событий. 50 тыс. событий — это порядка 2,5 тыс. ходов в месяц, или около 80 в день, без учёта расписаний. Сколько событий пишет `sleep`, не проверено. Что происходит при исчерпании лимита на Hobby, тоже. Для ассистента, который работает без присмотра, это нужно выяснить до опоры на него.
5. **Turbo может тихо выключить Workflow.** Без `VERCEL_DEPLOYMENT_ID` на этапе сборки Workflow молча переходит на Local World, и запуски не появляются ([vercel world](https://workflow-sdk.dev/worlds/vercel)). Turbo в строгом режиме фильтрует переменные окружения, которые не перечислены в `turbo.json` ([database.md](../architecture/database.md), строка 63). По документации установленного turbo 2.11 (`crafting-your-repository/using-environment-variables.mdx`) это решается так: в задачу `build` добавить `"passThroughEnv": ["VERCEL_*"]`, а в проекте Vercel включить System Environment Variables.
6. **Proxy.** Если появится `proxy.ts`, префикс `.well-known/workflow/` исключается из matcher ([next](https://workflow-sdk.dev/docs/getting-started/next)).
7. **Известные проблемы** ([issues](https://github.com/vercel/workflow/issues)):
   - задержки при возобновлении чата: [#1820](https://github.com/vercel/workflow/issues/1820), [#2767](https://github.com/vercel/workflow/issues/2767);
   - потеря подтверждённых кусков потока: [#4306](https://github.com/vercel/workflow/issues/4306), 23.09;
   - хук, гоняющийся со `sleep` в цикле: [#4264](https://github.com/vercel/workflow/issues/4264);
   - неатомарный `start()` с ключом: [#2376](https://github.com/vercel/workflow/issues/2376).

## 7. Правки в database.md при переходе

- Из таблицы схем убрать строку `dbos`. В обосновании одной базы убрать довод про datasource-транзакции DBOS.
- Раздел «DBOS» заменить разделом «Vercel Workflow»:
  - состояние у Vercel, не в Neon;
  - правила из раздела 6 (секреты, идемпотентность, своя история);
  - `withWorkflow` в `next.config.ts`;
  - `passThroughEnv` в `turbo.json`;
  - закреплённые точные версии `workflow`, `@workflow/next`, `@ai-sdk/workflow`.
- Из таблицы переменных у `DATABASE_URL_UNPOOLED` убрать «в будущем DBOS».
- Убрать комментарий про DBOS в `packages/db/src/migrate.ts` и `packages/db/src/client.ts`.

## 8. Рекомендация и открытые вопросы

Инженерная оценка:

- На текущей платформе (Vercel Hobby, без отдельного сервера) взять Vercel Workflow.
- DBOS держать запасным вариантом на случай, если появится постоянный воркер. Он же нужен, если «состояние только в нашей базе» станет обязательным требованием для данных здоровья и финансов.

Перед решением проверить в коротком прототипе:

1. Наш провайдер из `@repo/openai-subscription` внутри `WorkflowAgent`: обновление токена в шаге, ошибка `ReauthRequiredError` как `FatalError`.
2. Падение функции во время вызова модели и во время изменяющего tool: что повторяется, нет ли дублей в Neon.
3. Подтверждения: подделанное или изменённое решение отклоняется; падение между решением и записью tool не создаёт второй объект при том же `toolCallId`. Отдельно — `sleep` напоминания дольше жизни деплоя.
4. Переподключение клиента к потоку через `startIndex`, в том числе с учётом [#4306](https://github.com/vercel/workflow/issues/4306).
5. Реальный расход событий на ход агента, `sleep` и хук; поведение при исчерпании 50 тыс.
6. Что видно в журнале Vercel после хода с личными данными, и приемлемо ли это.

Если пункты 1, 2 или 6 не проходят без обходной логики, следующий шаг — DBOS на отдельном воркере с той же Neon. Это альтернатива из [database.md](../architecture/database.md#dbos), строка 87.
