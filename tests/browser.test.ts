import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendOwnerImage } from "../agent/lib/owner-image";
import { Store } from "../agent/lib/store";
import { bot, TelegramError } from "../agent/lib/telegram";

const extensionRoot = new URL("../integrations/agent-browser/extension/", import.meta.url);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=",
  "base64",
);

function context(sessionId: string, runs: string[]) {
  const sandbox = {
    async run({ command }: { command: string }) {
      runs.push(command);

      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          success: true,
          data: { path: "/workspace/page.png", title: "Page" },
        }),
      };
    },

    async readBinaryFile() {
      return png;
    },
  };

  return {
    session: { id: sessionId, auth: { current: { authenticator: "local-dev", attributes: {} } } },
    callId: "image-call",

    async getSandbox() {
      return sandbox;
    },
  } as any;
}

test("browser uses Eve session identity without a sandbox id, isolates installation probes, and retains screenshot path", async () => {
  const { runBrowser } = await import(new URL("lib/browser.mjs", extensionRoot).href);
  const { runAgentBrowser } = await import(new URL("lib/sandbox.mjs", extensionRoot).href);
  const { default: screenshot } = await import(new URL("tools/screenshot.mjs", extensionRoot).href);
  const a: string[] = [],
    b: string[] = [];
  const first = context("browser-regression-a", a),
    second = context("browser-regression-b", b);

  await runBrowser(first, ["open", "https://example.com"]);
  await runBrowser(first, ["snapshot"]);
  await runBrowser(second, ["open", "https://example.org"]);
  assert.equal(a.filter((command) => command.startsWith("command -v")).length, 1);
  assert.equal(b.filter((command) => command.startsWith("command -v")).length, 1);
  assert.ok(a[1].includes("browser-regression-a"));
  assert.ok(b[1].includes("browser-regression-b"));
  await runAgentBrowser(first, ["snapshot"]);

  const image = await screenshot.execute({ annotate: false, fullPage: false }, first);
  const output = screenshot.toModelOutput(image);

  assert.ok(image.imageDataUrl.startsWith("data:image/png;base64,"));
  assert.equal(output.value.path, "/workspace/page.png");
  assert.ok(!output.value.screenshot.includes("already displayed"));
});

test("owner screenshot delivery uploads PNG multipart and does not replay or leak temp files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-image-"));
  const s = new Store(dir);
  const oldDir = process.env.TG_DATA_DIR,
    oldOwner = process.env.TELEGRAM_OWNER_ID;

  process.env.TG_DATA_DIR = dir;
  process.env.TELEGRAM_OWNER_ID = "12345";

  try {
    const ctx = context("image-test", []);
    let sends = 0;
    let localPath = "";
    const send: typeof bot = async (method, body: any) => {
      sends++;
      localPath = join(dir, "media", body.photo.slice(9));
      assert.deepEqual(readFileSync(localPath), png);

      return bot(method, body, async (_url, init) => {
        assert.ok(init.body instanceof FormData);
        assert.equal(init.body.get("chat_id"), "12345");

        const upload = init.body.get("photo0") as File;

        assert.equal(upload.type, "image/png");
        assert.ok(upload.name.endsWith(".png"));
        assert.deepEqual(Buffer.from(await upload.arrayBuffer()), png);

        return Response.json({ ok: true, result: { message_id: 77 } });
      });
    };
    const result = await sendOwnerImage(ctx, "/workspace/page.png", "Screenshot", s, send);

    assert.equal(result.status, "sent");
    assert.equal(result.messageId, 77);
    assert.ok(!existsSync(localPath));
    await sendOwnerImage(ctx, "/workspace/page.png", "Screenshot", s, send);
    assert.equal(sends, 1);

    const uncertain = { ...ctx, callId: "uncertain" };
    const fail: typeof bot = async () => {
      sends++;
      throw new TelegramError("Lost acknowledgment", true);
    };

    assert.equal(
      (await sendOwnerImage(uncertain, "page.png", undefined, s, fail)).status,
      "uncertain",
    );
    await sendOwnerImage(uncertain, "page.png", undefined, s, fail);
    assert.equal(sends, 2);
    await assert.rejects(
      sendOwnerImage(
        { ...ctx, session: { auth: { current: null } } },
        "page.png",
        undefined,
        s,
        send,
      ),
      /authentication/,
    );
    await assert.rejects(
      sendOwnerImage(
        {
          ...ctx,
          session: {
            auth: { current: { authenticator: "local-dev", attributes: { runId: "job" } } },
          },
        },
        "page.png",
        undefined,
        s,
        send,
      ),
      /Scheduled jobs/,
    );
  } finally {
    s.close();

    if (oldDir === undefined) delete process.env.TG_DATA_DIR;
    else process.env.TG_DATA_DIR = oldDir;

    if (oldOwner === undefined) delete process.env.TELEGRAM_OWNER_ID;
    else process.env.TELEGRAM_OWNER_ID = oldOwner;

    rmSync(dir, { recursive: true, force: true });
  }
});
