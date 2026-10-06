import { openaiCredentials } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import {
  accessToken,
  CODEX_URL,
  codexAnswer,
  signIn,
} from "@/lib/chatgpt.test-utils";
import { db } from "@/lib/db";
import { createOpenAIAuth } from "@/lib/openai";
import { getDeviceLogin } from "@/lib/openai-store";
import { E2E_ENV } from "./env";
import { expect, test } from "./fixtures";

const AUTH = "https://auth.openai.com";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((token) => {
    localStorage.setItem("majordomo.apiToken", token);
  }, E2E_ENV.MAJORDOMO_API_TOKEN);
});

test("a message without a ChatGPT session leads through the device code login to the answer", async ({
  page,
  openai,
}) => {
  let polls = 0;
  openai.on(`POST ${AUTH}/api/accounts/deviceauth/usercode`, () =>
    Response.json({
      device_auth_id: "dev_e2e",
      user_code: "E2E-1234",
      interval: "1",
    }),
  );
  openai.on(`POST ${AUTH}/api/accounts/deviceauth/token`, () =>
    ++polls < 2
      ? Response.json({ error: "authorization_pending" }, { status: 403 })
      : Response.json({
          authorization_code: "code_e2e",
          code_verifier: "verifier_e2e",
          code_challenge: "challenge_e2e",
        }),
  );
  openai.on(`POST ${AUTH}/oauth/token`, () =>
    Response.json({
      id_token: "id_e2e",
      access_token: accessToken(Date.now() + 60 * 60_000),
      refresh_token: "rt-e2e",
      expires_in: 3600,
    }),
  );
  openai.on(`POST ${CODEX_URL}`, () => codexAnswer("pong"));

  await page.goto("/");
  await expect(page.getByText("Codex: вход не выполнен")).toBeVisible();
  await page.getByPlaceholder("Сообщение").fill("ping");
  await page.getByRole("button", { name: "Отправить" }).click();

  await expect(page.getByText("E2E-1234")).toBeVisible();
  await expect(page.getByText("pong")).toBeVisible();
  await expect(page.getByText("E2E-1234")).toBeHidden();
  await expect(page.getByText("Codex: owner@example.com (pro)")).toBeVisible();

  expect(unwrap(await createOpenAIAuth().status())).toMatchObject({
    state: "active",
    email: "owner@example.com",
  });
  expect(unwrap(await getDeviceLogin())).toBeNull();
  const [row] = await db.select().from(openaiCredentials);
  expect(row?.credential).toMatch(/^v1\./);
  expect(row?.credential).not.toContain("rt-e2e");
});

test("logging out of Codex revokes the refresh token and forgets the session", async ({
  page,
  openai,
}) => {
  await signIn();
  openai.on(`POST ${AUTH}/oauth/revoke`, () => Response.json({}));

  await page.goto("/");
  await page.getByRole("button", { name: "Выйти из Codex" }).click();

  await expect(page.getByText("Codex: вход не выполнен")).toBeVisible();
  expect(openai.requests).toHaveLength(1);
  expect(openai.requests[0]?.body).toContain('"rt-0"');
  expect(unwrap(await createOpenAIAuth().status())).toEqual({
    state: "logged_out",
  });
});
