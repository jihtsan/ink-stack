import type { GridSpec, ScreenSpec } from "./screen.js";
import { DEFAULT_GRID_SPEC, DEFAULT_SCREEN_SPEC } from "./screen.js";
import type { WidgetDataEnvelope, WidgetInstance } from "./widget.js";

export interface DashboardTheme {
  background: string;
  foreground: string;
  muted: string;
  border: string;
}

export interface DashboardDraft {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  timeZone: string;
  screen: ScreenSpec;
  grid: GridSpec;
  theme: DashboardTheme;
  widgets: WidgetInstance[];
}

export interface DashboardValidationIssue {
  code:
    | "schema"
    | "duplicate-widget-id"
    | "out-of-bounds"
    | "overlap"
    | "unsupported-size"
    | "invalid-grid"
    | "unknown-widget-type"
    | "widget-too-small"
    | "invalid-time-zone";
  message: string;
  instanceId?: string;
  path?: string;
}

export interface DashboardValidationResult {
  ok: boolean;
  issues: DashboardValidationIssue[];
}

export const DEFAULT_DASHBOARD_THEME: DashboardTheme = {
  background: "#ffffff",
  foreground: "#111111",
  muted: "#666666",
  border: "#222222"
};

export interface DashboardRenderInput {
  dashboard: DashboardDraft;
  now: string;
  dataByWidgetId: Record<string, WidgetDataEnvelope>;
  fontFamily: string;
}

export function createDefaultDashboard(overrides: Partial<DashboardDraft> = {}): DashboardDraft {
  return {
    schemaVersion: 1,
    id: "default",
    name: "墨栈",
    revision: 0,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
    screen: { ...DEFAULT_SCREEN_SPEC },
    grid: {
      ...DEFAULT_GRID_SPEC,
      margin: { ...DEFAULT_GRID_SPEC.margin }
    },
    theme: { ...DEFAULT_DASHBOARD_THEME },
    widgets: [],
    ...overrides
  };
}
