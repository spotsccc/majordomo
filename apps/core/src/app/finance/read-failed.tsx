import styles from "./finance.module.css";

/** A page may not throw (AGENTS.md), so a failed read is logged here and shown in place of the page. */
export function ReadFailed({ error }: { error: Error }) {
  console.error("Финансы: не удалось прочитать данные страницы", error);
  return (
    <main className={styles.page}>
      <p className={styles.error}>
        Не удалось прочитать данные. Обновите страницу.
      </p>
    </main>
  );
}
