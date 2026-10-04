import { timingSafeEqual } from "node:crypto";

import { config } from "./config";
import { store } from "./store";

export function secretMatches(actual: string | null, expected: string): boolean {
  if (!actual || !expected) return false;

  const a = Buffer.from(actual),
    b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}

export function internalRequest(request: Request) {
  return (
    secretMatches(request.headers.get("authorization"), `Bearer ${config().internalToken}`) &&
    !!config().internalToken
  );
}

export function requireOwner(ctx: any) {
  const auth = ctx.session?.auth?.current;

  if (!auth) throw new Error("Owner authentication required");

  const local = auth.authenticator === "local-dev";

  if (
    !local &&
    (!config().ownerId || auth.principalType !== "user" || auth.principalId !== config().ownerId)
  )
    throw new Error("Owner authentication required");

  return auth;
}

export function requireControl(ctx: any) {
  const auth = requireOwner(ctx);

  if (auth.attributes?.runId)
    throw new Error("Scheduled jobs cannot change settings or create new jobs");

  return auth;
}

export function runId(ctx: any): string | null {
  return requireOwner(ctx).attributes?.runId ?? null;
}

export function assertRun(ctx: any) {
  const id = runId(ctx);

  if (id) {
    store().activeRun(id);

    if (!store().budgetAvailable()) throw new Error("Daily model budget reached");
  }

  return id;
}

export function ownerUpdate(update: any, owner = config().ownerId) {
  const m = update.message;
  const q = update.callback_query;

  return (
    !!owner &&
    ((m?.chat?.type === "private" && String(m.from?.id) === owner && String(m.chat.id) === owner) ||
      (q?.message?.chat?.type === "private" &&
        String(q.from?.id) === owner &&
        String(q.message.chat.id) === owner))
  );
}
