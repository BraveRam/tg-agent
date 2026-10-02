import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import extension_default from "../extension.mjs";
import { buildAgentBrowserCommand, installAgentBrowser } from "./sandbox.mjs";
import { AgentBrowserCommandError, createAgentBrowserCommandResult, defaultSessionName, quoteShellArg } from "@agent-browser/sandbox";
const SELECTOR_HINT = "Element selector: a ref from the snapshot tool like \"@e12\" (most reliable), a CSS selector like \"#login .submit\", \"text=Sign in\", or \"xpath=//button[1]\".";
const SANDBOX_DEADLINE_MS = 18e4;
const pendingInstalls = new Map();
async function withDeadline(work, label) {
	let timer;
	try {
		return await Promise.race([work, new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`${label} did not respond within ${SANDBOX_DEADLINE_MS / 1e3}s. The browser sandbox may be starting up or unavailable — try again shortly.`));
			}, SANDBOX_DEADLINE_MS);
		})]);
	} finally {
		clearTimeout(timer);
	}
}
async function runBrowser(ctx, args) {
	const sandbox = await requireSandbox(ctx);
	await ensureInstalled(sandbox, ctx.abortSignal);
	const config = extension_default.config;
	const command = buildAgentBrowserCommand([...args, ...configArgs()], {
		binary: config.binary,
		session: config.session ?? defaultSessionName(config.sessionPrefix, sandbox.id)
	});
	const raw = await withDeadline(sandbox.run({
		abortSignal: ctx.abortSignal,
		command
	}), "The browser command");
	const result = createAgentBrowserCommandResult({
		command,
		exitCode: raw.exitCode,
		stderr: raw.stderr,
		stdout: raw.stdout
	});
	const envelope = result.json;
	if (envelope !== null && envelope.success === false) throw new Error(`agent-browser ${args[0] ?? ""} failed: ${envelope.error ?? "unknown error"}`);
	if (result.exitCode !== 0) throw new AgentBrowserCommandError(result);
	return envelope?.data ?? null;
}
async function requireSandbox(ctx) {
	const sandbox = await withDeadline(ctx.getSandbox(), "The sandbox session");
	if (sandbox === null || sandbox === void 0) throw new Error("The browser tools require an eve sandbox. Configure agent/sandbox.ts in the consuming agent.");
	return sandbox;
}
async function ensureInstalled(sandbox, abortSignal) {
	if (!extension_default.config.autoInstall) return;
	let pending = pendingInstalls.get(sandbox.id);
	if (pending === void 0) {
		pending = installIfMissing(sandbox, abortSignal);
		pendingInstalls.set(sandbox.id, pending);
		pending.catch(() => pendingInstalls.delete(sandbox.id));
	}
	await pending;
}
async function installIfMissing(sandbox, abortSignal) {
	const config = extension_default.config;
	if (((await withDeadline(sandbox.run({
		abortSignal,
		command: `command -v ${quoteShellArg(config.binary)} >/dev/null 2>&1`
	}), "The browser install probe")).exitCode ?? 0) === 0) return;
	await withDeadline(installAgentBrowser(sandbox, {
		abortSignal,
		installBrowser: config.installBrowser,
		installSpec: config.installSpec,
		installSystemDependencies: config.installSystemDependencies
	}), "Installing agent-browser");
}
function configArgs() {
	const config = extension_default.config;
	const args = [];
	if (config.caCert !== void 0 && config.clearCaCert) throw new Error("Cannot use caCert with clearCaCert");
	if (config.allowedDomains !== void 0 && config.allowedDomains.length > 0) args.push("--allowed-domains", config.allowedDomains.join(","));
	if (config.caCert !== void 0) args.push("--ca-cert", config.caCert);
	else if (config.clearCaCert) args.push("--no-ca-cert");
	if (config.contentBoundaries) args.push("--content-boundaries");
	if (config.maxOutputChars !== void 0) args.push("--max-output", String(config.maxOutputChars));
	if (config.proxy !== void 0) args.push("--proxy", config.proxy);
	return args;
}
export { SELECTOR_HINT, runBrowser };
