import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { readCodexLimits, sanitizeText } from "./codex-app-server.ts";

function writeMockServer(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "inkstack-codex-mock-"));
  const script = join(directory, "mock-app-server.mjs");
  writeFileSync(script, source, "utf8");
  return script;
}

function mockServerSource(handlers: string): string {
  return `
    import readline from "node:readline";
    const rl = readline.createInterface({ input: process.stdin });
    function send(message) {
      process.stdout.write(JSON.stringify(message) + "\\n");
    }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialized") return;
      ${handlers}
    });
  `;
}

test("readCodexLimits returns sanitized ChatGPT rate limit buckets", async () => {
  const script = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") {
        send({ id: message.id, result: { userAgent: "codex-test" } });
      }
      if (message.method === "account/read") {
        send({ id: message.id, result: { account: { type: "chatgpt", email: "person@example.com", planType: "pro" }, requiresOpenaiAuth: true } });
      }
      if (message.method === "account/rateLimits/read") {
        send({ id: message.id, result: {
          rateLimits: {
            limitId: "codex",
            limitName: null,
            planType: "pro",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1788451200, ignored: "drop" },
            secondary: null,
            rateLimitReachedType: null,
            secret: "drop"
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              limitName: "Codex",
              primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1789056000 },
              secondary: null,
              rateLimitReachedType: "hard"
            }
          },
          rateLimitResetCredits: {
            availableCount: 2,
            credits: [{ id: "sensitive-id" }]
          }
        } });
      }
    `),
  );

  const result = await readCodexLimits({
    command: process.execPath,
    args: [script],
    timeoutMs: 2_000,
  });

  assert.equal(result.status, "ok");
  assert.match(result.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(result.identity ?? "", /^[a-f0-9]{16}$/);
  assert.equal(result.raw?.rateLimits?.primary?.usedPercent, 25);
  assert.equal(result.raw?.rateLimits?.secondary, null);
  assert.equal(result.raw?.rateLimitsByLimitId?.codex.primary?.usedPercent, 100);
  assert.equal(result.raw?.rateLimitsByLimitId?.codex.secondary, null);
  assert.equal(result.raw?.rateLimitResetCredits?.availableCount, 2);
  assert.equal(JSON.stringify(result).includes("person@example.com"), false);
  assert.equal(JSON.stringify(result).includes("sensitive-id"), false);
});

test("readCodexLimits sends initialized only after initialize succeeds", async () => {
  const script = writeMockServer(`
    import readline from "node:readline";
    const rl = readline.createInterface({ input: process.stdin });
    let initialized = false;
    let initializeReplied = false;
    function send(message) {
      process.stdout.write(JSON.stringify(message) + "\\n");
    }
    rl.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialized") {
        if (!initializeReplied) process.exit(7);
        initialized = true;
        return;
      }
      if (message.method === "initialize") {
        setTimeout(() => {
          initializeReplied = true;
          send({ id: message.id, result: {} });
        }, 25);
      }
      if (message.method === "account/read") {
        if (!initialized) process.exit(8);
        send({ id: message.id, result: { account: { type: "chatgpt", email: "person@example.com" }, requiresOpenaiAuth: true } });
      }
      if (message.method === "account/rateLimits/read") {
        send({ id: message.id, result: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 1 }, secondary: null, rateLimitReachedType: null } } });
      }
    });
  `);

  const result = await readCodexLimits({
    command: process.execPath,
    args: [script],
    timeoutMs: 2_000,
  });

  assert.equal(result.status, "ok");
});

test("readCodexLimits distinguishes login and unsupported auth states", async () => {
  const loggedOutScript = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "account/read") send({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
    `),
  );

  const loggedOut = await readCodexLimits({
    command: process.execPath,
    args: [loggedOutScript],
    timeoutMs: 2_000,
  });

  assert.equal(loggedOut.status, "not_logged_in");

  const apiKeyScript = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "account/read") send({ id: message.id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } });
    `),
  );

  const apiKey = await readCodexLimits({
    command: process.execPath,
    args: [apiKeyScript],
    timeoutMs: 2_000,
  });

  assert.equal(apiKey.status, "unsupported_auth");
});

test("readCodexLimits attaches identity only after account succeeds", async () => {
  const rateLimitFailureScript = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt", email: "known@example.com" }, requiresOpenaiAuth: true } });
      if (message.method === "account/rateLimits/read") send({ id: message.id, error: { message: "quota backend unavailable secret-token" } });
    `),
  );

  const rateLimitFailure = await readCodexLimits({
    command: process.execPath,
    args: [rateLimitFailureScript],
    timeoutMs: 2_000,
  });

  assert.equal(rateLimitFailure.status, "rate_limits_unavailable");
  assert.match(rateLimitFailure.identity ?? "", /^[a-f0-9]{16}$/);
  assert.equal(rateLimitFailure.error, "rate_limits_unavailable");
  assert.equal(JSON.stringify(rateLimitFailure).includes("known@example.com"), false);
  assert.equal(JSON.stringify(rateLimitFailure).includes("secret-token"), false);

  const accountFailureScript = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "account/read") send({ id: message.id, error: { message: "account secret-token" } });
    `),
  );

  const accountFailure = await readCodexLimits({
    command: process.execPath,
    args: [accountFailureScript],
    timeoutMs: 2_000,
  });

  assert.equal(accountFailure.status, "protocol_error");
  assert.equal(accountFailure.identity, undefined);
  assert.equal(accountFailure.error, "protocol_error");
});

test("readCodexLimits coalesces concurrent reads for the same configured process", async () => {
  const script = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt", email: "merge@example.com" }, requiresOpenaiAuth: true } });
      if (message.method === "account/rateLimits/read") {
        setTimeout(() => send({ id: message.id, result: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 10 }, secondary: null, rateLimitReachedType: null } } }), 25);
      }
    `),
  );

  const options = { command: process.execPath, args: [script], timeoutMs: 2_000 };
  const [first, second] = await Promise.all([readCodexLimits(options), readCodexLimits(options)]);

  assert.equal(first, second);
  assert.equal(first.status, "ok");
});

