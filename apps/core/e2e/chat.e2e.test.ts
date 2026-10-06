import {
  ACCOUNT_ID,
  CODEX_URL,
  codexAnswer,
  signIn,
} from "@/lib/chatgpt.test-utils";
import { E2E_ENV } from "./env";
import { expect, test } from "./fixtures";

test("the owner enters the token, talks to the assistant and stays signed in after a reload", async ({
  page,
  openai,
}) => {
  await signIn();
  openai.on(`POST ${CODEX_URL}`, () => codexAnswer("pong"));

  await page.goto("/");
  await page.getByPlaceholder("Токен").fill(E2E_ENV.MAJORDOMO_API_TOKEN);
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Codex: owner@example.com (pro)")).toBeVisible();
  await page.getByPlaceholder("Сообщение").fill("ping");
  await page.getByRole("button", { name: "Отправить" }).click();

  await expect(page.getByText("pong")).toBeVisible();
  expect(openai.requests).toHaveLength(1);
  expect(openai.requests[0]?.headers.get("chatgpt-account-id")).toBe(
    ACCOUNT_ID,
  );
  expect(openai.requests[0]?.body).toContain('"ping"');

  await page.reload();
  await expect(page.getByPlaceholder("Сообщение")).toBeVisible();
  await expect(page.getByPlaceholder("Токен")).toBeHidden();
});

test("a wrong token is rejected and the owner can enter another one", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByPlaceholder("Токен").fill("not-the-owner-token");
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Неверный токен владельца")).toBeVisible();

  await page.getByPlaceholder("Сообщение").fill("ping");
  await page.getByRole("button", { name: "Отправить" }).click();
  const notice = page.getByText(/^Токен не подошёл/);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Сменить токен" }).click();

  await expect(page.getByPlaceholder("Токен")).toBeVisible();
});
