import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var read_default = defineTool({
	description: "Read a page as agent-friendly text (markdown when available). With a URL it fetches without the browser; without one it reads the rendered active tab, including logged-in state. Prefer this over snapshot for reading articles or docs.",
	inputSchema: z.object({
		filter: z.string().optional().describe("Narrow the output to matching sections or headings."),
		llms: z.enum(["index", "full"]).optional().describe("Read the site's llms.txt link index or llms-full.txt instead of the page."),
		outline: z.boolean().default(false).describe("Return only a compact heading outline."),
		url: z.string().optional().describe("URL to fetch. Omit to read the active tab.")
	}),
	async execute({ filter, llms, outline, url }, ctx) {
		const args = ["read"];
		if (url !== void 0) args.push(url);
		if (outline) args.push("--outline");
		if (llms !== void 0) args.push("--llms", llms);
		if (filter !== void 0) args.push("--filter", filter);
		return await runBrowser(ctx, args);
	}
});
export { read_default as default };
