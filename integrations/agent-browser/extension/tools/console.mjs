import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var console_default = defineTool({
	description: "Read the browser console messages and uncaught page errors collected for the current session. Useful for debugging why a page misbehaves.",
	inputSchema: z.object({ clear: z.boolean().default(false).describe("Clear collected messages and errors after reading.") }),
	async execute({ clear }, ctx) {
		const consoleArgs = clear ? ["console", "--clear"] : ["console"];
		const errorArgs = clear ? ["errors", "--clear"] : ["errors"];
		const messages = await runBrowser(ctx, consoleArgs);
		return {
			errors: (await runBrowser(ctx, errorArgs)).errors ?? [],
			messages: messages.messages ?? []
		};
	}
});
export { console_default as default };
