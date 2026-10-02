import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var evaluate_default = defineTool({
	description: "Run a JavaScript expression in the page and return its result. The result must be JSON-serializable.",
	inputSchema: z.object({ expression: z.string().describe("JavaScript to evaluate, e.g. \"document.querySelectorAll('a').length\".") }),
	async execute({ expression }, ctx) {
		return await runBrowser(ctx, ["eval", expression]);
	}
});
export { evaluate_default as default };
