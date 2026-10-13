import Link from "next/link";
import { hasOwnerSession } from "@/lib/auth";
import styles from "./layout.module.css";
import { logout } from "./login/actions";

export const metadata = { title: "Majordomo" };

/** The navigation is for the owner only; each page still checks the session itself. */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const signedIn = await hasOwnerSession();
  return (
    <html lang="ru">
      <body>
        {signedIn && (
          <nav className={styles.nav}>
            <Link href="/">Чат</Link>
            <Link href="/finance">Финансы</Link>
            <form action={logout}>
              <button type="submit">Выйти</button>
            </form>
          </nav>
        )}
        {children}
      </body>
    </html>
  );
}
