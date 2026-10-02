import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var select_option_default = defineTool({
	description: "Select an option in a <select> dropdown by value.",
	inputSchema: z.object({
		selector: z.string().describe(SELECTOR_HINT),
		value: z.string().describe("The option value to select.")
	}),
	async execute({ selector, value }, ctx) {
		return await runBrowser(ctx, [
			"select",
			selector,
			value
		]);
	}
});
export { select_option_default as default };
