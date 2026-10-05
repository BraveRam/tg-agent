import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { ownerUpdate, requireOwner, requireControl, internalRequest } from "../agent/lib/security";
import { acquireLock, retryDelay, nodeNetworkOptions } from "../scripts/runtime";
import { bot, TelegramError } from "../agent/lib/telegram";

test("supervised Node processes inherit a usable connection window and preserve overrides", () => {
  const value = execFileSync(
    process.execPath,
    ["-e", "console.log(require('node:net').getDefaultAutoSelectFamilyAttemptTimeout())"],
    {
      env: { ...process.env, NODE_OPTIONS: nodeNetworkOptions("--enable-source-maps") },
      encoding: "utf8",
    },
  );

  assert.equal(Number(value.trim()), 2000);
  assert.equal(
    nodeNetworkOptions("--network-family-autoselection-attempt-timeout=5000"),
    "--network-family-autoselection-attempt-timeout=5000",
  );
  assert.equal(
    nodeNetworkOptions("--no-network-family-autoselection"),
    "--no-network-family-autoselection",
  );
});

test("only owner private messages and callbacks are accepted", () => {
  const m = { from: { id: 42 }, chat: { id: 42, type: "private" } };

  assert.equal(ownerUpdate({ message: m }, "42"), true);
  assert.equal(ownerUpdate({ message: { ...m, from: { id: 7 } } }, "42"), false);
  assert.equal(
    ownerUpdate({ message: { ...m, chat: { id: -100, type: "channel" } } }, "42"),
    false,
  );
  assert.equal(ownerUpdate({ callback_query: { from: { id: 42 }, message: m } }, "42"), true);
});

test("scheduled/source-controlled contexts cannot change settings; empty credentials reject requests", () => {
  assert.throws(() => requireOwner({ session: { auth: { current: null } } }));
  assert.throws(() =>
    requireControl({
      session: { auth: { current: { authenticator: "local-dev", attributes: { runId: "run" } } } },
    }),
  );
  assert.equal(internalRequest(new Request("http://localhost/internal/jobs/1")), false);
});

test("duplicate process cannot own runtime lock; release allows restart; backoff bounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-lock-"));

  try {
    const release = acquireLock(dir);

    assert.throws(() => acquireLock(dir), /already running/);
    release();
    acquireLock(dir)();
    assert.equal(retryDelay(100), 60000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bot API distinguishes accepted-but-lost response, rejection and flood wait", async () => {
  await assert.rejects(
    bot("sendMessage", {}, async () => {
      throw new Error("Sensitive URL");
    }),
    (e) => e instanceof TelegramError && e.ambiguous && !e.message.includes("Sensitive"),
  );
  await assert.rejects(
    bot("sendMessage", {}, async () =>
      Response.json(
        { ok: false, description: "Too many", parameters: { retry_after: 12 } },
        { status: 429 },
      ),
    ),
    (e) => e instanceof TelegramError && !e.ambiguous && e.retryAfter === 12,
  );
});
