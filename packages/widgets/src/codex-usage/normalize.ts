export type CodexUsageState =
  | "fresh"
  | "stale"
  | "missing"
  | "unauthenticated"
  | "unsupported"
  | "exhausted"
  | "error";

export interface RawCodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export interface RawCodexRateLimitBucket {
  limitId: string;
  limitName: string | null;
  planType?: string | null;
  primary?: RawCodexRateLimitWindow | null;
  secondary?: RawCodexRateLimitWindow | null;
  rateLimitReachedType: string | null;
}

export interface RawCodexRateLimitsResponse {
  rateLimits?: RawCodexRateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, RawCodexRateLimitBucket>;
  rateLimitResetCredits?: {
    availableCount: number | null;
  } | null;
}

export type RawCodexLimitStatus =
  | "ok"
  | "codex_not_found"
  | "not_logged_in"
  | "unsupported_auth"
  | "rate_limits_unavailable"
  | "timeout"
  | "protocol_error"
  | "process_error"
  | "response_too_large";

export interface RawCodexLimitsResult {
  status: RawCodexLimitStatus;
  observedAt: string;
  raw?: RawCodexRateLimitsResponse;
  identity?: string;
  error?: string;
}

export interface CodexUsageWindow {
  id: string;
  label: string;
  windowDurationMins?: number;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  resetPending: boolean;
}

export interface CodexUsageSnapshot {
  state: CodexUsageState;
  quotaGroupId: string;
  quotaGroupName: string;
  observedAt: string;
  staleAt?: string;
  accountLabel?: string;
  windows: CodexUsageWindow[];
  message?: string;
}

export interface NormalizeCodexUsageOptions {
  selectedQuotaGroupId?: string;
  observedAt?: string;
  now?: string;
  maxStaleMs?: number;
}

export function normalizeCodexUsageSnapshot(
  input: RawCodexRateLimitsResponse | RawCodexLimitsResult | null | undefined,
  options: NormalizeCodexUsageOptions = {}
): CodexUsageSnapshot {
  const result = isLimitsResult(input) ? input : undefined;
  const raw = result?.raw ?? (isLimitsResult(input) ? undefined : input);
  const observedAt = options.observedAt ?? result?.observedAt;
  if (!observedAt) {
    throw new Error("observedAt is required for Codex usage normalization.");
  }
  const observedMs = Date.parse(observedAt);
  const nowMs = Date.parse(options.now ?? observedAt);
  const clockMs = Number.isFinite(nowMs) ? nowMs : observedMs;

  if (!Number.isFinite(observedMs) || !Number.isFinite(clockMs)) {
    return emptySnapshot("error", options.selectedQuotaGroupId ?? "codex", "额度不可用", observedAt, "Codex 采集时间无效。");
  }

  if (result && result.status !== "ok") {
    return emptySnapshot(statusToState(result.status), options.selectedQuotaGroupId ?? "codex", "额度不可用", observedAt, result.error ?? "Codex 额度读取失败。");
  }
  if (!raw) {
    return emptySnapshot("missing", options.selectedQuotaGroupId ?? "codex", "额度缺失", observedAt, "未读取到 Codex 额度数据。");
  }

  const group = selectQuotaGroup(raw, options.selectedQuotaGroupId);
  if (!group) {
    return emptySnapshot("missing", options.selectedQuotaGroupId ?? "codex", "额度缺失", observedAt, "所选额度分组不存在。");
  }

  const initialWindows = normalizeWindows(group.bucket, clockMs);
  if (initialWindows.length === 0 || initialWindows.every((window) => window.usedPercent === undefined && window.resetAt === undefined && window.windowDurationMins === undefined)) {
    return emptySnapshot("missing", group.bucket.limitId, group.bucket.limitName ?? group.bucket.limitId, observedAt, "额度窗口缺失。");
  }

  const staleAt = options.maxStaleMs && options.maxStaleMs > 0 ? toIsoStringSafe(observedMs + options.maxStaleMs) : undefined;
  const futureObservedAt = observedMs > clockMs;
  const stale = futureObservedAt || (staleAt ? Date.parse(staleAt) <= clockMs : false);
  const windows = stale
    ? initialWindows.map((window) => ({ ...window, usedPercent: undefined, remainingPercent: undefined }))
    : initialWindows;
  const anyKnownZero = windows.some((window) => window.remainingPercent === 0);

  return {
    state: stale ? "stale" : anyKnownZero ? "exhausted" : "fresh",
    quotaGroupId: group.bucket.limitId,
    quotaGroupName: group.bucket.limitName ?? group.bucket.limitId,
    observedAt,
    staleAt,
    windows,
    message: futureObservedAt ? "Codex 采集时间来自未来，需重新采集。" : stale ? "额度数据已过期，需重新采集。" : group.bucket.rateLimitReachedType ? `额度受限：${group.bucket.rateLimitReachedType}` : undefined
  };
}

