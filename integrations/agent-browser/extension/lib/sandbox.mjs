import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { AgentBrowserCommandError, DEFAULT_AGENT_BROWSER_INSTALL_SPEC, buildAgentBrowserArgv, buildShellCommand, createAgentBrowserCommandResult, defaultSessionName, quoteShellArg, quoteShellArg as quoteShellArg$1, resolveAgentBrowserInstallSpec, resolveAgentBrowserInstallSpec as resolveAgentBrowserInstallSpec$1, throwIfCommandFailed } from "@agent-browser/sandbox";
const APT_CHROMIUM_DEPENDENCIES = [
	["libxcb-shm0"],
	["libx11-xcb1"],
	["libx11-6"],
	["libxcb1"],
	["libxext6"],
	["libxrandr2"],
	["libxcomposite1"],
	["libxcursor1"],
	["libxdamage1"],
	["libxfixes3"],
	["libxi6"],
	["libgtk-3-0", "libgtk-3-0t64"],
	["libglib2.0-0", "libglib2.0-0t64"],
	["libpangocairo-1.0-0", "libpangocairo-1.0-0t64"],
	["libpango-1.0-0", "libpango-1.0-0t64"],
	["libatk1.0-0", "libatk1.0-0t64"],
	["libcairo-gobject2", "libcairo-gobject2t64"],
	["libcairo2", "libcairo2t64"],
	["libgdk-pixbuf-2.0-0", "libgdk-pixbuf-2.0-0t64"],
	["libxrender1"],
	["libasound2", "libasound2t64"],
	["libfreetype6"],
	["libfontconfig1"],
	["libdbus-1-3", "libdbus-1-3t64"],
	["libnss3"],
	["libnss3-tools"],
	["libnspr4"],
	["libatk-bridge2.0-0", "libatk-bridge2.0-0t64"],
	["libdrm2"],
	["libxkbcommon0"],
	["libatspi2.0-0", "libatspi2.0-0t64"],
	["libcups2", "libcups2t64"],
	["libxshmfence1"],
	["libgbm1"],
	["fonts-noto-color-emoji"],
	["fonts-noto-cjk"],
	["fonts-freefont-ttf"]
];
const DNF_CHROMIUM_DEPENDENCIES = [
	"glib2",
	"nss",
	"nss-tools",
	"nspr",
	"libxkbcommon",
	"atk",
	"at-spi2-atk",
	"at-spi2-core",
	"libXcomposite",
	"libXdamage",
	"libXrandr",
	"libXfixes",
	"libXcursor",
	"libXi",
	"libXtst",
	"libXScrnSaver",
	"libXext",
	"mesa-libgbm",
	"libdrm",
	"mesa-libGL",
	"mesa-libEGL",
	"cups-libs",
	"alsa-lib",
	"pango",
	"cairo",
	"gtk3",
	"dbus-libs"
];
const EVE_BOOTSTRAP_REVISION = "4";
function agentBrowserRevalidationKey(options = {}) {
	return [
		"agent-browser",
		`bootstrap-${EVE_BOOTSTRAP_REVISION}`,
		resolveAgentBrowserInstallSpec$1(options),
		options.installBrowser === false ? "no-browser" : "browser",
		options.installSystemDependencies === false ? "no-system-deps" : "system-deps"
	].join(":");
}
async function installAgentBrowser(sandbox, options = {}) {
	const npmBinary = options.npmBinary ?? "npm";
	const installSpec = resolveAgentBrowserInstallSpec$1(options);
	const commands = [];
	if (options.installSystemDependencies !== false) commands.push(buildLinuxSystemDependenciesCommand());
	commands.push(`${quoteShellArg$1(npmBinary)} install -g ${quoteShellArg$1(installSpec)}`);
	if (options.installBrowser !== false) commands.push(buildShellCommand(["install"], {
		binary: "agent-browser",
		json: false
	}));
	const results = [];
	for (const command of commands) {
		const result = await sandbox.run({
			abortSignal: options.abortSignal,
			command
		});
		results.push(throwIfCommandFailed(createAgentBrowserCommandResult({
			command,
			exitCode: result.exitCode,
			stderr: result.stderr,
			stdout: result.stdout
		})));
	}
	return results;
}
async function runAgentBrowser(ctx, args, options = {}) {
	const sandbox = await ctx.getSandbox();
	if (sandbox === null) throw new Error("agent-browser requires an Eve sandbox. Configure agent/sandbox.ts first.");
	const session = options.session ?? defaultSessionName(options.sessionPrefix ?? "eve", sandbox.id);
	const command = buildAgentBrowserCommand(args, {
		...options,
		session
	});
	const result = await sandbox.run({
		abortSignal: options.abortSignal,
		command
	});
	return throwIfCommandFailed(createAgentBrowserCommandResult({
		command,
		exitCode: result.exitCode,
		stderr: result.stderr,
		stdout: result.stdout
	}));
}
function buildAgentBrowserCommand(args, options = {}) {
	return buildShellCommand(args, options);
}
function buildLinuxSystemDependenciesCommand() {
	const aptPackages = APT_CHROMIUM_DEPENDENCIES.map(formatAptDependency).join(" ");
	const dnfPackages = DNF_CHROMIUM_DEPENDENCIES.map(quoteShellArg$1).join(" ");
	return [
		"if command -v apt-get >/dev/null 2>&1; then",
		`sudo apt-get update && sudo apt-get install -y --no-install-recommends ${aptPackages} && sudo ldconfig;`,
		"elif command -v dnf >/dev/null 2>&1; then",
		`sudo dnf clean all && sudo dnf install -y --skip-broken -- ${dnfPackages} && sudo ldconfig;`,
		"else echo 'No supported package manager found for browser system dependencies.' >&2; exit 1; fi"
	].join(" ");
}
function formatAptDependency([base, t64Variant]) {
	if (t64Variant === void 0) return quoteShellArg$1(base);
	return `$(if apt-cache show ${quoteShellArg$1(t64Variant)} >/dev/null 2>&1; then printf %s ${quoteShellArg$1(t64Variant)}; else printf %s ${quoteShellArg$1(base)}; fi)`;
}
export { AgentBrowserCommandError, DEFAULT_AGENT_BROWSER_INSTALL_SPEC, agentBrowserRevalidationKey, buildAgentBrowserArgv, buildAgentBrowserCommand, installAgentBrowser, quoteShellArg, resolveAgentBrowserInstallSpec, runAgentBrowser };
