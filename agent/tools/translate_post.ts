import { defineTool } from "eve/tools";

import { translatePost, translationSchema } from "../lib/translation";

export default defineTool({
  availableInSubagents: false,
  description:
    "Translate a finished news draft into Amharic (am) or Afaan Oromo (om) using Gemini 3.7 Flash. Required for posts in those languages; English posts skip this tool. Supply the registered channelId to load its saved style; scheduled calls must match their job's channel. Send only the draft and relevant style guidance. Publish the returned text unchanged with your selected media. On failure, leave the post unpublished; never translate with MiMo as a fallback.",
  inputSchema: translationSchema,
  execute: (input, ctx) => translatePost(input, ctx),
});