test("readCodexLimits reports timeout and response size failures safely", async () => {
  const slowScript = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") {
        setTimeout(() => send({ id: message.id, result: {} }), 200);
      }
    `),
  );

  const timeout = await readCodexLimits({
    command: process.execPath,
    args: [slowScript],
    timeoutMs: 20,
  });

  assert.equal(timeout.status, "timeout");

  const noisyScript = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { big: "x".repeat(2048) } }) + "\\n");
      }
    `),
  );

  const tooLarge = await readCodexLimits({
    command: process.execPath,
    args: [noisyScript],
    timeoutMs: 2_000,
    maxResponseBytes: 100,
  });

  assert.equal(tooLarge.status, "response_too_large");
});

test("readCodexLimits never returns upstream error text or stderr secrets", async () => {
  const script = writeMockServer(
    mockServerSource(`
      if (message.method === "initialize") {
        process.stderr.write("secret user person@example.com Bearer abc.def token=https://service.local/path?api_key=secret-value\\n");
        send({ id: message.id, error: { message: "upstream leaked https://example.com/?token=secret abc.def.ghi arbitrary-secret-value" } });
      }
    `),
  );

  const result = await readCodexLimits({
    command: process.execPath,
    args: [script],
    timeoutMs: 2_000,
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "protocol_error");
  assert.equal(result.error, "protocol_error");
  assert.equal(serialized.includes("person@example.com"), false);
  assert.equal(serialized.includes("abc.def"), false);
  assert.equal(serialized.includes("secret-value"), false);
  assert.equal(serialized.includes("arbitrary-secret-value"), false);
  assert.equal(serialized.includes("https://example.com"), false);
});

test("sanitizeText redacts common account and token shapes", () => {
  const sanitized = sanitizeText("user@example.com Bearer abc.def sk-abc123?token=secret&x=1");
  assert.equal(sanitized.includes("user@example.com"), false);
  assert.equal(sanitized.includes("abc.def"), false);
  assert.equal(sanitized.includes("sk-abc123"), false);
  assert.equal(sanitized.includes("token=secret"), false);
});
