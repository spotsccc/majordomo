#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  OPENAI_SUBSCRIPTION_MODEL_ID_LIST,
  OpenAISubscriptionError,
} from "@fieldwork-ai/codex-transport";
import { tryAsync } from "@spotsccc/error-as-value";
import { OpenAISubscriptionAuth, type AuthStatus } from "./auth.js";
import { DeviceLoginUnavailableError, isLoginRequired } from "./errors.js";
import { startBrowserLogin, startDeviceLogin } from "./login.js";
import { createOpenAISubscription } from "./provider.js";
import { FileCredentialStore, defaultCredentialFile } from "./store.js";

const USAGE = `Использование: majordomo-openai <команда> [--file путь]

Команды:
  login [--browser]   войти в ChatGPT (по умолчанию по коду устройства)
  status              состояние сессии и лимиты подписки
  refresh             обновить токен сейчас
  test [--model id]   отправить модели короткий запрос
  logout              выйти и отозвать refresh-токен

Файл с токенами: --file, переменная MAJORDOMO_OPENAI_AUTH_FILE
или ~/.majordomo/openai-subscription.json`;

async function main(): Promise<Error | undefined> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: "string" },
      browser: { type: "boolean", default: false },
      model: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(USAGE);
    return undefined;
  }

  const store = new FileCredentialStore(values.file ?? defaultCredentialFile());
  const auth = new OpenAISubscriptionAuth({ store });

  switch (command) {
    case "login":
      return login(auth, values.browser);
    case "status":
      return status(auth);
    case "refresh": {
      const refreshed = await auth.refreshNow();
      if (refreshed instanceof Error) return refreshed;

      const current = await auth.status();
      if (current instanceof Error) return current;

      printStatus(current);
      return undefined;
    }
    case "test":
      return test(
        auth,
        values.model ?? process.env.MAJORDOMO_OPENAI_MODEL ?? "gpt-5.6-luna",
      );
    case "logout": {
      const loggedOut = await auth.logout();
      if (loggedOut instanceof Error) return loggedOut;

      console.log("Сессия удалена.");
      return undefined;
    }
    default:
      console.error(USAGE);
      process.exitCode = 2;
      return undefined;
  }
}

async function login(
  auth: OpenAISubscriptionAuth,
  browser: boolean,
): Promise<Error | undefined> {
  if (!browser) {
    const session = await startDeviceLogin(auth);
    if (session instanceof DeviceLoginUnavailableError) {
      console.log(`${session.message}\nПереключаюсь на вход через браузер.\n`);
    } else if (session instanceof Error) {
      return session;
    } else {
      process.once("SIGINT", () => session.cancel());
      console.log(
        `\n1. Откройте ${session.verificationUrl} (можно с телефона)`,
      );
      console.log(`2. Войдите в ChatGPT и введите код: ${session.userCode}\n`);
      console.log(
        `Код действует до ${formatTime(session.expiresAt)}. Жду подтверждения…`,
      );
      const result = await session.result;
      if (result instanceof Error) return result;

      printStatus(result);
      return undefined;
    }
  }

  const session = startBrowserLogin(auth);
  console.log(`1. Откройте в браузере:\n\n${session.authorizationUrl}\n`);
  console.log(
    "2. После входа браузер перейдёт на localhost:1455 и покажет ошибку — это нормально.",
  );
  console.log(
    "3. Скопируйте адрес этой страницы из адресной строки и вставьте сюда.\n",
  );
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const callbackUrl = await tryAsync(
    () => input.question("Адрес: "),
    (error) => error,
  ).finally(() => input.close());
  if (callbackUrl instanceof Error) return callbackUrl;

  const result = await session.complete(callbackUrl);
  if (result instanceof Error) return result;

  printStatus(result);
  return undefined;
}

async function status(
  auth: OpenAISubscriptionAuth,
): Promise<Error | undefined> {
  const current = await auth.status();
  if (current instanceof Error) return current;

  printStatus(current);
  if (current.state !== "active") return undefined;

  const usage = await auth.usage();
  if (usage instanceof Error) {
    console.log(`Лимиты получить не удалось: ${usage.message}`);
    return undefined;
  }
  for (const limit of usage.limits) {
    for (const window of [limit.primary, limit.secondary]) {
      if (!window) continue;
      const span = window.windowDurationMinutes
        ? `${formatWindow(window.windowDurationMinutes)}`
        : "окно";
      const reset = window.resetsAt
        ? `, сброс ${formatTime(Date.parse(window.resetsAt))}`
        : "";
      console.log(
        `Лимит ${limit.label ?? limit.id} (${span}): использовано ${window.usedPercent}%${reset}`,
      );
    }
  }
  return undefined;
}

async function test(
  auth: OpenAISubscriptionAuth,
  modelId: string,
): Promise<Error | undefined> {
  const model = createOpenAISubscription({ auth })(modelId);
  const result = await tryAsync(
    async () =>
      model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [{ type: "text", text: "Ответь одним словом: pong" }],
          },
        ],
      }),
    (error) => error,
  );
  if (result instanceof OpenAISubscriptionError) {
    console.error(
      `Известные модели: ${OPENAI_SUBSCRIPTION_MODEL_ID_LIST.join(", ")}`,
    );
  }
  if (result instanceof Error) return result;

  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  console.log(`${modelId}: ${text || "(пустой ответ)"}`);
  return undefined;
}

function printStatus(status: AuthStatus): void {
  if (status.state === "logged_out") {
    console.log("Вход не выполнен. Запустите: majordomo-openai login");
    return;
  }
  const state =
    status.state === "active"
      ? "активна"
      : `нужен повторный вход (${status.reauth?.reason})`;
  console.log(`Сессия: ${state}`);
  console.log(
    `Аккаунт: ${status.email ?? "—"} (${status.accountId}), тариф: ${status.planType ?? "—"}`,
  );
  console.log(`Токен действует до ${formatTime(status.expiresAt)}`);
  if (status.refreshedAt)
    console.log(`Последнее обновление: ${formatTime(status.refreshedAt)}`);
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("ru-RU");
}

function formatWindow(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} дн.`;
  if (minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
}

const error = await tryAsync(main, (error) => error);
if (error) {
  console.error(error.message);
  if (isLoginRequired(error)) console.error("Войдите: majordomo-openai login");
  process.exitCode = 1;
}
