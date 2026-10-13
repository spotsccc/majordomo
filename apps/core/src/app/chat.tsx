"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
} from "ai";
import Link from "next/link";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  checkLogin,
  getAuthStatus,
  logout,
  startLogin,
  type AuthStatus,
  type LoginPrompt,
} from "@/lib/owner-api";
import {
  CodexSubscriptionError,
  OwnerSessionError,
  RequestRejectedError,
  UnknownClientError,
  toClientError,
} from "@/lib/client-errors";
import styles from "./chat.module.css";

type LoginView =
  | { state: "code"; prompt: LoginPrompt }
  | { state: "unavailable"; message: string }
  | { state: "failed"; message: string };

const transport = new DefaultChatTransport({ api: "/api/agent" });

export function Chat() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [login, setLogin] = useState<LoginView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const retryAfterLogin = useRef(false);

  const chat = useChat({
    transport,
    onError: (cause) => {
      const error = toClientError(cause);
      if (error instanceof CodexSubscriptionError) {
        retryAfterLogin.current = true;
        void requestLogin();
      }
      if (
        error instanceof RequestRejectedError ||
        error instanceof UnknownClientError
      ) {
        console.error(cause);
      }
    },
  });

  async function refreshStatus() {
    const next = await getAuthStatus();
    if (next instanceof Error) {
      setNotice(next.message);
      return;
    }
    setStatus(next);
  }

  async function requestLogin() {
    setNotice(null);
    const started = await startLogin();
    if (started instanceof Error) {
      setNotice(started.message);
      return;
    }
    setLogin(started);
  }

  async function signOut() {
    const done = await logout();
    if (done instanceof Error) {
      setNotice(done.message);
      return;
    }
    setLogin(null);
    await refreshStatus();
  }

  const onLoginComplete = useEffectEvent(() => {
    setLogin(null);
    void refreshStatus();
    if (retryAfterLogin.current) {
      retryAfterLogin.current = false;
      void chat.regenerate();
    }
  });

  const onStatusLoad = useEffectEvent(() => {
    void refreshStatus();
  });

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- refreshStatus sets state only after awaiting the status request
    onStatusLoad();
  }, []);

  const prompt = login?.state === "code" ? login.prompt : null;
  useEffect(() => {
    if (!prompt) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      timer = setTimeout(tick, prompt.pollIntervalMs);
    };
    const tick = async () => {
      if (Date.now() > Date.parse(prompt.expiresAt)) {
        setLogin({ state: "failed", message: "Код истёк." });
        return;
      }
      const progress = await checkLogin();
      if (cancelled) return;
      if (progress instanceof Error) {
        setNotice(progress.message);
        schedule();
        return;
      }
      switch (progress.state) {
        case "pending":
          schedule();
          return;
        case "complete":
          onLoginComplete();
          return;
        case "none":
          setLogin({ state: "failed", message: "Вход не завершён." });
          return;
        case "failed":
          setLogin({ state: "failed", message: progress.message });
          return;
      }
    };

    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [prompt]);

  function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || chat.status === "submitted" || chat.status === "streaming") {
      return;
    }
    setDraft("");
    void chat.sendMessage({ text });
  }

  const busy = chat.status === "submitted" || chat.status === "streaming";
  const error = toClientError(chat.error);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Majordomo</h1>
        <span className={styles.status}>{describeStatus(status)}</span>
        {status?.state === "active" ? (
          <button className={styles.link} onClick={() => void signOut()}>
            Выйти из Codex
          </button>
        ) : (
          <button className={styles.link} onClick={() => void requestLogin()}>
            Войти в Codex
          </button>
        )}
      </header>

      {notice && <p className={styles.notice}>{notice}</p>}
      {login && (
        <LoginPanel login={login} onRetry={() => void requestLogin()} />
      )}

      <section className={styles.messages}>
        {chat.messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === "user" ? styles.userMessage : styles.botMessage
            }
          >
            {message.parts.map((part, index) =>
              part.type === "text" ? (
                <span key={index}>{part.text}</span>
              ) : isToolUIPart(part) ? (
                <span key={index} className={styles.tool}>
                  {toolStatus(part)}
                </span>
              ) : null,
            )}
          </div>
        ))}
        {chat.status === "submitted" && (
          <div className={styles.botMessage}>…</div>
        )}
        {error && !(error instanceof CodexSubscriptionError) && (
          <p className={styles.notice}>
            {error.message}{" "}
            {error instanceof OwnerSessionError && (
              <Link className={styles.link} href="/login">
                Войти
              </Link>
            )}
            {error instanceof UnknownClientError && (
              <button
                className={styles.link}
                onClick={() => void chat.regenerate()}
              >
                Повторить
              </button>
            )}
          </p>
        )}
      </section>

      <form className={styles.row} onSubmit={send}>
        <input
          className={styles.input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Сообщение"
          autoFocus
        />
        {busy ? (
          <button
            className={styles.button}
            type="button"
            onClick={() => void chat.stop()}
          >
            Стоп
          </button>
        ) : (
          <button className={styles.button} type="submit">
            Отправить
          </button>
        )}
      </form>
    </main>
  );
}

