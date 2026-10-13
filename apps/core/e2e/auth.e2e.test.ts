import { CODEX_URL, codexAnswer, signIn } from "@/lib/chatgpt.test-utils";
import { SESSION_COOKIE } from "@/lib/owner-session";
import { BASE_URL, E2E_ENV } from "./env";
import { expect, test } from "./fixtures";

const DAY_S = 24 * 60 * 60;

test("without a session the chat sends the owner to the login page", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page).toHaveURL("/login");
  await expect(page.getByPlaceholder("Токен")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeHidden();
});

test("a wrong token shows an error and sets no cookie", async ({
  page,
  context,
}) => {
  await page.goto("/login");
  await page.getByPlaceholder("Токен").fill("not-the-owner-token");
  await page.getByRole("button", { name: "Войти", exact: true }).click();

  await expect(page.getByText("Неверный токен")).toBeVisible();
  await expect(page).toHaveURL("/login?error=token");
  expect(await context.cookies()).toEqual([]);
});

test("the owner logs in with a 400-day httpOnly cookie, sees the navigation and logs out", async ({
  page,
  context,
}) => {
  await page.goto("/login");
  await page.getByPlaceholder("Токен").fill(E2E_ENV.MAJORDOMO_API_TOKEN);
  await page.getByRole("button", { name: "Войти", exact: true }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByPlaceholder("Сообщение")).toBeVisible();
  const logout = page.getByRole("button", { name: "Выйти", exact: true });
  await expect(logout).toBeVisible();
  const [session] = await context.cookies();
  expect(session).toMatchObject({
    name: SESSION_COOKIE,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
  expect(session?.expires).toBeGreaterThan(Date.now() / 1000 + 399 * DAY_S);
  expect(session?.expires).toBeLessThan(Date.now() / 1000 + 401 * DAY_S);

  await logout.click();

  await expect(page).toHaveURL("/login");
  await expect(logout).toBeHidden();
  expect(await context.cookies()).toEqual([]);
  await page.goto("/");
  await expect(page).toHaveURL("/login");
});

test("a cookie from a previous token sends the owner to the login page (E11)", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: "signed-with-the-previous-token",
      url: BASE_URL,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);

  await page.goto("/");

  await expect(page).toHaveURL("/login");
});

test("a session that expires during the chat leads to the login page and back to a working chat (E11)", async ({
  ownerPage: page,
  context,
  openai,
}) => {
  await signIn();
  openai.on(`POST ${CODEX_URL}`, () => codexAnswer("pong"));
  await page.goto("/");
  await expect(page.getByText("Codex: owner@example.com (pro)")).toBeVisible();
  await context.clearCookies();
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: "signed-with-the-previous-token",
      url: BASE_URL,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);

  await page.getByPlaceholder("Сообщение").fill("ping");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(
    page.getByText(/^Вход устарел\. Войдите заново\./),
  ).toBeVisible();
  await page.getByRole("link", { name: "Войти", exact: true }).click();

  await expect(page).toHaveURL("/login");
  await page.getByPlaceholder("Токен").fill(E2E_ENV.MAJORDOMO_API_TOKEN);
  await page.getByRole("button", { name: "Войти", exact: true }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByText(/^Вход устарел/)).toBeHidden();
  await expect(page.getByText("ping")).toBeHidden();
  await page.getByPlaceholder("Сообщение").fill("ping");
  await page.getByRole("button", { name: "Отправить" }).click();
  await expect(page.getByText("pong")).toBeVisible();
  expect(openai.requests).toHaveLength(1);
});
