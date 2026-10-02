import { fileURLToPath as __eveFileURLToPath } from "node:url";
import { dirname as __eveDirname } from "node:path";
import { createRequire as __eveCreateRequire } from "node:module";
const __filename = __eveFileURLToPath(import.meta.url);
__eveDirname(__filename);
__eveCreateRequire(import.meta.url);
import { defineExtension } from "eve/extension";
import { z } from "zod";
var extension_default = defineExtension({ config: z.object({
	allowedDomains: z.array(z.string()).optional(),
	autoInstall: z.boolean().default(true),
	binary: z.string().default("agent-browser"),
	caCert: z.string().optional(),
	clearCaCert: z.boolean().default(false),
	contentBoundaries: z.boolean().default(false),
	installBrowser: z.boolean().default(true),
	installSpec: z.string().optional(),
	installSystemDependencies: z.boolean().default(true),
	inlineScreenshots: z.boolean().default(true),
	maxOutputChars: z.number().int().positive().optional(),
	proxy: z.string().optional(),
	session: z.string().optional(),
	sessionPrefix: z.string().default("eve")
}) });
export { extension_default as default };
