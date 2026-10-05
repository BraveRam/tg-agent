import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

import { setup } from "./setup";
import { doctor } from "./doctor";
import { acquireLock, waitHealthy, retryDelay, nodeNetworkOptions } from "./runtime";

const data = resolve(process.env.TG_DATA_DIR ?? ".data");

const release = acquireLock(data);

let stopping = false;

const children = new Set<ReturnType<typeof Bun.spawn>>();

function services(name: string, state: string) {
  writeFileSync(resolve(data, `${name}.health.json`), JSON.stringify({ state, at: Date.now() }), {
    mode: 0o600,
  });
}

async function stop(code = 0) {
  if (stopping) return;

  stopping = true;

  for (const child of children) child.kill("SIGTERM");

  await Promise.race([Promise.all([...children].map((c) => c.exited)), Bun.sleep(5000)]);

  for (const child of children)
    try {
      child.kill("SIGKILL");
    } catch {}

  release();
  process.exit(code);
}

process.on("SIGINT", () => void stop());

process.on("SIGTERM", () => void stop());

async function supervise(name: string, args: string[], fatal = false) {
  let failures = 0;

  while (!stopping) {
    services(name, "starting");

    const child = Bun.spawn(args, {
      env: process.env,
      stdin: name === "eve" ? "inherit" : "ignore",
      stdout: name === "eve" ? "inherit" : "ignore",
      stderr: "inherit",
    });

    children.add(child);
    services(name, "running");

    const started = Date.now();
    const code = await child.exited;

    children.delete(child);

    if (stopping) return;

    services(name, "degraded");
    console.error(`${name} exited (${code}); ${fatal ? "stopping app" : "retrying"}.`);

    if (fatal) {
      await stop(code || 1);

      return;
    }

    failures = Date.now() - started > 60000 ? 0 : failures + 1;
    await Bun.sleep(retryDelay(failures));
  }
}

try {
  process.env.TG_DATA_DIR = data;

  const prerequisites = await doctor();

  if (!prerequisites.node24)
    throw new Error("Project-local Node 24 missing. Run bun install and bun pm trust node.");

  if (!prerequisites.pythonEnvironment)
    throw new Error(
      "Userbot dependencies missing. Run uv venv .venv and uv pip sync --python .venv/bin/python userbot/requirements.lock.",
    );

  if (!prerequisites.docker)
    throw new Error(
      "Docker is unavailable. Start Docker and ensure your desktop user can access it.",
    );

  await setup();

  process.env.NODE_OPTIONS = nodeNetworkOptions(process.env.NODE_OPTIONS);

  const node = resolve("node_modules/node/bin/node");
  const port = process.env.TG_PORT ?? "2000";
  const workerPort = process.env.TG_USERBOT_PORT ?? "2001";

  process.env.PATH = resolve("node_modules/node/bin") + ":" + process.env.PATH;
  void supervise(
    "eve",
    [
      node,
      "node_modules/eve/bin/eve.js",
      "dev",
      "--no-default-extensions",
      "--no-ui",
      "--resume",
      "--host",
      "127.0.0.1",
      "--port",
      port,
    ],
    true,
  );
  await waitHealthy(`http://127.0.0.1:${port}/eve/v1/health`);
  void supervise("userbot", [
    resolve(".venv/bin/python"),
    "-m",
    "uvicorn",
    "userbot.app:app",
    "--host",
    "127.0.0.1",
    "--port",
    workerPort,
    "--log-level",
    "warning",
    "--no-access-log",
  ]);
  await waitHealthy(`http://127.0.0.1:${workerPort}/health`, {
    authorization: `Bearer ${process.env.TG_INTERNAL_TOKEN}`,
  });
  void supervise("coordinator", [node, "--import", "tsx", "scripts/coordinator.ts"]);
  console.log(
    "tg-agent ready. Talk to your bot in a private Telegram chat. Ctrl+C stops everything.",
  );

  while (!stopping) await Bun.sleep(1000);
} catch (e) {
  console.error(e instanceof Error ? e.message : "Startup failed");
  await stop(1);
}
