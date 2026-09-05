import { describe, expect, it } from "vitest";
import { DEFAULT_GRID_SPEC, DEFAULT_SCREEN_SPEC } from "./screen.js";
import {
  computePixelRect,
  findFirstAvailablePlacement,
  getOccupiedCells,
  placementsOverlap,
  snapPointerToGrid,
  validateDashboardLayout
} from "./grid.js";
import type { WidgetInstance } from "./widget.js";

const sizes = new Map([
  ["text", [{ columns: 2, rows: 1 }, { columns: 4, rows: 1 }, { columns: 2, rows: 2 }, { columns: 4, rows: 2 }]],
  ["date", [{ columns: 2, rows: 1 }, { columns: 4, rows: 1 }, { columns: 2, rows: 2 }]],
  ["todo", [{ columns: 2, rows: 2 }, { columns: 2, rows: 4 }, { columns: 4, rows: 2 }, { columns: 4, rows: 3 }]],
  ["codex-usage", [{ columns: 2, rows: 4 }]]
]);

function widget(id: string, type: string, column: number, row: number, columnSpan: number, rowSpan: number): WidgetInstance {
  return {
    id,
    type,
    configVersion: 1,
    config: {},
    column,
    row,
    columnSpan,
    rowSpan
  };
}

describe("grid validation", () => {
  it("allows edge-touching widgets and rejects overlaps", () => {
    const ok = validateDashboardLayout(
      DEFAULT_SCREEN_SPEC,
      DEFAULT_GRID_SPEC,
      [widget("date", "date", 0, 0, 4, 1), widget("todo", "todo", 0, 1, 2, 4), widget("codex", "codex-usage", 2, 1, 2, 4)],
      { supportedSizesByType: sizes }
    );
    expect(ok.ok).toBe(true);

    const overlap = validateDashboardLayout(
      DEFAULT_SCREEN_SPEC,
      DEFAULT_GRID_SPEC,
      [widget("a", "text", 0, 0, 2, 1), widget("b", "text", 1, 0, 2, 1)],
      { supportedSizesByType: sizes }
    );
    expect(overlap.ok).toBe(false);
    expect(overlap.issues.some((issue) => issue.code === "overlap")).toBe(true);
  });

  it("rejects out-of-bounds and unsupported codex usage size", () => {
    const result = validateDashboardLayout(
      DEFAULT_SCREEN_SPEC,
      DEFAULT_GRID_SPEC,
      [widget("wide", "todo", 3, 0, 2, 2), widget("bad-codex", "codex-usage", 0, 1, 4, 2)],
      { supportedSizesByType: sizes }
    );
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("out-of-bounds");
    expect(result.issues.map((issue) => issue.code)).toContain("unsupported-size");
  });

  it("uses boundary rounding so the last span reaches the right and bottom margins", () => {
    const screen = { width: 601, height: 799 };
    const rect = computePixelRect(screen, DEFAULT_GRID_SPEC, { column: 0, row: 0, columnSpan: 4, rowSpan: 6 });
    expect(rect.x).toBe(DEFAULT_GRID_SPEC.margin.left);
    expect(rect.y).toBe(DEFAULT_GRID_SPEC.margin.top);
    expect(rect.x + rect.width).toBe(screen.width - DEFAULT_GRID_SPEC.margin.right);
    expect(rect.y + rect.height).toBe(screen.height - DEFAULT_GRID_SPEC.margin.bottom);
  });

  it("snaps pointers and finds the first available top-left placement", () => {
    expect(snapPointerToGrid(DEFAULT_SCREEN_SPEC, DEFAULT_GRID_SPEC, { x: 599, y: 799 }, { columns: 2, rows: 2 })).toEqual({
      column: 2,
      row: 4
    });
    expect(findFirstAvailablePlacement(DEFAULT_GRID_SPEC, [widget("top", "date", 0, 0, 4, 1)], { columns: 2, rows: 4 })).toEqual({
      column: 0,
      row: 1,
      columnSpan: 2,
      rowSpan: 4
    });
  });

  it("enumerates occupied cells for editor conflict hints", () => {
    const cells = getOccupiedCells([widget("a", "todo", 1, 2, 2, 2)]);
    expect(cells).toEqual(new Set(["1:2", "2:2", "1:3", "2:3"]));
    expect(placementsOverlap({ column: 0, row: 0, columnSpan: 1, rowSpan: 1 }, { column: 1, row: 0, columnSpan: 1, rowSpan: 1 })).toBe(false);
  });
});
