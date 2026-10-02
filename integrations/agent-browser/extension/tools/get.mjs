import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
const PAGE_PROPERTIES = new Set(["title", "url"]);
var get_default = defineTool({
	description: "Read a property of the page or an element: text content, innerHTML, input value, an attribute, the page title or URL, a match count, bounding box, or computed styles.",
	inputSchema: z.object({
		attribute: z.string().optional().describe("Attribute name, required when property is \"attr\"."),
		property: z.enum([
			"text",
			"html",
			"value",
			"attr",
			"title",
			"url",
			"count",
			"box",
			"styles"
		]),
		selector: z.string().optional().describe(`Required for element properties. ${SELECTOR_HINT}`)
	}),
	async execute({ attribute, property, selector }, ctx) {
		const args = ["get", property];
		if (!PAGE_PROPERTIES.has(property)) {
			if (selector === void 0) throw new Error(`The "${property}" property requires a selector.`);
			args.push(selector);
			if (property === "attr") {
				if (attribute === void 0) throw new Error("The \"attr\" property requires an attribute name.");
				args.push(attribute);
			}
		}
		return await runBrowser(ctx, args);
	}
});
export { get_default as default };
