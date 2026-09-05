import { computePixelRect } from "./grid";
import { StudioIcon } from "./StudioIcon";
import { renderTextWidget, renderDateWidget, renderTodoWidget, renderCalendarWidget, renderWeatherWidget, renderImageWidget } from "@ink-stack/widgets/render";
import type {
  CalendarConfig,
  CodexUsageConfig,
  DashboardDraft,
  DateConfig,
  ImageConfig,
  TextConfig,
  TodoConfig,
  WeatherConfig,
  WidgetInstance
} from "./types";
import type { LayoutIssue } from "./grid";

export type DragState = {
  widgetId: string;
  pointerId: number;
  startColumn: number;
  startRow: number;
  grabOffsetX: number;
  grabOffsetY: number;
  column: number;
  row: number;
  valid: boolean;
};

export type LibraryDropState = {
  type: string;
  displayName: string;
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
  valid: boolean;
};

interface WidgetCanvasProps {
  previewImageUrl?: string | null;
  showGrid?: boolean;
  dashboard: DashboardDraft;
  selectedId: string | null;
  layoutIssues: LayoutIssue[];
  drag: DragState | null;
  libraryDrop: LibraryDropState | null;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  onSelect(widgetId: string): void;
  onPointerDown(event: React.PointerEvent, widget: WidgetInstance): void;
  onPointerMove(event: React.PointerEvent, widget: WidgetInstance): void;
  onPointerUp(event: React.PointerEvent, widget: WidgetInstance): void;
  onPointerCancel(event: React.PointerEvent, widget: WidgetInstance): void;
  onDragOver(event: React.DragEvent<HTMLDivElement>): void;
  onDragLeave(event: React.DragEvent<HTMLDivElement>): void;
  onDrop(event: React.DragEvent<HTMLDivElement>): void;
}

export function WidgetCanvas({
  previewImageUrl,
  showGrid = true,
  dashboard,
  selectedId,
  layoutIssues,
  drag,
  libraryDrop,
  canvasRef,
  onSelect,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onDragOver,
  onDragLeave,
  onDrop
}: WidgetCanvasProps) {
  return (
    <div
      className={`grid-canvas ${showGrid ? "" : "grid-hidden"}`}
      ref={canvasRef}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={
        {
          aspectRatio: `${dashboard.screen.width} / ${dashboard.screen.height}`,
          background: dashboard.theme.background,
          "--grid-columns": dashboard.grid.columns,
          "--grid-rows": dashboard.grid.rows,
          "--grid-margin-top": `${(dashboard.grid.margin.top / dashboard.screen.height) * 100}%`,
          "--grid-margin-right": `${(dashboard.grid.margin.right / dashboard.screen.width) * 100}%`,
          "--grid-margin-bottom": `${(dashboard.grid.margin.bottom / dashboard.screen.height) * 100}%`,
          "--grid-margin-left": `${(dashboard.grid.margin.left / dashboard.screen.width) * 100}%`,
          "--grid-column-gap": `${(dashboard.grid.columnGap / dashboard.screen.width) * 100}%`,
          "--grid-row-gap": `${(dashboard.grid.rowGap / dashboard.screen.height) * 100}%`
        } as React.CSSProperties
      }
      aria-label="墨水屏网格画布"
    >
      <div className="grid-cells" aria-hidden="true">
        {Array.from({ length: dashboard.grid.rows * dashboard.grid.columns }).map((_, index) => (
          <div className="grid-cell" key={index} />
        ))}
      </div>
      {libraryDrop ? <DropPreview dashboard={dashboard} drop={libraryDrop} /> : null}
      {dashboard.widgets.map((widget) => {
        const isSelected = widget.id === selectedId;
        const liveDrag = drag?.widgetId === widget.id ? drag : null;
        return (
          <WidgetCard
            previewImageUrl={previewImageUrl}
            key={widget.id}
            dashboard={dashboard}
            widget={widget}
            selected={isSelected}
            invalid={Boolean(layoutIssues.find((issue) => issue.widgetId === widget.id)) || liveDrag?.valid === false}
            drag={liveDrag}
            onPointerDown={(event) => onPointerDown(event, widget)}
            onPointerMove={(event) => onPointerMove(event, widget)}
            onPointerUp={(event) => onPointerUp(event, widget)}
            onPointerCancel={(event) => onPointerCancel(event, widget)}
            onSelect={() => onSelect(widget.id)}
          />
        );
      })}
    </div>
  );
}

