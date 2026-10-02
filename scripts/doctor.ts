import { existsSync } from "node:fs";
import { resolve } from "node:path";
export async function doctor() {
  const checks: Record<string, boolean> = {
    node24: false,
    docker: false,
    pythonEnvironment: existsSync(".venv/bin/python"),
  };
  const node = resolve("node_modules/node/bin/node");
  if (existsSync(node)) {
    const version = await new Response(
      Bun.spawn([node, "--version"], { stdout: "pipe", stderr: "ignore" }).stdout,
    ).text();
    checks.node24 = version.trim().startsWith("v24.");
  }
  try {
    const child = Bun.spawn(["docker", "info", "--format", "{{.ServerVersion}}"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    checks.docker = (await child.exited) === 0;
  } catch {}
  return checks;
}
if (import.meta.main) {
  const checks = await doctor();
  for (const [key, value] of Object.entries(checks))
    console.log(`${key}: ${value ? "ready" : "unavailable"}`);
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
}
