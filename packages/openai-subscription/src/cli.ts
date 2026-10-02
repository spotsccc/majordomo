#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  OPENAI_SUBSCRIPTION_MODEL_ID_LIST,
  OpenAISubscriptionError,
} from "@fieldwork-ai/codex-transport";
import { OpenAISubscriptionAuth, type AuthStatus } from "./auth.js";
import {
  DeviceLoginUnavailableError,
  NotLoggedInError,
  ReauthRequiredError,
} from "./errors.js";
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

async function main(): Promise<void> {
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
    return;
  }

  const store = new FileCredentialStore(values.file ?? defaultCredentialFile());
  const auth = new OpenAISubscriptionAuth({ store });

  switch (command) {
    case "login":
      await login(auth, values.browser);
      break;
    case "status":
      await status(auth);
      break;
    case "refresh":
      await auth.refreshNow();
      printStatus(await auth.status());
      break;
    case "test":
      await test(
        auth,
        values.model ?? process.env.MAJORDOMO_OPENAI_MODEL ?? "gpt-5.6-luna",
      );
      break;
    case "logout":
      await auth.logout();
      console.log("Сессия удалена.");
      break;
    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

async function login(
  auth: OpenAISubscriptionAuth,
  browser: boolean,
): Promise<void> {
  if (!browser) {
    try {
      const session = await startDeviceLogin(auth);
      process.once("SIGINT", () => session.cancel());
      console.log(
        `\n1. Откройте ${session.verificationUrl} (можно с телефона)`,
      );
      console.log(`2. Войдите в ChatGPT и введите код: ${session.userCode}\n`);
      console.log(
        `Код действует до ${formatTime(session.expiresAt)}. Жду подтверждения…`,
      );
      printStatus(await session.result);
      return;
    } catch (error) {
      if (!(error instanceof DeviceLoginUnavailableError)) throw error;
      console.log(`${error.message}\nПереключаюсь на вход через браузер.\n`);
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
  try {
    printStatus(await session.complete(await input.question("Адрес: ")));
  } finally {
    input.close();
  }
}

async function status(auth: OpenAISubscriptionAuth): Promise<void> {
  const current = await auth.status();
  printStatus(current);
  if (current.state !== "active") return;
  try {
    const usage = await auth.usage();
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
  } catch (error) {
    console.log(
      `Лимиты получить не удалось: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function test(
  auth: OpenAISubscriptionAuth,
  modelId: string,
): Promise<void> {
  const model = createOpenAISubscription({ auth })(modelId);
  const result = await Promise.resolve(
    model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "text", text: "Ответь одним словом: pong" }],
        },
      ],
    }),
  ).catch((error: unknown) => {
    if (error instanceof OpenAISubscriptionError) {
      console.error(
        `Известные модели: ${OPENAI_SUBSCRIPTION_MODEL_ID_LIST.join(", ")}`,
      );
    }
    throw error;
  });
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
  console.log(`${modelId}: ${text || "(пустой ответ)"}`);
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  if (
    error instanceof NotLoggedInError ||
    error instanceof ReauthRequiredError
  ) {
    console.error("Войдите: majordomo-openai login");
  }
  process.exitCode = 1;
});
