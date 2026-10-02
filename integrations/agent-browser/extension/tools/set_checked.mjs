import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var set_checked_default = defineTool({
	description: "Check or uncheck a checkbox or radio input.",
	inputSchema: z.object({
		checked: z.boolean(),
		selector: z.string().describe(SELECTOR_HINT)
	}),
	async execute({ checked, selector }, ctx) {
		return await runBrowser(ctx, [checked ? "check" : "uncheck", selector]);
	}
});
export { set_checked_default as default };
