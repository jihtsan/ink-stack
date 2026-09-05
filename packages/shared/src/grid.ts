import type { DashboardValidationIssue, DashboardValidationResult } from "./dashboard.js";
import {
  MAX_GRID_SPACING_PX,
  MAX_GRID_TRACKS,
  MAX_SCREEN_EDGE_PX,
  MIN_WIDGET_PIXEL_HEIGHT,
  MIN_WIDGET_PIXEL_WIDTH,
  type GridSpec,
  type ScreenSpec
} from "./screen.js";
import type { WidgetInstance, WidgetMinimumPixelSize, WidgetPlacement, WidgetRenderRect, WidgetSize } from "./widget.js";

export interface GridValidationOptions {
  supportedSizesByType?: ReadonlyMap<string, readonly WidgetSize[]> | Record<string, readonly WidgetSize[]>;
  minimumPixelSizeByType?: ReadonlyMap<string, WidgetMinimumPixelSize> | Record<string, WidgetMinimumPixelSize>;
  allowUnknownTypes?: boolean;
}

export interface GridPoint {
  column: number;
  row: number;
}

export function sameWidgetSize(a: WidgetSize, b: WidgetSize): boolean {
  return a.columns === b.columns && a.rows === b.rows;
}

export function placementToSize(placement: WidgetPlacement): WidgetSize {
  return {
    columns: placement.columnSpan,
    rows: placement.rowSpan
  };
}

export function validateGridSpec(screen: ScreenSpec, grid: GridSpec): DashboardValidationIssue[] {
  const issues: DashboardValidationIssue[] = [];
  const usableWidth = screen.width - grid.margin.left - grid.margin.right - (grid.columns - 1) * grid.columnGap;
  const usableHeight = screen.height - grid.margin.top - grid.margin.bottom - (grid.rows - 1) * grid.rowGap;

  if (!isPositiveInteger(screen.width) || !isPositiveInteger(screen.height)) {
    issues.push({ code: "invalid-grid", message: "Screen width and height must be positive integers." });
  }
  if (screen.width > MAX_SCREEN_EDGE_PX || screen.height > MAX_SCREEN_EDGE_PX) {
    issues.push({ code: "invalid-grid", message: `Screen width and height must be no more than ${MAX_SCREEN_EDGE_PX}px.` });
  }
  if (!isPositiveInteger(grid.columns) || !isPositiveInteger(grid.rows)) {
    issues.push({ code: "invalid-grid", message: "Grid columns and rows must be positive integers." });
  }
  if (grid.columns > MAX_GRID_TRACKS || grid.rows > MAX_GRID_TRACKS) {
    issues.push({ code: "invalid-grid", message: `Grid columns and rows must be no more than ${MAX_GRID_TRACKS}.` });
  }
  for (const [name, value] of Object.entries(grid.margin)) {
    if (!isNonNegativeInteger(value)) {
      issues.push({ code: "invalid-grid", message: `Grid margin ${name} must be a non-negative integer.` });
    } else if (value > MAX_GRID_SPACING_PX) {
      issues.push({ code: "invalid-grid", message: `Grid margin ${name} must be no more than ${MAX_GRID_SPACING_PX}px.` });
    }
  }
  if (!isNonNegativeInteger(grid.columnGap) || !isNonNegativeInteger(grid.rowGap)) {
    issues.push({ code: "invalid-grid", message: "Grid gaps must be non-negative integers." });
  } else if (grid.columnGap > MAX_GRID_SPACING_PX || grid.rowGap > MAX_GRID_SPACING_PX) {
    issues.push({ code: "invalid-grid", message: `Grid gaps must be no more than ${MAX_GRID_SPACING_PX}px.` });
  }
  if (usableWidth <= 0 || usableHeight <= 0) {
    issues.push({ code: "invalid-grid", message: "Grid usable pixel area must be positive." });
  }

  return issues;
}

