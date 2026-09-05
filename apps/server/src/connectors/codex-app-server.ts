import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

export type CodexLimitStatus =
  | "ok"
  | "codex_not_found"
  | "not_logged_in"
  | "unsupported_auth"
  | "rate_limits_unavailable"
  | "timeout"
  | "protocol_error"
  | "process_error"
  | "response_too_large";

export type CodexQuotaWindow = {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
};

export type CodexRateLimitBucket = {
  limitId: string;
  limitName: string | null;
  planType?: string | null;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
  rateLimitReachedType: string | null;
};

export type CodexRateLimitsSnapshot = {
  rateLimits?: CodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, CodexRateLimitBucket>;
  rateLimitResetCredits?: {
    availableCount: number | null;
  } | null;
};

export type CodexLimitsResult = {
  status: CodexLimitStatus;
  observedAt: string;
  raw?: CodexRateLimitsSnapshot;
  identity?: string;
  error?: string;
};

export type CodexAppServerOptions = {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  env?: NodeJS.ProcessEnv;
};

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const CLIENT_INFO = {
  name: "ink_stack",
  title: "InkStack",
  version: "0.1.0",
};

const inFlightReads = new Map<string, Promise<CodexLimitsResult>>();

export function readCodexLimits(options: CodexAppServerOptions = {}): Promise<CodexLimitsResult> {
  const key = JSON.stringify({
    command: options.command ?? "codex",
    args: options.args ?? ["app-server"],
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  });

  const active = inFlightReads.get(key);
  if (active) {
    return active;
  }

  const task = readCodexLimitsOnce(options).finally(() => {
    inFlightReads.delete(key);
  });
  inFlightReads.set(key, task);
  return task;
}

async function readCodexLimitsOnce(options: CodexAppServerOptions): Promise<CodexLimitsResult> {
  const observedAt = new Date().toISOString();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const env = options.env ?? process.env;
  const command = resolveCommand(options.command ?? env.INKSTACK_CODEX_COMMAND ?? "codex", env);
  const args = options.args ?? ["app-server"];

  if (!command) {
    return fail("codex_not_found", observedAt, "codex executable was not found on PATH");
  }

  return await withTimeout(timeoutMs, observedAt, async (failFast) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        env: options.env ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      return fail("process_error", observedAt, errorToSafeMessage(error));
    }

    const transport = new JsonRpcLineTransport(child, maxResponseBytes);
    const exitPromise = transport.waitForExit();
    let identity: string | undefined;

    try {
      const initializePromise = transport.waitForResponse(1);
      transport.send({
        method: "initialize",
        id: 1,
        params: { clientInfo: CLIENT_INFO },
      });

      const initialized = await Promise.race([initializePromise, exitPromise, failFast]);
      if (!isJsonRpcResponse(initialized)) {
        return initialized;
      }
      if (initialized.error) {
        return fail("protocol_error", observedAt, sanitizeText(initialized.error.message ?? "initialize failed"));
      }
      transport.send({ method: "initialized", params: {} });

      const account = await request(transport, exitPromise, failFast, 2, "account/read", {
        refreshToken: false,
      });
      if (!isJsonRpcResponse(account)) {
        return account;
      }
      if (account.error) {
        return fail("protocol_error", observedAt, sanitizeText(account.error.message ?? "account/read failed"));
      }

      const accountResult = readObject(account.result);
      const accountInfo = readObject(accountResult.account);
      const hasAccount = accountResult.account !== null && typeof accountResult.account === "object";
      const accountType = typeof accountInfo.type === "string" ? accountInfo.type : null;
      const requiresOpenaiAuth = accountResult.requiresOpenaiAuth === true;

      if (!hasAccount && requiresOpenaiAuth) {
        return fail("not_logged_in", observedAt, "codex chatgpt login is required");
      }
      if (accountType === "apiKey" || accountType === "amazonBedrock" || !accountType) {
        return fail("unsupported_auth", observedAt, accountType ? `${accountType} does not expose ChatGPT limits` : "no Codex account is active");
      }
      identity = hashIdentity(accountInfo);

      const rateLimits = await request(transport, exitPromise, failFast, 3, "account/rateLimits/read");
      if (!isJsonRpcResponse(rateLimits)) {
        return withIdentity(rateLimits, identity);
      }
      if (rateLimits.error) {
        return classifyRateLimitError(observedAt, rateLimits.error.message, identity);
      }

      const raw = sanitizeRateLimits(rateLimits.result);
      if (!raw.rateLimits && !raw.rateLimitsByLimitId) {
        return fail("rate_limits_unavailable", observedAt, "Codex returned no rate limit buckets", identity);
      }

      return {
        status: "ok",
        observedAt,
        raw,
        identity,
      };
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return fail("response_too_large", observedAt, error.message, identity);
      }
      return fail("protocol_error", observedAt, errorToSafeMessage(error), identity);
    } finally {
      transport.close();
    }
  });
}

