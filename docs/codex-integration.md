# Codex App Server integration

## 同账号复核（2026-09-05）

本地连接器在 `2026-09-04T16:35:20.185Z` 返回 `status: ok`。与同一时刻 Codex App 的只读额度显示核对：`codex` 分组已用 59%，实际窗口10080分钟，重置 Unix 时间1788748098，三项一致。显示应为剩余41%，不是每周以外的固定假窗口。另一个实际分组 `codex_bengalfox` 的300分钟窗口已用0%、10080分钟窗口已用100%；300分钟重置时间因两次采样相差2秒，其余一致。

此记录是采集时快照，不代表当前余额；测试过程中没有创建模型任务、读取认证文件或消费额度重置。组件 PNG 与管理界面不包含账号ID、邮箱、身份哈希或认证信息。

Status: implemented as a local read-only connector for the server. The current code lives in `apps/server/src/connectors/codex-app-server.ts`; `scripts/probe-codex.mjs` runs the same connector and prints a sanitized JSON snapshot.

## Official interface

InkStack uses the official Codex App Server over local stdio. The connector starts `codex app-server`, sends `initialize`, follows with the `initialized` notification, calls `account/read` to classify the local authentication mode, and then calls `account/rateLimits/read` for the quota snapshot.

Reference: <https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt>

The connector does not call login, logout, reset, task creation, model execution, or any mutation endpoint. It does not read Codex authentication files and it does not accept an OpenAI API key as a substitute for a ChatGPT/Codex login.

## Runtime boundary

The command path is deployment configuration, not dashboard configuration. The default is `codex app-server`; on Windows the resolver accepts only a real `.exe` or `.com` command when running with `shell: false`, so npm `.cmd` and `.bat` wrappers are not used as the service default. If deployment needs a pinned binary path, set `INKSTACK_CODEX_COMMAND` or pass `command` from server configuration.

Returned account identity is reduced to a 16-character SHA-256 prefix. Browser APIs and widget render messages should receive only that hash and the sanitized quota fields. Saved secrets, emails, bearer tokens, API keys, tokenized URLs, stderr content, and raw account responses must not be forwarded to the browser, logs, render worker, PNG, or export files.

## Server API contract

`readCodexLimits()` returns:

```ts
Promise<{
  status:
    | "ok"
    | "codex_not_found"
    | "not_logged_in"
    | "unsupported_auth"
    | "rate_limits_unavailable"
    | "timeout"
    | "protocol_error"
    | "process_error"
    | "response_too_large";
  observedAt: string;
  raw?: {
    rateLimits?: SanitizedBucket | null;
    rateLimitsByLimitId?: Record<string, SanitizedBucket>;
    rateLimitResetCredits?: { availableCount: number | null } | null;
  };
  identity?: string;
  error?: string;
}>
```

Each `SanitizedBucket` keeps only `limitId`, `limitName`, `planType`, `primary`, `secondary`, and `rateLimitReachedType`. Windows keep only `usedPercent`, `windowDurationMins`, and `resetsAt`. The widget-level adapter should normalize these fields into display rows and calculate remaining percentage as `100 - usedPercent` only when `usedPercent` is a valid number.

Concurrent reads with the same configured command, args, timeout, and response-size limit are coalesced into one in-flight request. This lets multiple Codex usage widgets share one same-host quota read.

## Local verification

Environment:

- `codex --version`: `codex-cli 0.134.0`
- project-local Node: `v24.20.0`

Command:

```powershell
.\.tools\node-v24.20.0-win-x64\node.exe scripts/probe-codex.mjs --timeout-ms 15000
```

Sanitized result at `2026-09-04T16:22:19.631Z`:

- `status`: `ok`
- `identity`: `3d3cf81575c38773`
- buckets: `codex`, `codex_bengalfox`
- default bucket: `codex`, plan `prolite`, primary window used `57%`, duration `10080` minutes, reset unix time `1788748098`
- `codex_bengalfox`: primary window used `0%`, duration `300` minutes; secondary window used `100%`, duration `10080` minutes
- reset credits: `availableCount` was `2`

This proves local read-only quota access is available on this machine at the time above. It is not Kindle device validation and it does not prove availability on another host.

## Failure states

- `codex_not_found`: the configured `codex` executable is unavailable.
- `not_logged_in`: App Server reports that ChatGPT authentication is required or the rate-limit call returns an authentication-style error.
- `unsupported_auth`: the active Codex account is API-key or other non-ChatGPT auth that does not expose ChatGPT quota windows.
- `rate_limits_unavailable`: the endpoint responds but does not include usable quota buckets.
- `timeout`: initialize or read did not finish inside the configured timeout.
- `response_too_large`: stdout exceeded the configured byte limit and the connector stopped reading.
- `protocol_error` and `process_error`: malformed JSON-RPC, early exit, spawn failure, or unexpected App Server behavior after sanitization.

When a later refresh fails, the data cache should preserve the last valid `observedAt` and mark it stale instead of replacing real quota data with zeros.
