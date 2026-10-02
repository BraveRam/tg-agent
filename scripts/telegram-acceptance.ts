import assert from "node:assert/strict";
import { join } from "node:path";
import { config } from "../agent/lib/config";
import { Store } from "../agent/lib/store";
import { bot, checkDestination } from "../agent/lib/telegram";
import { enqueuePost, deliverPublication, revisePublication } from "../agent/lib/publishing";

// Explicitly configured disposable channels only. Does not modify operational jobs.
const channels = JSON.parse(process.env.TG_TEST_CHANNELS ?? "{}") as Record<string, string>;
const photo = process.env.TG_TEST_PHOTO_URL;
const credit = process.env.TG_TEST_PHOTO_CREDIT;
const source = process.env.TG_TEST_SOURCE_URL;
if (!["en", "am", "om"].every((language) => channels[language]) || !photo || !credit || !source) {
  throw new Error(
    "Set TG_TEST_CHANNELS JSON with en/am/om disposable channels, TG_TEST_PHOTO_URL, TG_TEST_PHOTO_CREDIT and TG_TEST_SOURCE_URL. The supplied photo must permit reuse. Start bun dev first.",
  );
}
const s = new Store(join(config().dataDir, "acceptance"));
const labels = { en: "Integration test", am: "የሙከራ መልዕክት", om: "Ergaa yaalii" };
try {
  for (const language of ["en", "am", "om"] as const) {
    const chat = await bot("getChat", { chat_id: channels[language] });
    await checkDestination(String(chat.id));
    const channel = s.saveChannel({
      chatId: String(chat.id),
      name: chat.title,
      language,
      style: "Test",
      timezone: "Africa/Nairobi",
      images: "auto",
    });
    for (const count of [0, 1, 2]) {
      const nonce = crypto.randomUUID();
      const p = enqueuePost(
        {
          channelId: channel.id,
          headline: `${labels[language]} ${nonce}`,
          text: `${labels[language]}: tg-agent (${count} photos). ${nonce}`,
          evidence: [
            {
              url: `${source}${source.includes("?") ? "&" : "?"}test=${nonce}`,
              claim: "Explicit integration test fixture",
            },
          ],
          media: Array.from({ length: count }, () => ({ url: photo, credit, reuseAllowed: true })),
        },
        null,
        s,
      );
      await deliverPublication(p.id, s);
      assert.equal(s.publication(p.id).status, "verified", `Delivery failed: ${p.id}`);
      await revisePublication(
        p.id,
        "edit",
        "Integration test correction",
        `${labels[language]}: tg-agent (edited). ${nonce}`,
        s,
      );
      assert.equal(s.publication(p.id).status, "verified", `Edit failed: ${p.id}`);
      await revisePublication(p.id, "delete", "Remove integration test fixture", undefined, s);
      assert.equal(s.publication(p.id).status, "deleted", `Deletion failed: ${p.id}`);
    }
    console.log(`${language}: text, photo, album, edit and deletion verified`);
  }
} finally {
  // Keep the acceptance ledger so incomplete tests can be inspected and cleaned up.
  s.close();
}
