import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
var network_requests_default = defineTool({
	description: "List network requests tracked for the current page, or fetch the full detail of one request by id. Filter by URL substring, resource type, HTTP method, or status.",
	inputSchema: z.object({
		filter: z.string().optional().describe("Only requests whose URL contains this text."),
		method: z.string().optional().describe("HTTP method filter, e.g. \"POST\"."),
		requestId: z.string().optional().describe("Return full request/response detail for this request id instead of a list."),
		resourceTypes: z.array(z.string()).optional().describe("Resource type filter, e.g. [\"xhr\", \"fetch\"]."),
		status: z.string().optional().describe("Status filter: \"200\", \"2xx\", or a range like \"400-499\".")
	}),
	async execute({ filter, method, requestId, resourceTypes, status }, ctx) {
		if (requestId !== void 0) return await runBrowser(ctx, [
			"network",
			"request",
			requestId
		]);
		const args = ["network", "requests"];
		if (filter !== void 0) args.push("--filter", filter);
		if (resourceTypes !== void 0 && resourceTypes.length > 0) args.push("--type", resourceTypes.join(","));
		if (method !== void 0) args.push("--method", method);
		if (status !== void 0) args.push("--status", status);
		return await runBrowser(ctx, args);
	}
});
export { network_requests_default as default };
