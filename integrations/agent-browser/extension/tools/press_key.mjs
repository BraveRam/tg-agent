import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var press_key_default = defineTool({
	description: "Press a key or key combination in the browser, e.g. \"Enter\", \"Tab\", \"Escape\", \"Control+a\".",
	inputSchema: z.object({ key: z.string().describe("Key name or combination like \"Enter\" or \"Control+a\".") }),
	async execute({ key }, ctx) {
		return await runBrowser(ctx, ["press", key]);
	}
});
export { press_key_default as default };
