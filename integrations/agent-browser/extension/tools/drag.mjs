import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var drag_default = defineTool({
	description: "Drag an element and drop it onto another element.",
	inputSchema: z.object({
		source: z.string().describe(`Element to drag. ${SELECTOR_HINT}`),
		target: z.string().describe(`Element to drop onto. ${SELECTOR_HINT}`)
	}),
	async execute({ source, target }, ctx) {
		return await runBrowser(ctx, [
			"drag",
			source,
			target
		]);
	}
});
export { drag_default as default };
