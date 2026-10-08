import { createHash, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { HttpError } from "./http";
import {
  formaAccount,
  formaOwnerId,
  type FormaSession,
} from "./sign-in";

export function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

async function neonMemberships(databaseUrl: string, sql: string, params: unknown[]) {
  const endpoint = new URL(databaseUrl);
  endpoint.hostname = endpoint.hostname.replace("-pooler.", ".");
  const response = await fetch(`https://${endpoint.host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": endpoint.toString(),
    },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!response.ok) throw new Error("Sign in to continue.");
  const payload = (await response.json()) as {
    rows?: unknown[];
    fields?: { name: string }[];
  };
  const fields = payload.fields ?? [];
  return (payload.rows ?? []).map((row) => {
    if (!Array.isArray(row)) return (row ?? {}) as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    fields.forEach((field, index) => {
      record[field.name] = row[index];
    });
    return record;
  });
}

export async function currentSession(): Promise<FormaSession> {
  const headerStore = await headers();
  const cookieStore = await cookies();
  const databaseUrl = process.env.WEWEBPLUS_DATABASE_URL ?? "";
  return formaAccount({
    authorization: headerStore.get("authorization"),
    cookie: cookieStore.toString(),
    env: process.env,
    query: databaseUrl
      ? (sql, params) => neonMemberships(databaseUrl, sql, params)
      : undefined,
  });
}

export async function ownerId() {
  const owner = formaOwnerId(await currentSession());
  if (!owner) throw new HttpError(401, "Sign in to your workspace.");
  return owner;
}
