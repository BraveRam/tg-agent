import { defineEvalConfig } from "eve/evals";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../agent/lib/store";

export default defineEvalConfig({
  maxConcurrency: 1,

  async setup() {
    const dir = mkdtempSync(join(tmpdir(), "tg-eval-"));

    process.env.TG_DATA_DIR = dir;

    const s = new Store(dir);
    const channel = s.saveChannel({
      chatId: "-10000000001",
      name: "Eval news",
      language: "en",
      style: "Brief",
      timezone: "Africa/Nairobi",
      images: "auto",
    });

    return { dir, s, channel };
  },

  async teardown(context) {
    if (!context) return;

    context.s.close();
    rmSync(context.dir, { recursive: true, force: true });
  },
});
