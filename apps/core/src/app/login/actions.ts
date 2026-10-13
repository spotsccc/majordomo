"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  isOwnerToken,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  sessionValue,
} from "@/lib/owner-session";

const LoginForm = z.object({ token: z.string().trim() });

/** There is no limit on attempts: the token is at least 32 characters long. */
export async function login(formData: FormData): Promise<void> {
  const form = LoginForm.safeParse({ token: formData.get("token") });
  if (!form.success || !isOwnerToken(form.data.token)) {
    redirect("/login?error=token");
  }
  (await cookies()).set(SESSION_COOKIE, sessionValue(), SESSION_COOKIE_OPTIONS);
  redirect("/");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
