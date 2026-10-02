import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
async function snapshotWithRetry(ctx, args) {
	try {
		return await runBrowser(ctx, args);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("CDP error")) throw error;
		await new Promise((resolve) => setTimeout(resolve, 500));
		return await runBrowser(ctx, args);
	}
}
var snapshot_default = defineTool({
	description: "Take an accessibility snapshot of the current page. Elements are annotated with refs like [ref=e12] that other tools accept as \"@e12\" selectors. Use this before interacting with a page.",
	inputSchema: z.object({
		compact: z.boolean().default(true).describe("Remove empty structural elements."),
		depth: z.number().int().positive().optional().describe("Limit tree depth."),
		includeUrls: z.boolean().default(false).describe("Include href URLs for links."),
		interactiveOnly: z.boolean().default(false).describe("Only include interactive elements (buttons, links, inputs)."),
		selector: z.string().optional().describe("Scope the snapshot to a CSS selector, e.g. \"#main\". Not a ref like \"@e1\".")
	}),
	async execute({ compact, depth, includeUrls, interactiveOnly, selector }, ctx) {
		const argsFor = (cssSelector) => {
			const args = ["snapshot"];
			if (interactiveOnly) args.push("--interactive");
			if (compact) args.push("--compact");
			if (includeUrls) args.push("--urls");
			if (depth !== void 0) args.push("--depth", String(depth));
			if (cssSelector !== void 0) args.push("--selector", cssSelector);
			return args;
		};
		const cssSelector = selector !== void 0 && !selector.startsWith("@") ? selector : void 0;
		let data;
		try {
			data = await snapshotWithRetry(ctx, argsFor(cssSelector));
		} catch (error) {
			if (cssSelector === void 0) throw error;
			data = await snapshotWithRetry(ctx, argsFor(void 0));
		}
		return {
			origin: data.origin,
			snapshot: data.snapshot
		};
	}
});
export { snapshot_default as default };
