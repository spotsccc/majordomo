import {
  ACCOUNT_ID,
  CODEX_URL,
  codexAnswer,
  signIn,
} from "@/lib/chatgpt.test-utils";
import { expect, test } from "./fixtures";

test("the owner talks to the assistant and stays signed in after a reload", async ({
  ownerPage: page,
  openai,
}) => {
  await signIn();
  openai.on(`POST ${CODEX_URL}`, () => codexAnswer("pong"));

  await page.goto("/");
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
  await expect(page).toHaveURL("/");
});
