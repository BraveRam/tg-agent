import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { translatePost, translationSchema, translationModel } from "../agent/lib/translation";
import { Store } from "../agent/lib/store";
import { activityText } from "../agent/lib/activity";

const ctx: any = {
  session: { id: "translation-owner", auth: { current: { authenticator: "local-dev" } } },
  callId: "one",
};

async function fixture(fn: (s: Store, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "tg-translation-"));
  const s = new Store(dir);
  const oldKey = process.env.GOOGLE_API_KEY;

  process.env.GOOGLE_API_KEY = "test-google-secret";

  try {
    await fn(s, dir);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });

    if (oldKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = oldKey;
  }
}

const success = (text = "Translated post") => ({
  text,
  finishReason: "stop",
  usage: { inputTokens: 100, outputTokens: 30 },
});

test("translation uses Gemini, sends only draft/style, preserves output and persists replay with cost", async () => {
  await fixture(async (s, dir) => {
    const channel = s.saveChannel({
      chatId: "-100200",
      name: "Amharic",
      language: "am",
      style: "Brief. No added links.",
      timezone: "Africa/Nairobi",
      images: "prefer",
    });
    const input = {
      text: "**News**\n\nA satellite launched in 2026.",
      language: "am" as const,
      channelId: channel.id,
    };
    const output = "**ዜና**\n\nሳተላይት በ2026 ወደ ህዋ ተላከ።";
    let calls = 0;
    const generate = async (options: any) => {
      calls++;
      assert.equal(options.model.modelId, translationModel);
      assert.deepEqual(JSON.parse(options.prompt), { style: channel.style, draft: input.text });
      assert.match(options.system, /Amharic in Ethiopic script/);
      assert.equal(options.messages, undefined);
      assert.equal(options.tools, undefined);
      assert.equal(options.maxRetries, 2);
      assert.equal(options.timeout.totalMs, 45000);

      return success(output);
    };
    const first = await translatePost(input, ctx, { s, generate });

    assert.equal(first.text, output);
    assert.equal(first.estimatedCostUsd, 0.0001875);
    assert.equal(s.spent(), first.estimatedCostUsd);

    const reopened = new Store(dir);

    try {
      assert.deepEqual(await translatePost(input, ctx, { s: reopened, generate }), first);
      assert.equal(calls, 1);
      assert.equal(reopened.spent(), first.estimatedCostUsd);
    } finally {
      reopened.close();
    }

    await assert.rejects(
      translatePost({ ...input, text: "Changed" }, ctx, { s, generate }),
      /input changed/,
    );
  });
});

test("Oromo uses Qubee; English input and unauthenticated calls are rejected; owner can override channel language", async () => {
  await fixture(async (s) => {
    let calls = 0;
    const generate = async (options: any) => {
      calls++;
      assert.match(options.system, /Afaan Oromo in Qubee/);

      return success("Oduu haaraa");
    };

    assert.equal(
      (await translatePost({ text: "News", language: "om" }, ctx, { s, generate })).text,
      "Oduu haaraa",
    );
    assert.equal(translationSchema.safeParse({ text: "News", language: "en" }).success, false);
    await assert.rejects(
      translatePost(
        { text: "News", language: "om" },
        { session: {}, callId: "bad" },
        { s, generate },
      ),
      /authentication/,
    );

    const channel = s.saveChannel({
      chatId: "-100201",
      name: "English",
      language: "en",
      style: "Brief",
      timezone: "Africa/Nairobi",
      images: "auto",
    });

    const overridden = await translatePost(
      { text: "News", language: "om", channelId: channel.id },
      { ...ctx, callId: "owner-override" },
      { s, generate },
    );

    assert.equal(overridden.language, "om");
    assert.equal(calls, 2);
  });
});

test("provider errors are redacted and incomplete outputs are charged but never cached", async () => {
  await fixture(async (s) => {
    const input = { text: "News", language: "om" as const };

    await assert.rejects(
      translatePost(input, ctx, {
        s,
        generate: async () => {
          throw new Error("Rejected test-google-secret");
        },
      }),
      (error: any) => {
        assert.doesNotMatch(error.message, /test-google-secret/);
        assert.match(error.message, /Do not publish or fall back/);

        return true;
      },
    );
    assert.equal(activityText("test-google-secret"), "[redacted]");
    await assert.rejects(
      translatePost(input, ctx, {
        s,
        generate: async () => ({ ...success(), finishReason: "length" }),
      }),
      /incomplete/,
    );
    assert.equal(s.spent(), 0.0001875);
    assert.equal(s.get("translation:translation-owner:one", null), null);
    await translatePost(input, ctx, { s, generate: async () => success() });
    assert.equal(s.spent(), 0.000375);
  });
});

test("missing key, cancellation and missing usage do not produce a publishable translation", async () => {
  await fixture(async (s) => {
    const input = { text: "News", language: "am" as const };
    let calls = 0;
    const generate = async () => {
      calls++;

      return success();
    };

    delete process.env.GOOGLE_API_KEY;
    await assert.rejects(translatePost(input, ctx, { s, generate }), /GOOGLE_API_KEY/);
    process.env.GOOGLE_API_KEY = "test-google-secret";

    const controller = new AbortController();

    controller.abort(new Error("Owner cancelled"));
    await assert.rejects(
      translatePost(input, { ...ctx, abortSignal: controller.signal }, { s, generate }),
      /Owner cancelled/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      translatePost(input, ctx, {
        s,
        generate: async () => ({
          ...success(),
          usage: { inputTokens: undefined, outputTokens: undefined },
        }),
      }),
      /token usage/,
    );
    assert.equal(s.budgetAvailable(), false);
  });
});

test("scheduled translation enforces job scope, budget and pause before returning content", async () => {
  await fixture(async (s) => {
    const channel = s.saveChannel({
      chatId: "-100202",
      name: "Oromo",
      language: "om",
      style: "Brief",
      timezone: "Africa/Nairobi",
      images: "auto",
    });
    const job = s.saveJob({
      channelId: channel.id,
      name: "News",
      task: "AI",
      sources: [],
      schedule: { kind: "interval", minutes: 5 },
      freshnessHours: 24,
    });
    const [run] = s.claimDue(Date.now() + 600000);
    const scheduled = {
      ...ctx,
      callId: "scheduled",
      session: {
        ...ctx.session,
        auth: { current: { authenticator: "local-dev", attributes: { runId: run.id } } },
      },
    };
    const input = { text: "News", language: "om" as const, channelId: channel.id };
    let calls = 0;
    const generate = async () => {
      calls++;

      return success();
    };

    await assert.rejects(
      translatePost({ ...input, channelId: "other" }, scheduled, { s, generate }),
      /current job/,
    );
    s.set("budget.daily", 0);
    await assert.rejects(translatePost(input, scheduled, { s, generate }), /budget/);
    assert.equal(calls, 0);
    // Owner control stays available even when autonomous work is budget-paused.
    await translatePost(input, { ...ctx, callId: "owner-budget" }, { s, generate });
    s.set("budget.daily", 2);
    await assert.rejects(
      translatePost(input, scheduled, {
        s,
        generate: async () => {
          s.enableJob(job.id, false);

          return success();
        },
      }),
      /paused/,
    );
    assert.equal(s.get("translation:translation-owner:scheduled", null), null);
  });
});
