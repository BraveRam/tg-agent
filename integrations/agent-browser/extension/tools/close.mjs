import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var close_default = defineTool({
	description: "Close the browser session and free its resources. Call when you are done with browser work; the next navigate call starts a fresh browser.",
	inputSchema: z.object({}),
	async execute(_input, ctx) {
		return await runBrowser(ctx, ["close"]);
	}
});
export { close_default as default };
