import { requireOwnerSession } from "@/lib/auth";
import {
  listCategories,
  listCurrencies,
  summarize,
} from "@/lib/finance/finance-store";
import { ownerMonthRange } from "@/lib/owner-time";
import {
  archiveCategoryAction,
  createCategoryAction,
  renameCategoryAction,
} from "../actions";
import styles from "../finance.module.css";
import { formError } from "../form-errors";
import { money } from "../format";
import { ReadFailed } from "../read-failed";

export const metadata = { title: "Категории — Majordomo" };

export default async function CategoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  await requireOwnerSession();
  const { error } = await searchParams;
  const [categories, currencies, summary] = await Promise.all([
    listCategories({ includeArchived: true }),
    listCurrencies(),
    // oxlint-disable-next-line react/purity -- a Server Component renders once per request, so the time is fixed for the whole page
    summarize(ownerMonthRange(new Date())),
  ]);
  if (categories instanceof Error) return <ReadFailed error={categories} />;
  if (currencies instanceof Error) return <ReadFailed error={currencies} />;
  if (summary instanceof Error) return <ReadFailed error={summary} />;

  const spent = (id: string) =>
    summary.expenses
      .filter((expense) => expense.categoryId === id)
      .map((expense) => money(expense.amount, expense.currency, currencies))
      .join(" · ") || "—";
  const active = categories.filter((category) => !category.archivedAt);
  const archived = categories.filter((category) => category.archivedAt);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Категории</h1>
      {formError(error) && (
        <p className={styles.error} role="alert">
          {formError(error)}
        </p>
      )}
      <form className={styles.inline} action={createCategoryAction}>
        <input
          name="name"
          aria-label="Новая категория"
          placeholder="Новая категория"
        />
        <button className={styles.primary} type="submit">
          Создать
        </button>
      </form>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Категория</th>
            <th className={styles.amount}>Траты в этом месяце</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {active.map((category) => (
            <tr key={category.id}>
              <td>
                <form
                  className={styles.inline}
                  action={renameCategoryAction.bind(null, category.id)}
                >
                  <input
                    name="name"
                    aria-label={`Имя категории ${category.name}`}
                    defaultValue={category.name}
                  />
                  <button className={styles.secondary} type="submit">
                    Переименовать
                  </button>
                </form>
              </td>
              <td className={styles.amount}>{spent(category.id)}</td>
              <td>
                <form action={archiveCategoryAction.bind(null, category.id)}>
                  <button
                    className={styles.secondary}
                    type="submit"
                    aria-label={`В архив: ${category.name}`}
                  >
                    В архив
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {archived.length > 0 && (
        <details>
          <summary className={styles.muted}>Архив ({archived.length})</summary>
          <ul>
            {archived.map((category) => (
              <li key={category.id}>{category.name}</li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}
