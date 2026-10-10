import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../agent/lib/store";
import { handleModelCommand } from "../agent/lib/model-command";
import { modelSelectionKey } from "../agent/lib/main-model";
import { selectedModelConfig } from "../agent/lib/selected-model";

test("owner model menu persists all four choices and rejects unauthorized changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tg-model-menu-"));
  const s = new Store(dir);
  const previous = { ...process.env };
  const sent: any[] = [];
  const send = async (method: string, body: any) => {
    sent.push({ method, body });
    return {};
  };
  const message = (id: number) => ({
    update_id: id,
    message: { text: "/model", from: { id: 123 }, chat: { id: 123, type: "private" } },
  });
  const callback = (id: number, choice: string, owner = 123) => ({
    update_id: id,
    callback_query: {
      id: String(id),
      data: `model:${choice}`,
      from: { id: owner },
      message: { message_id: 9, chat: { id: 123, type: "private" } },
    },
  });
  try {
    process.env.TELEGRAM_OWNER_ID = "123";
    process.env.MODEL_PROVIDER = "chatgpt";
    process.env.NVIDIA_API_KEY = "test";
    process.env.AI_GATEWAY_API_KEY = "test";
    assert.equal(await handleModelCommand(message(1), s, send), true);
    assert.equal(sent[0].body.reply_markup.inline_keyboard.length, 4);
    for (const [index, choice, model, reasoning] of [
      [2, "luna", "gpt-6-luna", "low"],
      [3, "sol", "gpt-6.1-sol", "medium"],
      [4, "nvidia", "meta/muse-glimmer-30b", "low"],
      [5, "vercel", "openai/gpt-6-luna", "low"],
    ] as const) {
      assert.equal(await handleModelCommand(callback(index, choice), s, send), true);
      const selected = selectedModelConfig(s);
      assert.equal(selected.model.modelId, model);
      assert.equal(selected.reasoning, reasoning);
    }
    assert.equal(await handleModelCommand(callback(6, "sol", 999), s, send), false);
    assert.equal(s.get(modelSelectionKey, null), "vercel");
    await handleModelCommand(callback(2, "luna"), s, send);
    assert.equal(
      s.get(modelSelectionKey, null),
      "vercel",
      "replayed callback cannot overwrite a later choice",
    );
    delete process.env.NVIDIA_API_KEY;
    await handleModelCommand(callback(7, "nvidia"), s, send);
    assert.equal(s.get(modelSelectionKey, null), "vercel");
    assert.equal(sent.at(-1).body.show_alert, true);
    const reopened = new Store(dir);
    assert.equal(selectedModelConfig(reopened).model.modelId, "openai/gpt-6-luna");
    reopened.close();
  } finally {
    s.close();
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
