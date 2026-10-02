import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var hover_default = defineTool({
	description: "Hover the mouse over an element (to reveal menus, tooltips, etc.).",
	inputSchema: z.object({ selector: z.string().describe(SELECTOR_HINT) }),
	async execute({ selector }, ctx) {
		return await runBrowser(ctx, ["hover", selector]);
	}
});
export { hover_default as default };
