import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDefaultDashboard } from "@ink-stack/shared";
import { renderDateWidget, renderTextWidget, renderTodoWidget } from "@ink-stack/widgets/render";
import { WidgetCanvas, type DragState, type LibraryDropState } from "./WidgetCanvas";
import { computePixelRect } from "./grid";
import type { DashboardDraft, DateConfig, TextConfig, TodoConfig, WidgetInstance } from "./types";

const NOW = "2026-09-05T00:00:00.000Z";

function buildWidget(type: string, config: WidgetInstance["config"], placement: Partial<WidgetInstance> = {}): WidgetInstance {
  return {
    id: "example",
    type,
    configVersion: 1,
    column: 0,
    row: 0,
    columnSpan: 2,
    rowSpan: 2,
    config,
    ...placement
  };
}

function buildDashboard(widget: WidgetInstance, overrides: Partial<DashboardDraft> = {}) {
  const dashboard = createDefaultDashboard();
  dashboard.widgets = [widget];
  return { ...dashboard, ...overrides, widgets: [widget] };
}

function renderDashboard(dashboard: DashboardDraft, options: { previewImageUrl?: string; drag?: DragState; libraryDrop?: LibraryDropState } = {}) {
  const noop = () => {};
  return renderToStaticMarkup(
    <WidgetCanvas
      dashboard={dashboard}
      selectedId={null}
      layoutIssues={[]}
      drag={options.drag ?? null}
      libraryDrop={options.libraryDrop ?? null}
      canvasRef={{ current: null }}
      onSelect={noop}
      onPointerDown={noop}
      onPointerMove={noop}
      onPointerUp={noop}
      onPointerCancel={noop}
      onDragOver={noop}
      onDragLeave={noop}
      onDrop={noop}
      {...(options.previewImageUrl ? { previewImageUrl: options.previewImageUrl } : {})}
    />
  );
}

function renderWidget(type: string, config: WidgetInstance["config"], previewImageUrl?: string) {
  return renderDashboard(buildDashboard(buildWidget(type, config)), previewImageUrl ? { previewImageUrl } : {});
}

function extractSvgBody(html: string) {
  const match = html.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>/);
  expect(match).not.toBeNull();
  return match![1];
}

function renderExpectedBody(dashboard: DashboardDraft, widget: WidgetInstance) {
  const context = {
    rect: computePixelRect(dashboard.screen, dashboard.grid, widget),
    screen: dashboard.screen,
    timeZone: dashboard.timeZone,
    now: NOW
  };
  switch (widget.type) {
    case "text":
      return renderTextWidget({ instance: { ...widget, config: widget.config as TextConfig }, context });
    case "date":
      return renderDateWidget({ instance: { ...widget, config: widget.config as DateConfig }, context });
    case "todo":
      return renderTodoWidget({ instance: { ...widget, config: widget.config as TodoConfig }, context });
    default:
      throw new Error(`Unexpected widget type ${widget.type}`);
  }
}

function percent(value: number) {
  return `${value * 100}%`;
}

afterEach(() => vi.useRealTimers());

