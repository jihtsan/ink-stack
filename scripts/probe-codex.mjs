#!/usr/bin/env node
import { readCodexLimits } from "../apps/server/src/connectors/codex-app-server.ts";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const next = process.argv[index + 1];
  if (key.startsWith("--") && next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  }
}

const command = args.get("--command");
const timeoutMs = Number(args.get("--timeout-ms") ?? 10_000);
const maxResponseBytes = Number(args.get("--max-response-bytes") ?? 262_144);

const result = await readCodexLimits({
  ...(command ? { command } : {}),
  timeoutMs,
  maxResponseBytes,
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.status === "ok" ? 0 : 2;
