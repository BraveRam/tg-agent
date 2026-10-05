import { defineHook } from "eve/hooks";

import { recordTyping } from "../lib/typing";

export default defineHook({
  events: {
    "*": (event, ctx) => recordTyping(event, ctx),
  },
});
