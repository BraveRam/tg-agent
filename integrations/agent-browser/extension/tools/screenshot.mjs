import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import extension_default from "../extension.mjs";
import { runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
const MAX_INLINE_SCREENSHOT_BYTES = 4194304;
var screenshot_default = defineTool({
	description: "Take a screenshot of the current page and save it inside the sandbox. Returns the sandbox file path. With annotate, interactive elements get numbered labels matching snapshot refs (@eN).",
	inputSchema: z.object({
		annotate: z.boolean().default(false).describe("Overlay numbered labels on interactive elements."),
		fullPage: z.boolean().default(false).describe("Capture the full scrollable page."),
		path: z.string().optional().describe("Sandbox path to save to. Defaults to a temporary file.")
	}),
	async execute({ annotate, fullPage, path }, ctx) {
		const args = ["screenshot"];
		if (path !== void 0) args.push(path);
		if (fullPage) args.push("--full");
		if (annotate) args.push("--annotate");
		const data = await runBrowser(ctx, args);
		const imageDataUrl = await inlineImage(ctx, data?.path);
		return imageDataUrl === void 0 ? { ...data } : {
			...data,
			imageDataUrl
		};
	},
	toModelOutput(output) {
		const { imageDataUrl, ...rest } = output;
		if (imageDataUrl === void 0) return {
			type: "json",
			value: rest
		};
		const visible = rest;
		return {
			type: "json",
			value: {
				...visible,
				screenshot: "Captured in the sandbox. Use send_image with the returned path when the owner requests the screenshot in Telegram."
			}
		};
	}
});
async function inlineImage(ctx, path) {
	if (!extension_default.config.inlineScreenshots || path === void 0) return;
	try {
		const bytes = await (await ctx.getSandbox())?.readBinaryFile?.({ path });
		if (!bytes || bytes.length === 0 || bytes.length > MAX_INLINE_SCREENSHOT_BYTES) return;
		return `data:${mimeTypeFor(path)};base64,${Buffer.from(bytes).toString("base64")}`;
	} catch {
		return;
	}
}
function mimeTypeFor(path) {
	const lower = path.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	return "image/png";
}
export { screenshot_default as default };