export function computePixelRect(screen: ScreenSpec, grid: GridSpec, placement: WidgetPlacement): WidgetRenderRect {
  const horizontal = computeAxisRect(
    screen.width,
    grid.margin.left,
    grid.margin.right,
    grid.columnGap,
    grid.columns,
    placement.column,
    placement.columnSpan
  );
  const vertical = computeAxisRect(
    screen.height,
    grid.margin.top,
    grid.margin.bottom,
    grid.rowGap,
    grid.rows,
    placement.row,
    placement.rowSpan
  );

  return {
    x: horizontal.start,
    y: vertical.start,
    width: horizontal.size,
    height: vertical.size
  };
}

export function snapPointerToGrid(
  screen: ScreenSpec,
  grid: GridSpec,
  pointer: { x: number; y: number },
  span: WidgetSize
): GridPoint {
  const column = snapAxis(pointer.x, screen.width, grid.margin.left, grid.margin.right, grid.columnGap, grid.columns, span.columns);
  const row = snapAxis(pointer.y, screen.height, grid.margin.top, grid.margin.bottom, grid.rowGap, grid.rows, span.rows);
  return { column, row };
}

export function validateDashboardLayout(
  screen: ScreenSpec,
  grid: GridSpec,
  widgets: readonly WidgetInstance[],
  options: GridValidationOptions = {}
): DashboardValidationResult {
  const issues = validateGridSpec(screen, grid);
  const seenIds = new Set<string>();

  for (let index = 0; index < widgets.length; index += 1) {
    const widget = widgets[index]!;
    const instanceId = widget.id;

    if (seenIds.has(instanceId)) {
      issues.push({ code: "duplicate-widget-id", instanceId, message: `Widget id ${instanceId} is duplicated.` });
    }
    seenIds.add(instanceId);

    if (!isPlacementInsideGrid(grid, widget)) {
      issues.push({ code: "out-of-bounds", instanceId, message: `Widget ${instanceId} is outside the grid.` });
    } else {
      const rect = computePixelRect(screen, grid, widget);
      const minimum = getMinimumPixelSize(widget.type, options.minimumPixelSizeByType);
      if (rect.width < minimum.width || rect.height < minimum.height) {
        issues.push({
          code: "widget-too-small",
          instanceId,
          message: `Widget ${instanceId} is smaller than ${minimum.width}x${minimum.height}px.`
        });
      }
    }

    const supportedSizes = getSupportedSizes(widget.type, options.supportedSizesByType);
    if (!supportedSizes && options.allowUnknownTypes !== true) {
      issues.push({ code: "unknown-widget-type", instanceId, message: `Widget type ${widget.type} is not registered.` });
    } else if (supportedSizes && !isSupportedSize(widget, supportedSizes)) {
      issues.push({ code: "unsupported-size", instanceId, message: `Widget ${instanceId} uses an unsupported size.` });
    }
  }

  for (let leftIndex = 0; leftIndex < widgets.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < widgets.length; rightIndex += 1) {
      const left = widgets[leftIndex]!;
      const right = widgets[rightIndex]!;
      if (placementsOverlap(left, right)) {
        issues.push({
          code: "overlap",
          instanceId: left.id,
          message: `Widget ${left.id} overlaps ${right.id}.`
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function isPlacementInsideGrid(grid: GridSpec, placement: WidgetPlacement): boolean {
  return (
    isNonNegativeInteger(placement.column) &&
    isNonNegativeInteger(placement.row) &&
    isPositiveInteger(placement.columnSpan) &&
    isPositiveInteger(placement.rowSpan) &&
    placement.column + placement.columnSpan <= grid.columns &&
    placement.row + placement.rowSpan <= grid.rows
  );
}

export function placementsOverlap(left: WidgetPlacement, right: WidgetPlacement): boolean {
  return !(
    left.column + left.columnSpan <= right.column ||
    right.column + right.columnSpan <= left.column ||
    left.row + left.rowSpan <= right.row ||
    right.row + right.rowSpan <= left.row
  );
}

export function isSupportedSize(placement: WidgetPlacement, supportedSizes: readonly WidgetSize[]): boolean {
  return supportedSizes.some((size) => size.columns === placement.columnSpan && size.rows === placement.rowSpan);
}

export function findFirstAvailablePlacement(
  grid: GridSpec,
  existingWidgets: readonly WidgetInstance[],
  size: WidgetSize
): WidgetPlacement | null {
  for (let row = 0; row <= grid.rows - size.rows; row += 1) {
    for (let column = 0; column <= grid.columns - size.columns; column += 1) {
      const candidate = {
        column,
        row,
        columnSpan: size.columns,
        rowSpan: size.rows
      };
      if (!existingWidgets.some((widget) => placementsOverlap(widget, candidate))) {
        return candidate;
      }
    }
  }
  return null;
}

export function getOccupiedCells(widgets: readonly WidgetPlacement[]): Set<string> {
  const cells = new Set<string>();
  for (const widget of widgets) {
    for (let row = widget.row; row < widget.row + widget.rowSpan; row += 1) {
      for (let column = widget.column; column < widget.column + widget.columnSpan; column += 1) {
        cells.add(`${column}:${row}`);
      }
    }
  }
  return cells;
}

function computeAxisRect(
  total: number,
  startMargin: number,
  endMargin: number,
  gap: number,
  tracks: number,
  trackStart: number,
  span: number
): { start: number; size: number } {
  const usable = total - startMargin - endMargin - (tracks - 1) * gap;
  if (usable <= 0) {
    throw new RangeError("Grid usable pixel area must be positive.");
  }
  const start = startMargin + Math.floor((trackStart * usable) / tracks) + trackStart * gap;
  const end = startMargin + Math.floor(((trackStart + span) * usable) / tracks) + (trackStart + span - 1) * gap;
  return {
    start,
    size: end - start
  };
}

function snapAxis(
  coordinate: number,
  total: number,
  startMargin: number,
  endMargin: number,
  gap: number,
  tracks: number,
  span: number
): number {
  const usable = total - startMargin - endMargin - (tracks - 1) * gap;
  const clamped = clamp(coordinate, startMargin, total - endMargin);
  let bestTrack = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let track = 0; track <= tracks - span; track += 1) {
    const start = startMargin + Math.floor((track * usable) / tracks) + track * gap;
    const distance = Math.abs(clamped - start);
    if (distance < bestDistance) {
      bestTrack = track;
      bestDistance = distance;
    }
  }

  return bestTrack;
}

function getSupportedSizes(
  type: string,
  supportedSizesByType?: ReadonlyMap<string, readonly WidgetSize[]> | Record<string, readonly WidgetSize[]>
): readonly WidgetSize[] | undefined {
  if (!supportedSizesByType) {
    return undefined;
  }
  if (supportedSizesByType instanceof Map) {
    return supportedSizesByType.get(type);
  }
  return (supportedSizesByType as Record<string, readonly WidgetSize[]>)[type];
}

function getMinimumPixelSize(
  type: string,
  minimumPixelSizeByType?: ReadonlyMap<string, WidgetMinimumPixelSize> | Record<string, WidgetMinimumPixelSize>
): WidgetMinimumPixelSize {
  if (!minimumPixelSizeByType) {
    return { width: MIN_WIDGET_PIXEL_WIDTH, height: MIN_WIDGET_PIXEL_HEIGHT };
  }
  if (minimumPixelSizeByType instanceof Map) {
    return minimumPixelSizeByType.get(type) ?? { width: MIN_WIDGET_PIXEL_WIDTH, height: MIN_WIDGET_PIXEL_HEIGHT };
  }
  return (minimumPixelSizeByType as Record<string, WidgetMinimumPixelSize>)[type] ?? {
    width: MIN_WIDGET_PIXEL_WIDTH,
    height: MIN_WIDGET_PIXEL_HEIGHT
  };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
