import {
  computePixelRect,
  findFirstAvailablePlacement,
  snapPointerToGrid,
  validateDashboardDraft
} from "@ink-stack/shared";
import {
  minimumPixelSizeByWidgetType,
  supportedSizesByWidgetType,
  validateWidgetInstanceConfig
} from "./catalog";
import type { DashboardDraft, WidgetInstance, WidgetSize } from "./types";

export { computePixelRect, findFirstAvailablePlacement, snapPointerToGrid };

export type LayoutIssue = {
  widgetId: string;
  reason: string;
  message: string;
};

export function canPlace(
  widgets: WidgetInstance[],
  candidate: WidgetInstance,
  dashboard: DashboardDraft,
  ignoreId?: string
): boolean {
  const next = {
    ...dashboard,
    widgets: [...widgets.filter((widget) => widget.id !== ignoreId), candidate]
  };
  return validateLayout(next).length === 0;
}

export function updateWidget(
  dashboard: DashboardDraft,
  widgetId: string,
  update: (widget: WidgetInstance) => WidgetInstance
): DashboardDraft {
  return {
    ...dashboard,
    widgets: dashboard.widgets.map((widget) => (widget.id === widgetId ? update(widget) : widget))
  };
}

export function moveIfValid(
  dashboard: DashboardDraft,
  widgetId: string,
  column: number,
  row: number
): DashboardDraft | null {
  const next = updateWidget(dashboard, widgetId, (widget) => ({ ...widget, column, row }));
  return validateLayout(next).length === 0 ? next : null;
}

export function resizeIfValid(
  dashboard: DashboardDraft,
  widgetId: string,
  size: WidgetSize
): DashboardDraft | null {
  const next = updateWidget(dashboard, widgetId, (widget) => ({
    ...widget,
    columnSpan: size.columns,
    rowSpan: size.rows
  }));
  return validateLayout(next).length === 0 ? next : null;
}

export function replaceDashboardIfValid(dashboard: DashboardDraft): DashboardDraft | null {
  return validateLayout(dashboard).length === 0 ? dashboard : null;
}

export function validateLayout(dashboard: DashboardDraft): LayoutIssue[] {
  const dashboardResult = validateDashboardDraft(dashboard, {
    supportedSizesByType: supportedSizesByWidgetType,
    minimumPixelSizeByType: minimumPixelSizeByWidgetType
  });
  const widgetConfigIssues = dashboard.widgets.flatMap((widget) => {
    const result = validateWidgetInstanceConfig(widget);
    return result.ok
      ? []
      : result.errors.map((error) => ({
          widgetId: widget.id,
          reason: "widget-config",
          message: `${error.path}: ${error.message}`
        }));
  });
  return [
    ...dashboardResult.issues.map((issue) => ({
      widgetId: issue.instanceId ?? "",
      reason: issue.code,
      message: issue.message
    })),
    ...widgetConfigIssues
  ];
}

export function cloneDashboard(dashboard: DashboardDraft): DashboardDraft {
  return structuredClone(dashboard) as DashboardDraft;
}
