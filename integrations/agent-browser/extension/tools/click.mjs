import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var click_default = defineTool({
	description: "Click (or double-click) an element on the current page.",
	inputSchema: z.object({
		doubleClick: z.boolean().default(false),
		newTab: z.boolean().default(false).describe("Open the click target in a new tab."),
		selector: z.string().describe(SELECTOR_HINT)
	}),
	async execute({ doubleClick, newTab, selector }, ctx) {
		const args = [doubleClick ? "dblclick" : "click", selector];
		if (newTab) args.push("--new-tab");
		return await runBrowser(ctx, args);
	}
});
export { click_default as default };
