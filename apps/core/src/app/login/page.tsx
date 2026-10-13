import styles from "../chat.module.css";
import { login } from "./actions";

export const metadata = { title: "Вход — Majordomo" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return (
    <form className={styles.card} action={login}>
      <h1 className={styles.title}>Majordomo</h1>
      <label htmlFor="token">Токен владельца (MAJORDOMO_API_TOKEN)</label>
      <div className={styles.row}>
        <input
          id="token"
          name="token"
          className={styles.input}
          type="password"
          autoComplete="current-password"
          placeholder="Токен"
          required
        />
        <button className={styles.button} type="submit">
          Войти
        </button>
      </div>
      {error === "token" && <p className={styles.notice}>Неверный токен</p>}
    </form>
  );
}
