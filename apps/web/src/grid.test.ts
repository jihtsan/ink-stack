import { describe, expect, it } from "vitest";
import { moveIfValid, resizeIfValid, validateLayout } from "./grid";
import type { DashboardDraft } from "./types";

function dashboard(): DashboardDraft {
  return {
    schemaVersion: 1,
    id: "main",
    name: "测试看板",
    revision: 0,
    timeZone: "Asia/Shanghai",
    screen: { width: 800, height: 1200 },
    grid: {
      columns: 4,
      rows: 6,
      columnGap: 16,
      rowGap: 16,
      margin: { top: 32, right: 32, bottom: 32, left: 32 }
    },
    theme: {
      background: "#ffffff",
      foreground: "#111111",
      muted: "#666666",
      border: "#222222"
    },
    widgets: [
      {
        id: "date-1",
        type: "date",
        configVersion: 1,
        column: 0,
        row: 0,
        columnSpan: 4,
        rowSpan: 1,
        config: { subtitle: "今天", format: "full", showWeekday: true }
      },
      {
        id: "codex-1",
        type: "codex-usage",
        configVersion: 1,
        column: 0,
        row: 1,
        columnSpan: 2,
        rowSpan: 4,
        config: {
          alias: "工作账号",
          connectionId: "local-codex-app-server",
          connectionRevision: 1,
          quotaGroupId: "codex",
          lowBalanceThreshold: 20
        }
      }
    ]
  };
}

describe("grid layout validation", () => {
  it("accepts touching widgets and the required 2x4 codex widget", () => {
    const subject = dashboard();

    expect(validateLayout(subject)).toEqual([]);
  });

  it("rejects overlap without moving other widgets", () => {
    const subject = dashboard();
    const moved = moveIfValid(subject, "codex-1", 0, 0);

    expect(moved).toBeNull();
    expect(subject.widgets[1]?.row).toBe(1);
  });

  it("rejects out-of-bounds movement", () => {
    const subject = dashboard();

    expect(moveIfValid(subject, "codex-1", 3, 1)).toBeNull();
  });

  it("rejects unsupported codex sizes", () => {
    const subject = dashboard();

    expect(resizeIfValid(subject, "codex-1", { columns: 4, rows: 2 })).toBeNull();
  });
});
