import { describe, expect, it } from "vitest";
import {
  createDefaultDashboard,
  DEFAULT_GRID_SPEC,
  DEFAULT_SCREEN_SPEC,
  validateDashboard,
  validateDashboardDraft
} from "./index.js";

describe("dashboard validation", () => {
  it("creates a valid empty default dashboard", () => {
    const dashboard = createDefaultDashboard();
    expect(dashboard.screen).toEqual(DEFAULT_SCREEN_SPEC);
    expect(dashboard.grid).toEqual(DEFAULT_GRID_SPEC);
    expect(validateDashboard(dashboard).ok).toBe(true);
  });

  it("rejects unsafe dashboard shape, invalid colors, and bad time zones", () => {
    const dashboard = {
      ...createDefaultDashboard(),
      timeZone: "Mars/Olympus",
      theme: {
        background: "url(http://example.invalid)",
        foreground: "#111111",
        muted: "#666666",
        border: "#222222"
      },
      metadata: {
        secret: "must-not-pass"
      }
    };
    const result = validateDashboardDraft(dashboard);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "schema" && (issue.path ?? "").includes("/theme/background"))).toBe(true);
    expect(result.issues.some((issue) => issue.code === "schema" && issue.message.includes("additional"))).toBe(true);
  });

  it("rejects overlarge screens and widgets with too small a rendered area", () => {
    const overlarge = validateDashboardDraft({ ...createDefaultDashboard(), screen: { width: 3000, height: 800 } });
    expect(overlarge.ok).toBe(false);

    const tinyDashboard = createDefaultDashboard({
        screen: { width: 120, height: 120 },
        grid: {
          columns: 4,
          rows: 6,
          columnGap: 2,
          rowGap: 2,
          margin: { top: 2, right: 2, bottom: 2, left: 2 }
        },
        widgets: [
          {
            id: "small",
            type: "text",
            configVersion: 1,
            config: {},
            column: 0,
            row: 0,
            columnSpan: 2,
            rowSpan: 1
          }
        ]
      });
    const tiny = validateDashboardDraft(tinyDashboard, { supportedSizesByType: { text: [{ columns: 2, rows: 1 }] } });
    expect(tiny.ok).toBe(false);
    expect(tiny.issues.some((issue) => issue.code === "widget-too-small")).toBe(true);
  });

  it("enforces schema resource bounds for dashboard and grid fields", () => {
    const result = validateDashboardDraft({
      ...createDefaultDashboard(),
      id: "d".repeat(121),
      name: "n".repeat(81),
      timeZone: "A".repeat(101),
      grid: {
        columns: 25,
        rows: 25,
        columnGap: 1025,
        rowGap: 1025,
        margin: {
          top: 1025,
          right: 1025,
          bottom: 1025,
          left: 1025
        }
      },
      widgets: []
    });
    expect(result.ok).toBe(false);
    expect(result.issues.filter((issue) => issue.code === "schema").length).toBeGreaterThanOrEqual(8);
  });

  it("limits widget count and widget id/type lengths", () => {
    const tooManyWidgets = Array.from({ length: 129 }, (_, index) => ({
      id: `w-${index}`,
      type: "text",
      configVersion: 1,
      config: {},
      column: 0,
      row: 0,
      columnSpan: 1,
      rowSpan: 1
    }));
    expect(validateDashboardDraft({ ...createDefaultDashboard(), widgets: tooManyWidgets }).ok).toBe(false);
    expect(validateDashboardDraft({
      ...createDefaultDashboard(),
      widgets: [
        {
          id: "w".repeat(121),
          type: "t".repeat(121),
          configVersion: 1,
          config: {},
          column: 0,
          row: 0,
          columnSpan: 1,
          rowSpan: 1
        }
      ]
    }).ok).toBe(false);
  });

  it("accepts component-specific minimum pixel sizes", () => {
    const dashboard = createDefaultDashboard({
      widgets: [
        {
          id: "codex",
          type: "codex-usage",
          configVersion: 1,
          config: {},
          column: 0,
          row: 0,
          columnSpan: 2,
          rowSpan: 4
        }
      ]
    });
    expect(validateDashboardDraft(dashboard, {
      supportedSizesByType: { "codex-usage": [{ columns: 2, rows: 4 }] },
      minimumPixelSizeByType: { "codex-usage": { width: 220, height: 330 } }
    }).ok).toBe(true);

    const small = validateDashboardDraft({ ...dashboard, screen: { width: 320, height: 500 } }, {
      supportedSizesByType: { "codex-usage": [{ columns: 2, rows: 4 }] },
      minimumPixelSizeByType: { "codex-usage": { width: 220, height: 330 } }
    });
    expect(small.ok).toBe(false);
    expect(small.issues.some((issue) => issue.code === "widget-too-small")).toBe(true);
  });
});
