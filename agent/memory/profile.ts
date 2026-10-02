import { defineMemory } from "eve/memory";
import { fileMemory, MemoryDocumentConflictError } from "eve/memory/file";
import { store } from "../lib/store";
import { requireOwner } from "../lib/security";
export default defineMemory({
  namespace: "tg-agent-owner-v1",
  description:
    "Stable owner preferences and language/editorial guidance. Never save credentials or authoritative job status.",
  scope(ctx) {
    try {
      requireOwner(ctx);
      return "owner";
    } catch {
      return null;
    }
  },
  provider: fileMemory({
    backend: {
      async read({ key }) {
        const r = store()
          .db.prepare("SELECT content,version FROM memories WHERE key=?")
          .get(key) as { content: string; version: number } | undefined;
        return r ? { content: r.content, version: String(r.version) } : null;
      },
      async write({ key, content, expectedVersion }) {
        return store().transaction(() => {
          const r = store().db.prepare("SELECT version FROM memories WHERE key=?").get(key) as
            | { version: number }
            | undefined;
          if ((r ? String(r.version) : null) !== expectedVersion)
            throw new MemoryDocumentConflictError(key);
          const version = (r?.version ?? 0) + 1;
          store()
            .db.prepare(
              "INSERT INTO memories VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET content=excluded.content,version=excluded.version",
            )
            .run(key, content, version);
          return { content, version: String(version) };
        });
      },
    },
  }),
});
