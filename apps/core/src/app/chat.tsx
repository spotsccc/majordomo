"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  LOGIN_REQUIRED_STREAM_PREFIX,
  LoginRequiredError,
  agentFetch,
  checkLogin,
  getAuthStatus,
  logout,
  startLogin,
  type AuthStatus,
  type LoginPrompt,
} from "@/lib/owner-api";
import styles from "./chat.module.css";

const TOKEN_KEY = "majordomo.apiToken";

type LoginView =
  | { state: "code"; prompt: LoginPrompt }
  | { state: "unavailable"; message: string }
  | { state: "failed"; message: string };

export function Chat() {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- localStorage exists only after hydration; reading it during render would mismatch the server HTML
    setToken(readStoredToken());
  }, []);

  function saveToken(value: string) {
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {
      // Private mode: the token lives until the tab is closed.
    }
    setToken(value);
  }

  function forgetToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Nothing stored.
    }
    setToken("");
  }

  if (token === null) return null;
  if (!token) return <TokenForm onSubmit={saveToken} />;
  return <ChatSession key={token} token={token} onForgetToken={forgetToken} />;
}

function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function TokenForm({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [draft, setDraft] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.trim()) onSubmit(draft.trim());
  }

  return (
    <form className={styles.card} onSubmit={submit}>
      <h1 className={styles.title}>Majordomo</h1>
      <p>Введите токен владельца (MAJORDOMO_API_TOKEN).</p>
      <div className={styles.row}>
        <input
          className={styles.input}
          type="password"
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Токен"
        />
        <button className={styles.button} type="submit">
          Сохранить
        </button>
      </div>
    </form>
  );
}

function ChatSession({
  token,
  onForgetToken,
}: {
  token: string;
  onForgetToken: () => void;
}) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [login, setLogin] = useState<LoginView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // A turn failed for lack of a session: resend it once the login completes.
  const retryAfterLogin = useRef(false);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({ api: "/api/agent", fetch: agentFetch(token) }),
    [token],
  );
  const chat = useChat({
    transport,
    onError: (error) => {
      if (error instanceof LoginRequiredError) {
        retryAfterLogin.current = true;
        setLogin(
          error.login
            ? { state: "code", prompt: error.login }
            : { state: "unavailable", message: error.message },
        );
        return;
      }
      if (error.message.startsWith(LOGIN_REQUIRED_STREAM_PREFIX)) {
        retryAfterLogin.current = true;
        void requestLogin();
      }
    },
  });

  async function refreshStatus() {
    const next = await getAuthStatus(token);
    if (next instanceof Error) {
      setNotice(next.message);
      return;
    }
    setStatus(next);
  }

  async function requestLogin() {
    setNotice(null);
    const started = await startLogin(token);
    if (started instanceof Error) {
      setNotice(started.message);
      return;
    }
    setLogin(started);
  }

  async function signOut() {
    const done = await logout(token);
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

  // Poll until the owner enters the code: one request at a time, never past the expiry.
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
      const progress = await checkLogin(token);
      if (cancelled) return;
      if (progress instanceof Error) {
        // A network hiccup should not lose the code on screen.
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
  }, [prompt, token]);

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
  const loginError =
    chat.error instanceof LoginRequiredError ||
    chat.error?.message.startsWith(LOGIN_REQUIRED_STREAM_PREFIX);

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
        <button className={styles.link} onClick={onForgetToken}>
          Сменить токен
        </button>
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
              ) : null,
            )}
          </div>
        ))}
        {chat.status === "submitted" && (
          <div className={styles.botMessage}>…</div>
        )}
        {chat.error && !loginError && (
          <p className={styles.notice}>
            {chat.error.message}{" "}
            <button
              className={styles.link}
              onClick={() => void chat.regenerate()}
            >
              Повторить
            </button>
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
