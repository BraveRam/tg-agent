import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var scroll_default = defineTool({
	description: "Scroll the page or a scrollable container, or scroll an element into view (pass only a selector).",
	inputSchema: z.object({
		direction: z.enum([
			"up",
			"down",
			"left",
			"right"
		]).optional().describe("Omit to scroll the selector's element into view instead."),
		pixels: z.number().int().positive().optional().describe("Scroll distance in pixels."),
		selector: z.string().optional().describe(`Scroll container, or the element to bring into view. ${SELECTOR_HINT}`)
	}),
	async execute({ direction, pixels, selector }, ctx) {
		if (direction === void 0) {
			if (selector === void 0) throw new Error("Provide a direction to scroll, or a selector to scroll into view.");
			return await runBrowser(ctx, ["scrollintoview", selector]);
		}
		const args = ["scroll", direction];
		if (pixels !== void 0) args.push(String(pixels));
		if (selector !== void 0) args.push("--selector", selector);
		return await runBrowser(ctx, args);
	}
});
export { scroll_default as default };
