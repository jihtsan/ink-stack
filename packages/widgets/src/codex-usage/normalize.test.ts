import { describe, expect, it } from "vitest";
import exhausted from "./fixtures/exhausted.json" with { type: "json" };
import freshMultiGroup from "./fixtures/fresh-multi-group.json" with { type: "json" };
import missing from "./fixtures/missing.json" with { type: "json" };
import stale from "./fixtures/stale.json" with { type: "json" };
import unauthenticated from "./fixtures/unauthenticated.json" with { type: "json" };
import { normalizeCodexUsageSnapshot, type RawCodexLimitsResult } from "./normalize.js";

describe("normalizeCodexUsageSnapshot", () => {
  it("converts used percent to remaining percent without guessing window names", () => {
    const snapshot = normalizeCodexUsageSnapshot(freshMultiGroup.raw, freshMultiGroup.options);
    expect(snapshot.state).toBe("fresh");
    expect(snapshot.quotaGroupId).toBe("codex");
    expect(snapshot.windows.map((window) => window.remainingPercent)).toEqual([75, 41]);
    expect(snapshot.windows.map((window) => window.label)).toEqual(["5 小时窗口", "7 天窗口"]);
  });

  it("keeps real exhaustion distinct from missing data", () => {
    const snapshot = normalizeCodexUsageSnapshot(exhausted.raw, exhausted.options);
    expect(snapshot.state).toBe("exhausted");
    expect(snapshot.windows[0]?.remainingPercent).toBe(0);
  });

  it("does not turn missing values or groups into zero percent", () => {
    const snapshot = normalizeCodexUsageSnapshot(missing.raw, missing.options);
    expect(snapshot.state).toBe("missing");
    expect(snapshot.windows).toHaveLength(0);

    const unknownWindow = normalizeCodexUsageSnapshot(
      {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {},
          secondary: null,
          rateLimitReachedType: null
        }
      },
      { observedAt: "2026-09-05T00:00:00.000Z" }
    );
    expect(unknownWindow.state).toBe("missing");
    expect(unknownWindow.windows).toHaveLength(0);
  });

  it("marks stale data and reset-pending windows without inferring recovery", () => {
    const snapshot = normalizeCodexUsageSnapshot(stale.raw, stale.options);
    expect(snapshot.state).toBe("stale");
    expect(snapshot.windows[0]?.remainingPercent).toBeUndefined();
    expect(snapshot.windows[0]?.resetPending).toBe(true);
  });

  it("classifies login failures separately", () => {
    const snapshot = normalizeCodexUsageSnapshot(unauthenticated as RawCodexLimitsResult);
    expect(snapshot.state).toBe("unauthenticated");
  });

  it("requires a real observedAt from the connector or caller", () => {
    expect(() => normalizeCodexUsageSnapshot({ rateLimits: null })).toThrow("observedAt is required");
  });

  it("filters undefined windows and ignores impossible reset timestamps", () => {
    const snapshot = normalizeCodexUsageSnapshot(
      {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: undefined,
          secondary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Number.MAX_VALUE },
          rateLimitReachedType: null
        }
      },
      { observedAt: "2026-09-05T00:00:00.000Z" }
    );
    expect(snapshot.state).toBe("fresh");
    expect(snapshot.windows).toHaveLength(1);
    expect(snapshot.windows[0]?.remainingPercent).toBe(75);
    expect(snapshot.windows[0]?.resetAt).toBeUndefined();
  });

  it("does not mark invalid or future observedAt snapshots as fresh", () => {
    const invalid = normalizeCodexUsageSnapshot(
      {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1788591600 },
          secondary: null,
          rateLimitReachedType: null
        }
      },
      { observedAt: "not-a-date" }
    );
    expect(invalid.state).toBe("error");
    expect(invalid.windows).toHaveLength(0);

    const future = normalizeCodexUsageSnapshot(
      {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1788591600 },
          secondary: null,
          rateLimitReachedType: null
        }
      },
      {
        observedAt: "2026-09-06T00:00:00.000Z",
        now: "2026-09-05T00:00:00.000Z"
      }
    );
    expect(future.state).toBe("stale");
    expect(future.windows[0]?.remainingPercent).toBeUndefined();
  });
});