async function request(
  transport: JsonRpcLineTransport,
  exitPromise: Promise<CodexLimitsResult>,
  failFast: Promise<CodexLimitsResult>,
  id: number,
  method: string,
  params?: unknown,
): Promise<JsonRpcMessage | CodexLimitsResult> {
  const response = transport.waitForResponse(id);
  transport.send(params === undefined ? { method, id } : { method, id, params });
  return await Promise.race([response, exitPromise, failFast]);
}

class ResponseTooLargeError extends Error {}

class JsonRpcLineTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maxResponseBytes: number;
  private readonly pending = new Map<number, (message: JsonRpcMessage | CodexLimitsResult) => void>();
  private readonly stderrChunks: string[] = [];
  private stdoutBuffer = "";
  private stdoutBytes = 0;
  private closed = false;
  private exitResult?: CodexLimitsResult;
  private exitResolve!: (result: CodexLimitsResult) => void;
  private readonly exitPromise: Promise<CodexLimitsResult>;

  constructor(child: ChildProcessWithoutNullStreams, maxResponseBytes: number) {
    this.child = child;
    this.maxResponseBytes = maxResponseBytes;
    this.exitPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      try {
        this.handleStdout(chunk);
      } catch (error) {
        this.fail(error instanceof ResponseTooLargeError ? "response_too_large" : "protocol_error", errorToSafeMessage(error));
      }
    });
    child.stderr.on("data", (chunk: string) => this.stderrChunks.push(sanitizeText(chunk)));
    child.stdin.on("error", (error) => this.fail("process_error", errorToSafeMessage(error)));
    child.on("error", (error) => this.fail("process_error", errorToSafeMessage(error)));
    child.on("exit", (code, signal) => {
      if (this.closed) {
        return;
      }
      const detail = code === 0 ? "app-server exited before replying" : `app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      const stderr = this.stderrChunks.join("").trim();
      this.fail("process_error", stderr ? `${detail}: ${stderr}` : detail);
    });
  }

  send(message: unknown): void {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("app-server stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitForResponse(id: number): Promise<JsonRpcMessage | CodexLimitsResult> {
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  waitForExit(): Promise<CodexLimitsResult> {
    return this.exitPromise;
  }

  close(): void {
    this.closed = true;
    this.pending.clear();
    if (!this.child.killed) {
      this.child.kill();
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (this.stdoutBytes > this.maxResponseBytes) {
      throw new ResponseTooLargeError("Codex app-server response exceeded configured byte limit");
    }

    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line) as JsonRpcMessage;
      if (typeof message.id === "number") {
        const resolve = this.pending.get(message.id);
        if (resolve) {
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    }
  }

  private resolveExit(status: CodexLimitStatus, detail: string): void {
    if (this.exitResult) {
      return;
    }
    this.exitResult = fail(status, new Date().toISOString(), detail);
    this.exitResolve(this.exitResult);
  }

  private fail(status: CodexLimitStatus, detail: string): void {
    this.resolveExit(status, detail);
    const result = this.exitResult;
    if (result) {
      for (const resolve of this.pending.values()) {
        resolve(result);
      }
      this.pending.clear();
    }
    this.close();
  }
}

function withTimeout(
  timeoutMs: number,
  observedAt: string,
  task: (failFast: Promise<CodexLimitsResult>) => Promise<CodexLimitsResult>,
): Promise<CodexLimitsResult> {
  let timer: NodeJS.Timeout | undefined;
  const failFast = new Promise<CodexLimitsResult>((resolve) => {
    timer = setTimeout(() => resolve(fail("timeout", observedAt, "Codex app-server request timed out")), timeoutMs);
  });
  return task(failFast).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function classifyRateLimitError(observedAt: string, message: string | undefined, identity: string | undefined): CodexLimitsResult {
  const safe = sanitizeText(message ?? "account/rateLimits/read failed");
  const lower = safe.toLowerCase();
  if (lower.includes("unauthorized") || lower.includes("login") || lower.includes("auth")) {
    return fail("not_logged_in", observedAt, safe, identity);
  }
  return fail("rate_limits_unavailable", observedAt, safe, identity);
}

function sanitizeRateLimits(value: unknown): CodexRateLimitsSnapshot {
  const root = readObject(value);
  const rateLimits = sanitizeBucket(root.rateLimits);
  const buckets = readObject(root.rateLimitsByLimitId);
  const rateLimitsByLimitId: Record<string, CodexRateLimitBucket> = {};

  for (const [key, bucket] of Object.entries(buckets)) {
    const sanitized = sanitizeBucket(bucket);
    if (sanitized) {
      rateLimitsByLimitId[key] = sanitized;
    }
  }

  const resetCredits = readObject(root.rateLimitResetCredits);
  return {
    ...(rateLimits !== null ? { rateLimits } : {}),
    ...(Object.keys(rateLimitsByLimitId).length > 0 ? { rateLimitsByLimitId } : {}),
    ...(root.rateLimitResetCredits === null
      ? { rateLimitResetCredits: null }
      : resetCredits
        ? {
            rateLimitResetCredits: {
              availableCount: typeof resetCredits.availableCount === "number" ? resetCredits.availableCount : null,
            },
          }
        : {}),
  };
}

function sanitizeBucket(value: unknown): CodexRateLimitBucket | null {
  const bucket = readObject(value);
  const limitId = typeof bucket.limitId === "string" ? bucket.limitId : null;
  if (!limitId) {
    return null;
  }

  return {
    limitId,
    limitName: typeof bucket.limitName === "string" ? bucket.limitName : null,
    planType: typeof bucket.planType === "string" ? bucket.planType : null,
    primary: sanitizeWindow(bucket.primary),
    secondary: sanitizeWindow(bucket.secondary),
    rateLimitReachedType: typeof bucket.rateLimitReachedType === "string" ? bucket.rateLimitReachedType : null,
  };
}

function sanitizeWindow(value: unknown): CodexQuotaWindow | null {
  const window = readObjectOrNull(value);
  if (window === null) {
    return null;
  }
  return {
    ...(typeof window.usedPercent === "number" ? { usedPercent: window.usedPercent } : {}),
    ...(typeof window.windowDurationMins === "number" ? { windowDurationMins: window.windowDurationMins } : {}),
    ...(typeof window.resetsAt === "number" ? { resetsAt: window.resetsAt } : {}),
  };
}

function hashIdentity(account: Record<string, unknown>): string {
  const identitySeed = JSON.stringify({
    type: account.type,
    email: account.email,
    planType: account.planType,
    id: account.id,
  });
  return createHash("sha256").update(identitySeed).digest("hex").slice(0, 16);
}

function readObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readObjectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isJsonRpcResponse(value: JsonRpcMessage | CodexLimitsResult): value is JsonRpcMessage {
  return !("status" in value);
}

function resolveCommand(command: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(command)) {
    return process.platform === "win32" && ![".exe", ".com"].includes(extname(command).toLowerCase()) ? null : command;
  }
  if (/[\\/]/.test(command)) {
    return null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".com"] : [""];
  for (const extension of extensions) {
    for (const directory of pathValue.split(delimiter)) {
      const candidate = join(directory, `${command}${extension}`);
      try {
        if (existsSync(candidate)) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return command;
}

function fail(status: CodexLimitStatus, observedAt: string, detail: string, identity?: string): CodexLimitsResult {
  void detail;
  return { status, observedAt, error: status, ...(identity ? { identity } : {}) };
}

function withIdentity(result: CodexLimitsResult, identity: string | undefined): CodexLimitsResult {
  return identity ? { ...result, identity } : result;
}

function errorToSafeMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeText(error.message);
  }
  return sanitizeText(String(error));
}

export function sanitizeText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
    .replace(/sk-[A-Za-z0-9_-]+/g, "<redacted-token>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted-token>")
    .replace(/([?&](?:token|key|api_key|access_token|refresh_token|id_token|code)=)[^&\s]+/gi, "$1<redacted>")
    .slice(0, 800);
}