function selectQuotaGroup(
  raw: RawCodexRateLimitsResponse,
  selectedQuotaGroupId?: string
): { bucket: RawCodexRateLimitBucket } | null {
  const groups = raw.rateLimitsByLimitId;
  if (groups && Object.keys(groups).length > 0) {
    const selectedId = selectedQuotaGroupId ?? "codex";
    const selected = groups[selectedId];
    if (!selected && selectedQuotaGroupId) {
      return null;
    }
    return { bucket: selected ?? groups[Object.keys(groups)[0]!]! };
  }

  if (raw.rateLimits) {
    if (selectedQuotaGroupId && raw.rateLimits.limitId !== selectedQuotaGroupId) {
      return null;
    }
    return { bucket: raw.rateLimits };
  }

  return null;
}

function normalizeWindows(
  bucket: RawCodexRateLimitBucket,
  nowMs: number
): CodexUsageWindow[] {
  const entries = [
    ["primary", bucket.primary] as const,
    ["secondary", bucket.secondary] as const
  ].filter((entry): entry is readonly ["primary" | "secondary", RawCodexRateLimitWindow] => entry[1] !== null && entry[1] !== undefined);

  return entries.map(([id, window]) => {
    const usedPercent = toPercent(window.usedPercent);
    const resetAt = normalizeResetAt(window.resetsAt);
    const duration = typeof window.windowDurationMins === "number" && Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0
      ? window.windowDurationMins
      : undefined;
    return {
      id,
      label: formatWindowLabel(duration),
      windowDurationMins: duration,
      usedPercent,
      remainingPercent: usedPercent === undefined ? undefined : clamp(100 - usedPercent, 0, 100),
      resetAt,
      resetPending: resetAt ? Date.parse(resetAt) <= nowMs : false
    };
  });
}

function normalizeResetAt(value: number | null | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return toIsoStringSafe(millis);
  }
  return undefined;
}

function toIsoStringSafe(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) {
    return undefined;
  }
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function formatWindowLabel(durationMins: number | undefined): string {
  if (durationMins === 300) {
    return "5 小时窗口";
  }
  if (durationMins === 10080) {
    return "7 天窗口";
  }
  if (durationMins && durationMins % 1440 === 0) {
    return `${durationMins / 1440} 天窗口`;
  }
  if (durationMins && durationMins % 60 === 0) {
    return `${durationMins / 60} 小时窗口`;
  }
  if (durationMins) {
    return `${durationMins} 分钟窗口`;
  }
  return "额度窗口";
}

function statusToState(status: RawCodexLimitStatus): CodexUsageState {
  switch (status) {
    case "not_logged_in":
      return "unauthenticated";
    case "unsupported_auth":
      return "unsupported";
    case "rate_limits_unavailable":
      return "missing";
    default:
      return "error";
  }
}

function emptySnapshot(
  state: CodexUsageState,
  quotaGroupId: string,
  quotaGroupName: string,
  observedAt: string,
  message: string
): CodexUsageSnapshot {
  return {
    state,
    quotaGroupId,
    quotaGroupName,
    observedAt,
    windows: [],
    message
  };
}

function isLimitsResult(value: unknown): value is RawCodexLimitsResult {
  return Boolean(value && typeof value === "object" && "status" in value && "observedAt" in value);
}

function toPercent(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 100) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