function DropPreview({ dashboard, drop }: { dashboard: DashboardDraft; drop: LibraryDropState }) {
  const rect = computePixelRect(dashboard.screen, dashboard.grid, drop);
  const style = {
    left: `${(rect.x / dashboard.screen.width) * 100}%`,
    top: `${(rect.y / dashboard.screen.height) * 100}%`,
    width: `${(rect.width / dashboard.screen.width) * 100}%`,
    height: `${(rect.height / dashboard.screen.height) * 100}%`
  };
  return (
    <div className={`widget-drop-preview ${drop.valid ? "" : "invalid"}`} style={style} aria-hidden="true">
      <StudioIcon name="add" />
      <span>{drop.valid ? `放置 ${drop.displayName}` : "此处无法放置"}</span>
    </div>
  );
}

function WidgetCard({
  previewImageUrl,
  dashboard,
  widget,
  selected,
  invalid,
  drag,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onSelect
}: {
  previewImageUrl?: string | null;
  dashboard: DashboardDraft;
  widget: WidgetInstance;
  selected: boolean;
  invalid: boolean;
  drag: DragState | null;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
  onSelect: () => void;
}) {
  const placement = {
    ...widget,
    column: drag?.column ?? widget.column,
    row: drag?.row ?? widget.row
  };
  const rect = computePixelRect(dashboard.screen, dashboard.grid, placement);
  const style = {
    left: `${(rect.x / dashboard.screen.width) * 100}%`,
    top: `${(rect.y / dashboard.screen.height) * 100}%`,
    width: `${(rect.width / dashboard.screen.width) * 100}%`,
    height: `${(rect.height / dashboard.screen.height) * 100}%`
  };

  return (
    <button
      type="button"
      className={`widget-card ${selected ? "selected" : ""} ${invalid ? "invalid" : ""}`}
      data-widget-type={widget.type}
      aria-pressed={selected}
      style={style}
      onClick={onSelect}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <WidgetPreview dashboard={dashboard} widget={widget} previewImageUrl={previewImageUrl} />
    </button>
  );
}

function WidgetPreview({ dashboard, widget, previewImageUrl }: { dashboard: DashboardDraft; widget: WidgetInstance; previewImageUrl?: string | null }) {
  const rect = computePixelRect(dashboard.screen, dashboard.grid, widget);
  const names: Record<string, string> = { text: "文字", date: "日期", todo: "待办", "codex-usage": "Codex 额度", calendar: "日历与日程", weather: "和风天气", image: "图片相册" };
  if (previewImageUrl) return <div className="widget-png-crop"><img src={previewImageUrl} alt={`${names[widget.type] ?? widget.type}的服务端预览`} draggable={false} style={{ width: `${dashboard.screen.width / rect.width * 100}%`, height: `${dashboard.screen.height / rect.height * 100}%`, left: `${-rect.x / rect.width * 100}%`, top: `${-rect.y / rect.height * 100}%` }} /></div>;
  const context = { rect, screen: dashboard.screen, timeZone: dashboard.timeZone, now: new Date().toISOString() };
  let body: string;
  switch (widget.type) {
    case "text":
      body = renderTextWidget({ instance: { ...widget, config: widget.config as TextConfig }, context });
      break;
    case "date":
      body = renderDateWidget({ instance: { ...widget, config: widget.config as DateConfig }, context });
      break;
    case "todo":
      body = renderTodoWidget({ instance: { ...widget, config: widget.config as TodoConfig }, context });
      break;
    case "codex-usage": {
      const config = widget.config as CodexUsageConfig;
      return (
        <div className="widget-content codex-widget">
          <div className="widget-heading"><StudioIcon name="terminal" /><strong>Codex 额度</strong></div>
          <div className="codex-account"><span>{config.alias || "Codex 账号"}</span><small>{config.quotaGroupId}</small></div>
          <div className="widget-empty"><StudioIcon name="visibility" /><strong>生成预览以查看额度</strong><small>从已配置的数据源读取<br />额度窗口与重置时间</small></div>
          <div className="widget-footnote"><StudioIcon name="info" /><span>点击顶部「预览」更新画面</span></div>
        </div>
      );
    }
    case "calendar":
      body = renderCalendarWidget({ instance: { ...widget, config: widget.config as CalendarConfig }, context });
      break;
    case "weather":
      body = renderWeatherWidget({ instance: { ...widget, config: widget.config as WeatherConfig }, context });
      break;
    case "image":
      body = renderImageWidget({ instance: { ...widget, config: widget.config as ImageConfig }, context });
      break;
    default: return null;
  }
  // Built-in renderers escape every config string; no uploaded SVG or code is accepted.
  return <svg className="widget-svg" viewBox={`0 0 ${rect.width} ${rect.height}`} role="img" aria-label={`${names[widget.type]}的即时画面`} dangerouslySetInnerHTML={{ __html: body }} />;
}


