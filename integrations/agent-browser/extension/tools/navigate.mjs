import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var navigate_default = defineTool({
	description: "Navigate the sandboxed browser: open a URL, or go back/forward/reload. Launches the browser on first use. After navigating, call the snapshot tool to see the page.",
	inputSchema: z.object({
		action: z.enum([
			"goto",
			"back",
			"forward",
			"reload"
		]).default("goto").describe("\"goto\" opens the given URL; the others act on history."),
		url: z.string().optional().describe("Required when action is \"goto\".")
	}),
	async execute({ action, url }, ctx) {
		if (action === "goto") {
			if (url === void 0) throw new Error("The \"goto\" action requires a url.");
			return await runBrowser(ctx, ["open", url]);
		}
		return await runBrowser(ctx, [action]);
	}
});
export { navigate_default as default };