function LoginPanel({
  login,
  onRetry,
}: {
  login: LoginView;
  onRetry: () => void;
}) {
  if (login.state === "unavailable") {
    return (
      <div className={styles.card}>
        <p>{login.message}</p>
        <p>
          Войдите через браузер на сервере:{" "}
          <code>
            node packages/openai-subscription/dist/cli.js login --browser
          </code>
        </p>
      </div>
    );
  }
  if (login.state === "failed") {
    return (
      <div className={styles.card}>
        <p>{login.message}</p>
        <button className={styles.button} onClick={onRetry}>
          Получить новый код
        </button>
      </div>
    );
  }

  const { prompt } = login;
  return (
    <div className={styles.card}>
      <p>
        Откройте{" "}
        <a href={prompt.verificationUrl} target="_blank" rel="noreferrer">
          {prompt.verificationUrl}
        </a>
        , войдите в ChatGPT и введите код:
      </p>
      <p className={styles.code}>{prompt.userCode}</p>
      <p className={styles.hint}>
        Код действует до{" "}
        {new Date(prompt.expiresAt).toLocaleTimeString("ru", {
          hour: "2-digit",
          minute: "2-digit",
        })}
        . Ждём подтверждения…
      </p>
    </div>
  );
}

const TOOL_STATUS: Record<string, [running: string, done: string]> = {
  list_wallets: ["Смотрю кошельки…", "Кошельки получены"],
  create_wallet: ["Создаю кошелёк…", "Кошелёк создан"],
  update_wallet: ["Меняю кошелёк…", "Кошелёк изменён"],
  list_transactions: ["Ищу транзакции…", "Транзакции найдены"],
  create_transaction: ["Записываю…", "Записано"],
  update_transaction: ["Исправляю запись…", "Исправлено"],
  delete_transaction: ["Удаляю запись…", "Удалено"],
  restore_transaction: ["Восстанавливаю запись…", "Восстановлено"],
  list_categories: ["Смотрю категории…", "Категории получены"],
  create_category: ["Создаю категорию…", "Категория создана"],
  summarize: ["Считаю итоги…", "Итоги посчитаны"],
  net_worth: ["Считаю всё в одной валюте…", "Посчитано"],
  get_rates: ["Смотрю курсы…", "Курсы получены"],
  add_currency: ["Добавляю валюту…", "Готово"],
};

/** A tool reports an expected failure as an output with `error`, not as an `output-error` part. */
function toolStatus(part: ToolUIPart | DynamicToolUIPart): string {
  const [running, done] = TOOL_STATUS[getToolName(part)] ?? [
    "Работаю…",
    "Готово",
  ];
  if (part.state === "output-error") return "Не получилось";
  if (part.state !== "output-available") return running;
  const output: unknown = part.output;
  return typeof output === "object" && output !== null && "error" in output
    ? "Не получилось"
    : done;
}

function describeStatus(status: AuthStatus | null): string {
  if (!status) return "Codex: проверяем…";
  switch (status.state) {
    case "active":
      return `Codex: ${status.email ?? "вход выполнен"}${status.planType ? ` (${status.planType})` : ""}`;
    case "reauth_required":
      return "Codex: нужно войти заново";
    case "logged_out":
      return "Codex: вход не выполнен";
  }
}
