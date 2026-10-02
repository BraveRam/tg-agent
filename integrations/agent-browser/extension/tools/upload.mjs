import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var upload_default = defineTool({
	description: "Attach files to a file input. Paths refer to files inside the sandbox (e.g. under /workspace).",
	inputSchema: z.object({
		files: z.array(z.string()).min(1).describe("Sandbox file paths to attach."),
		selector: z.string().describe(SELECTOR_HINT)
	}),
	async execute({ files, selector }, ctx) {
		return await runBrowser(ctx, [
			"upload",
			selector,
			...files
		]);
	}
});
export { upload_default as default };
