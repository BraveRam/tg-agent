import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var fill_default = defineTool({
	description: "Type text into an input, textarea, or contenteditable element.",
	inputSchema: z.object({
		clear: z.boolean().default(true).describe("Clear the field first. Set false to append to the existing value."),
		selector: z.string().describe(SELECTOR_HINT),
		text: z.string()
	}),
	async execute({ clear, selector, text }, ctx) {
		return await runBrowser(ctx, [
			clear ? "fill" : "type",
			selector,
			text
		]);
	}
});
export { fill_default as default };
