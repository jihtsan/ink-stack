import type { DashboardDraft, JsonObject, WidgetInstance, WidgetSize } from "@ink-stack/shared";
import type { PublicWidgetDefinition } from "@ink-stack/widgets";

export type { DashboardDraft, JsonObject, PublicWidgetDefinition, WidgetInstance, WidgetSize };

export type WidgetType = "text" | "date" | "todo" | "codex-usage" | "calendar" | "weather" | "image";

export type TextConfig = JsonObject & {
  title: string;
  text: string;
  size: "small" | "medium" | "large";
  align: "left" | "center" | "right";
  showBorder: boolean;
  showBackground: boolean;
};

export type DateConfig = JsonObject & {
  subtitle: string;
  format: "short" | "full" | "numeric";
  showWeekday: boolean;
};

export type TodoConfig = JsonObject & {
  title: string;
  items: Array<{
    id: string;
    text: string;
    done: boolean;
  }>;
  sort: "manual" | "open-first";
  maxVisible: number;
};

export type CodexUsageConfig = JsonObject & {
  alias: string;
  connectionId: string;
  connectionRevision: number;
  quotaGroupId: string;
  lowBalanceThreshold: number;
};

export type CalendarConfig = JsonObject & {
  title: string;
  layout: "month" | "list" | "month-list";
  month: string;
  weekStartsOn: 0 | 1;
  showWeekdays: boolean;
  connectionId: string;
  connectionRevision: number;
  calendarIds: string[];
  eventRangeDays: number;
  maxVisible: number;
};

export type WeatherConfig = JsonObject & {
  title: string;
  locationMode: "city" | "coordinates";
  city: string;
  latitude: number;
  longitude: number;
  units: "m" | "i";
  connectionId: string;
  connectionRevision: number;
  showTemperature: boolean;
  showCondition: boolean;
  showFeelsLike: boolean;
  showHumidity: boolean;
  showWind: boolean;
  showForecast: boolean;
  showUpdatedAt: boolean;
  refreshSeconds: number;
  cacheTtlSeconds: number;
  maxStaleSeconds: number;
};

export type ImageConfig = JsonObject & {
  title: string;
  sourceType: "album" | "directory";
  sourceId: string;
  sourceRevision: number;
  recursive: boolean;
  selection: "random" | "sequential" | "fixed";
  fixedImageId: string;
  rotationSeconds: number;
  noRepeat: boolean;
  fit: "contain" | "cover";
  grayscale: boolean;
  showTitle: boolean;
  showCaption: boolean;
  showBorder: boolean;
  padding: number;
};

export type WidgetConfig = TextConfig | DateConfig | TodoConfig | CodexUsageConfig | CalendarConfig | WeatherConfig | ImageConfig;

export type Snapshot = {
  revision: number;
  url: string;
  etag?: string;
  generatedAt: string;
  width: number;
  height: number;
};

export type DashboardResponse = {
  draft: DashboardDraft;
  draftRevision: number;
  publishedRevision: number | null;
  snapshot: Snapshot | null;
  lastError: string | null;
  displayTokenConfigured: boolean;
  lastDisplayRequestAt: string | null;
};

export type JobResponse = {
  id: string;
  kind: "preview" | "publish";
  status: "queued" | "running" | "succeeded" | "failed" | "superseded";
  editorRevision?: number;
  revision?: number;
  previewUrl?: string;
  error?: string;
};

export type CodexConnection = {
  id: string;
  type: "codex-local";
  revision: number;
  name: string;
  settings: Record<string, never>;
  configured: boolean;
};

export type CodexLimitGroup = {
  id: string;
  name: string;
};

export type CodexReadStatus =
  | "ok"
  | "codex_not_found"
  | "not_logged_in"
  | "unsupported_auth"
  | "rate_limits_unavailable"
  | "timeout"
  | "protocol_error"
  | "process_error"
  | "response_too_large";

export type CodexConnectionResponse = {
  connections: CodexConnection[];
  groups: CodexLimitGroup[];
  lastRead: {
    status: CodexReadStatus;
    observedAt: string;
    error?: string;
  } | null;
};

export type CodexConnectionTestResponse = {
  status: CodexReadStatus;
  observedAt: string;
  error?: string;
  groups: CodexLimitGroup[];
};
