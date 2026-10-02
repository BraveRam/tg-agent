import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { SELECTOR_HINT, runBrowser } from "../lib/browser.mjs";
import { z } from "zod";
import { defineTool } from "eve/tools";
const optionalCondition = z.preprocess((value) => typeof value === "string" && value.trim() === "" ? void 0 : value, z.string().optional());
var wait_for_default = defineTool({
	description: "Wait for conditions on the page: an element, text, a URL pattern, a load state, a JavaScript expression, and/or a fixed delay. Provide at least one; multiple conditions are awaited in sequence (load state first, delay last). Navigation already waits for the page to load, so this is only needed for content that appears later. A condition that does not come true within the timeout returns satisfied: false rather than failing — note that busy pages may never reach networkidle.",
	inputSchema: z.object({
		jsCondition: optionalCondition.describe("JavaScript expression to wait for, e.g. \"window.ready === true\". Also the way to wait for something to disappear: \"!document.querySelector('#spinner')\"."),
		loadState: z.preprocess((value) => value === "" ? void 0 : value, z.enum([
			"load",
			"domcontentloaded",
			"networkidle"
		]).optional()),
		selector: optionalCondition.describe(`Wait for this element to be visible. ${SELECTOR_HINT}`),
		text: optionalCondition.describe("Wait for this text to appear (substring match)."),
		timeMs: z.number().int().positive().max(3e4).optional().describe("Wait a fixed number of milliseconds."),
		timeoutMs: z.number().int().positive().max(3e4).default(1e4).describe("Max time to wait per condition before giving up."),
		urlPattern: optionalCondition.describe("Wait for a URL glob pattern, e.g. \"**/dashboard\".")
	}),
	async execute({ jsCondition, loadState, selector, text, timeMs, timeoutMs, urlPattern }, ctx) {
		const waits = [];
		if (loadState !== void 0) waits.push({
			args: [
				"wait",
				"--load",
				loadState
			],
			condition: `load state ${loadState}`
		});
		if (selector !== void 0) waits.push({
			args: ["wait", selector],
			condition: `element ${selector}`
		});
		if (text !== void 0) waits.push({
			args: [
				"wait",
				"--text",
				text
			],
			condition: `text "${text}"`
		});
		if (urlPattern !== void 0) waits.push({
			args: [
				"wait",
				"--url",
				urlPattern
			],
			condition: `url ${urlPattern}`
		});
		if (jsCondition !== void 0) waits.push({
			args: [
				"wait",
				"--fn",
				jsCondition
			],
			condition: `js ${jsCondition}`
		});
		if (timeMs !== void 0) waits.push({
			args: ["wait", String(timeMs)],
			condition: `${timeMs}ms delay`,
			isDelay: true
		});
		if (waits.length === 0) throw new Error("Provide at least one of: selector, text, urlPattern, loadState, jsCondition, timeMs.");
		const cap = timeoutMs ?? 1e4;
		const outcomes = [];
		for (const wait of waits) {
			const args = wait.isDelay ? wait.args : [
				...wait.args,
				"--timeout",
				String(cap)
			];
			outcomes.push(await runWait(ctx, args, wait.condition));
		}
		return outcomes.length === 1 ? outcomes[0] : outcomes;
	}
});
async function runWait(ctx, args, condition) {
	try {
		return {
			condition,
			satisfied: true,
			result: await runBrowser(ctx, args)
		};
	} catch (error) {
		if (error instanceof Error && /timed out|timeout waiting/i.test(error.message)) return {
			condition,
			satisfied: false,
			timedOut: true
		};
		throw error;
	}
}
export { wait_for_default as default };