describe("widget editor presentation", () => {
  it("renders text with the same SVG body as the PNG renderer and escapes config strings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const widget = buildWidget("text", {
      title: "<提醒>",
      text: "<script>hello</script>",
      size: "large",
      align: "right",
      showBorder: false,
      showBackground: false
    });
    const dashboard = buildDashboard(widget);
    const body = extractSvgBody(renderDashboard(dashboard));

    expect(body).toBe(renderExpectedBody(dashboard, widget));
    expect(body).toContain("&lt;提醒&gt;");
    expect(body).toContain("text-anchor=\"end\"");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<rect");
  });

  it("sorts open tasks first without changing the saved order and counts hidden items", () => {
    const items = [{ id: "a", text: "已完成事项", done: true }, { id: "b", text: "待处理事项", done: false }];
    const widget = buildWidget("todo", { title: "今天", items, sort: "open-first", maxVisible: 1 });
    const dashboard = buildDashboard(widget);
    const body = extractSvgBody(renderDashboard(dashboard));

    expect(body).toBe(renderExpectedBody(dashboard, widget));
    expect(body).toContain("待处理事项");
    expect(body).not.toContain(">已完成事项</text>");
    expect(body).toContain("1/2");
    expect(body).toContain("还有 1 项");
    expect(items[0]?.id).toBe("a");
  });

  it("shows a helpful empty state for an empty task list", () => {
    const widget = buildWidget("todo", { title: "待办", items: [], sort: "manual", maxVisible: 3 });
    const dashboard = buildDashboard(widget);
    const body = extractSvgBody(renderDashboard(dashboard));

    expect(body).toBe(renderExpectedBody(dashboard, widget));
    expect(body).toContain("暂无待办");
  });

  it("uses Chinese short dates and hides weekday when requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const widget = buildWidget("date", { subtitle: "今天", format: "short", showWeekday: false });
    const dashboard = buildDashboard(widget);
    const body = extractSvgBody(renderDashboard(dashboard));

    expect(body).toBe(renderExpectedBody(dashboard, widget));
    expect(body).toContain("9月5日");
    expect(body).not.toContain("2026");
    expect(body).not.toContain("星期");
  });

  it("uses server PNG crops for every widget type when a current preview is supplied", () => {
    const configs: Array<[string, WidgetInstance["config"], string]> = [
      ["text", { title: "", text: "一段文字", size: "medium", align: "left", showBorder: true, showBackground: true }, "文字的服务端预览"],
      ["date", { subtitle: "今天", format: "full", showWeekday: true }, "日期的服务端预览"],
      ["todo", { title: "待办", items: [], sort: "manual", maxVisible: 3 }, "待办的服务端预览"],
      ["codex-usage", { alias: "工作", connectionId: "local", connectionRevision: 1, quotaGroupId: "codex", lowBalanceThreshold: 20 }, "Codex 额度的服务端预览"]
    ];

    for (const [type, config, alt] of configs) {
      const html = renderWidget(type, config, "/api/previews/current.png");
      expect(html).toContain('src="/api/previews/current.png"');
      expect(html).toContain(`alt="${alt}"`);
      expect(html).not.toContain("widget-svg");
      expect(html).not.toContain("生成预览以查看额度");
    }
  });

  it("keeps the PNG crop sourced from the original rect while a dragged card moves", () => {
    const widget = buildWidget(
      "text",
      { title: "", text: "拖动中", size: "medium", align: "left", showBorder: true, showBackground: true },
      { column: 1, row: 2, columnSpan: 2, rowSpan: 3 }
    );
    const dashboard = buildDashboard(widget, {
      screen: { width: 1072, height: 1448 },
      grid: { columns: 4, rows: 6, columnGap: 12, rowGap: 12, margin: { top: 24, right: 24, bottom: 24, left: 24 } }
    });
    const drag = { widgetId: "example", pointerId: 1, startColumn: 1, startRow: 2, grabOffsetX: 0, grabOffsetY: 0, column: 2, row: 1, valid: true };
    const html = renderDashboard(dashboard, { previewImageUrl: "/api/previews/current.png", drag });
    const originalRect = computePixelRect(dashboard.screen, dashboard.grid, widget);
    const draggedRect = computePixelRect(dashboard.screen, dashboard.grid, { ...widget, column: drag.column, row: drag.row });

    expect(html).toContain(`left:${percent(draggedRect.x / dashboard.screen.width)};top:${percent(draggedRect.y / dashboard.screen.height)};width:${percent(draggedRect.width / dashboard.screen.width)};height:${percent(draggedRect.height / dashboard.screen.height)}`);
    expect(html).toContain(`width:${percent(dashboard.screen.width / originalRect.width)};height:${percent(dashboard.screen.height / originalRect.height)};left:${percent(-originalRect.x / originalRect.width)};top:${percent(-originalRect.y / originalRect.height)}`);
  });

  it("shows a drop target preview for a library component", () => {
    const dashboard = buildDashboard(buildWidget("text", { title: "", text: "", size: "medium", align: "left", showBorder: true, showBackground: true }));
    const drop: LibraryDropState = { type: "weather", displayName: "和风天气", column: 1, row: 1, columnSpan: 2, rowSpan: 2, valid: true };
    const html = renderDashboard(dashboard, { libraryDrop: drop });

    expect(html).toContain("widget-drop-preview");
    expect(html).toContain("放置 和风天气");
  });

  it("only shows the Codex placeholder when no current preview is supplied", () => {
    const config = { alias: "工作", connectionId: "local", connectionRevision: 1, quotaGroupId: "codex", lowBalanceThreshold: 20 };
    expect(renderWidget("codex-usage", config)).toContain("生成预览以查看额度");
  });
});
