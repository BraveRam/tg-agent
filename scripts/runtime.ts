import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
export function acquireLock(dir: string, pid = process.pid) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "runtime.lock");
  try {
    const fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, String(pid));
    closeSync(fd);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const old = Number(readFileSync(path, "utf8"));
    if (!Number.isInteger(old) || old <= 0)
      throw new Error("Invalid runtime lock; inspect it before removal");
    try {
      process.kill(old, 0);
      throw new Error("tg-agent is already running");
    } catch (error: any) {
      if (error.code !== "ESRCH") throw error;
      unlinkSync(path);
      return acquireLock(dir, pid);
    }
  }
  return () => {
    try {
      if (readFileSync(path, "utf8") === String(pid)) unlinkSync(path);
    } catch {}
  };
}
export function retryDelay(attempt: number) {
  return Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));
}
export async function waitHealthy(
  url: string,
  headers: Record<string, string> = {},
  attempts = 60,
) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Service did not become ready: ${new URL(url).pathname}`);
}
