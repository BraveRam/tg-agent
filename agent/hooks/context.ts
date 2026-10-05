import { defineHook } from "eve/hooks";

import { requireOwner } from "../lib/security";
import { recordContext } from "../lib/context-command";

export default defineHook({
  events: {
    "*": (event, ctx) => {
      try {
        requireOwner(ctx);
      } catch {
        return;
      }

      const attributes = ctx.session.auth.current?.attributes;

      if (ctx.session.parent || attributes?.privateChat !== "true" || attributes.runId) return;

      recordContext(event, ctx.session.id);
    },
  },
});
