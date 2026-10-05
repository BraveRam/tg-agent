import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { config } from "../agent/lib/config";
import { Store } from "../agent/lib/store";
import { bot, checkDestination } from "../agent/lib/telegram";
import { executeTelegramApi } from "../agent/lib/telegram-api";
import { signUserbotScope } from "../agent/lib/userbot-scope";
import { secretMatches } from "../agent/lib/security";

// Explicitly selected disposable channel. Uses an isolated ledger and copied login session.
const reference = process.env.TG_MONITOR_TEST_CHANNEL;

if (!reference)
  throw new Error(
    "Set TG_MONITOR_TEST_CHANNEL to an owner-authorized disposable broadcast channel",
  );

const c = config();

const dir = mkdtempSync(join(tmpdir(), "tg-monitor-check-"));

const s = new Store(dir);

const exec = promisify(execFile);

const server = createServer(async (request, response) => {
  try {
    if (!secretMatches(request.headers.authorization ?? null, `Bearer ${c.internalToken}`)) {
      response.writeHead(401).end();

      return;
    }

    let value: any;

    if (request.method === "GET" && request.url === "/internal/sources") {
      value = {
        sources: s
          .sources()
          .filter((source) => source.monitoring)
          .map((source) => ({
            source: source.reference,
            chatId: source.chatId,
            membership: source.membership,
            cursor: s.get("source.cursor:" + source.reference, 0),
            trackedIds: [],
          })),
      };
    } else {
      let raw = "";

      for await (const chunk of request) raw += chunk;

      const body = JSON.parse(raw);

      if (request.url === "/internal/source-state") value = s.saveSource(body);
      else if (request.url === "/internal/sources") {
        s.source(body.source, body.messages, body.cursor, body.bootstrap);
        value = { ok: true };
      } else throw new Error("Unknown route");
    }

    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
  } catch {
    response.writeHead(500).end();
  }
});

await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

const address = server.address() as { port: number };

const workerPort = Number(process.env.TG_MONITOR_TEST_PORT ?? 2999);

let worker: ReturnType<typeof spawn> | undefined;

let messageId: number | undefined;

let target: string | undefined;

const ctx: any = {
  session: {
    id: randomUUID(),
    auth: {
      current: {
        authenticator: "telegram",
        principalType: "user",
        principalId: c.ownerId,
        attributes: { privateChat: "true" },
      },
    },
  },
  channel: { kind: "telegram" },
  callId: "",
};

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 45000;

  while (Date.now() < deadline) {
    if (await check()) return;

    await new Promise((done) => setTimeout(done, 500));
  }

  throw new Error(`${label} timed out`);
}

async function call(method: string, params: Record<string, unknown>) {
  ctx.callId = randomUUID();

  const result = await executeTelegramApi({ method, params }, ctx, s);

  assert.equal(result.status, "sent", `${method}: ${result.status}`);

  return result.result;
}

async function rpc(path: string, body: unknown, claims: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${workerPort}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: "Bearer " + signUserbotScope(claims),
    },
    body: JSON.stringify(body),
  });

  assert.ok(response.ok, `${path} returned ${response.status}`);

  return response.json();
}

try {
  const chat = await bot("getChat", { chat_id: reference });

  assert.equal(chat.type, "channel");
  target = String(chat.id);
  await checkDestination(target);

  const destination = s.saveChannel({
    chatId: target,
    name: "Monitoring acceptance",
    language: "en",
    style: "Test",
    timezone: "Africa/Nairobi",
    images: "never",
  });

  s.saveSource({ reference, chatId: target });
  await exec(resolve(".venv/bin/python"), [
    "-c",
    "import sqlite3,sys; source=sqlite3.connect(sys.argv[1]); destination=sqlite3.connect(sys.argv[2]); source.backup(destination); destination.close(); source.close()",
    join(c.dataDir, "userbot.session"),
    join(dir, "userbot.session"),
  ]);
  worker = spawn(
    resolve(".venv/bin/python"),
    [
      "-m",
      "uvicorn",
      "userbot.app:app",
      "--host",
      "127.0.0.1",
      "--port",
      String(workerPort),
      "--log-level",
      "error",
    ],
    { env: { ...process.env, TG_DATA_DIR: dir, TG_PORT: String(address.port) }, stdio: "ignore" },
  );
  await waitFor(async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${workerPort}/health`, {
          headers: { authorization: "Bearer " + c.internalToken },
        })
      ).ok;
    } catch {
      return false;
    }
  }, "Worker startup");

  const joined = await rpc("/join", { channel: reference }, { channels: [], join: reference });

  assert.equal(joined.membership, "joined");
  s.saveSource({ reference, ...joined });
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${workerPort}/health`, {
      headers: { authorization: "Bearer " + c.internalToken },
    });

    return (await response.json()).sourceHealth[reference] === "ready";
  }, "Initial history bootstrap");
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM source_updates").get() as any).n, 0);

  const job = s.saveJob({
    channelId: destination.id,
    name: "Live acceptance",
    task: "Inspect test updates",
    sources: [{ kind: "telegram", reference, trust: "verify" }],
    trigger: "source_updates",
    schedule: { kind: "interval", minutes: 5 },
    freshnessHours: 24,
  });
  const nonce = randomUUID();
  const posted = await call("sendMessage", {
    chat_id: target,
    text: `tg-agent monitoring integration test ${nonce}`,
  });

  messageId = posted.message_id;
  await waitFor(
    () => s.sourceMessages(reference, [messageId!]).some((message) => message.text.includes(nonce)),
    "New post event",
  );

  const scoped = { channels: [target] };
  const readback = await rpc("/messages", { channel: reference, ids: [messageId] }, scoped);

  assert.equal(readback.messages[0].id, messageId);
  await call("editMessageText", {
    chat_id: target,
    message_id: messageId,
    text: `tg-agent edited integration test ${nonce}`,
  });
  await waitFor(
    () =>
      s.sourceMessages(reference, [messageId!]).some((message) => message.text.includes("edited")),
    "Edit event",
  );
  await call("deleteMessage", { chat_id: target, message_id: messageId });
  await waitFor(
    () => s.sourceMessages(reference, [messageId!]).some((message) => message.deleted),
    "Deletion event",
  );

  const batch = s.claimEventJobs(Date.now() + 16000).find((run) => run.jobId === job.id);

  assert.ok(batch);
  assert.equal(s.get<any[]>("run.eventMessages:" + batch.id, []).length, 3);
  s.runState(batch.id, "completed");
  assert.equal(s.claimEventJobs(Date.now() + 32000).length, 0);
  console.log(
    "Live channel join, scoped readback, new/edit/delete events and fixed event batch verified; fixture removed.",
  );
  messageId = undefined;
} finally {
  if (messageId && target)
    await bot("deleteMessage", { chat_id: target, message_id: messageId }).catch(() => {});

  if (worker) {
    worker.kill("SIGTERM");
    await new Promise<void>((done) => {
      if (worker!.exitCode !== null) done();
      else worker!.once("exit", () => done());
    });
  }

  await new Promise<void>((done) => server.close(() => done()));
  s.close();
  rmSync(dir, { recursive: true, force: true });
}
