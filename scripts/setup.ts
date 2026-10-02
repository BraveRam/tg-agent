import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
const fields = [
  "AI_GATEWAY_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OWNER_ID",
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
] as const;
async function secret(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Interactive setup requires a terminal");
  process.stdout.write(label + ": ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((res, rej) => {
    let value = "";
    const listener = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === "\r" || char === "\n") {
          process.stdin.off("data", listener);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          res(value.trim());
          return;
        }
        if (char === "\u0003") {
          process.stdin.off("data", listener);
          process.stdin.setRawMode(false);
          rej(new Error("Setup cancelled"));
          return;
        }
        if (char === "\u007f") {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        } else if (char >= " ") {
          value += char;
          process.stdout.write("*");
        }
      }
    };
    process.stdin.on("data", listener);
  });
}
export async function setup() {
  const values: Record<string, string> = {};
  for (const key of fields) {
    if (process.env[key]) {
      values[key] = process.env[key]!;
      continue;
    }
    if (!process.stdin.isTTY)
      throw new Error(
        `Missing ${fields.filter((k) => !process.env[k]).join(", ")}. Open a terminal and run bun dev for setup, or populate .env.local.`,
      );
    values[key] = await secret(key);
    if (!values[key]) throw new Error(`${key} is required`);
  }
  if (!/^\d+$/.test(values.TELEGRAM_OWNER_ID) || !/^\d+$/.test(values.TELEGRAM_API_ID))
    throw new Error("Owner ID and API ID must be numeric");
  for (const key of ["TG_INTERNAL_TOKEN", "TELEGRAM_WEBHOOK_SECRET_TOKEN"])
    values[key] = process.env[key] ?? randomBytes(32).toString("hex");
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  const file = resolve(".env.local");
  const old = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !Object.keys(values).some((key) => line.startsWith(key + "=")))
        .join("\n")
    : "";
  writeFileSync(
    file,
    old +
      "\n" +
      Object.entries(values)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join("\n") +
      "\n",
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  const data = resolve(process.env.TG_DATA_DIR ?? ".data");
  process.env.TG_DATA_DIR = data;
  mkdirSync(data, { recursive: true, mode: 0o700 });
  if (!existsSync(resolve(".venv/bin/python")))
    throw new Error(
      "Install the userbot dependencies: uv venv .venv && uv pip sync --python .venv/bin/python userbot/requirements.lock",
    );
  {
    const child = Bun.spawn([resolve(".venv/bin/python"), "userbot/login.py"], {
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0) throw new Error("Userbot login failed");
  }
}
if (import.meta.main) {
  try {
    await setup();
    console.log("Setup complete. Run bun dev.");
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Setup failed");
    process.exitCode = 1;
  }
}
