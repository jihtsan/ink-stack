export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface WidgetSize {
  columns: number;
  rows: number;
}

export interface WidgetMinimumPixelSize {
  width: number;
  height: number;
}

export interface WidgetManifest {
  type: string;
  version: string;
  configVersion: number;
  displayName: string;
  description: string;
  category: "content" | "time" | "productivity" | "account";
  supportedSizes: WidgetSize[];
  defaultSize: WidgetSize;
  minimumPixelSize?: WidgetMinimumPixelSize;
  connectionType?: string;
}

export interface WidgetPlacement {
  column: number;
  row: number;
  columnSpan: number;
  rowSpan: number;
}

export interface WidgetInstance extends WidgetPlacement {
  id: string;
  type: string;
  configVersion: number;
  config: JsonObject;
}

export interface WidgetRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetRenderContext {
  now: string;
  timeZone: string;
  rect: WidgetRenderRect;
  screen: {
    width: number;
    height: number;
  };
}

export type WidgetDataStatus =
  | "fresh"
  | "stale"
  | "unavailable"
  | "unauthenticated"
  | "unsupported"
  | "exhausted";

export interface WidgetDataEnvelope<TData = unknown> {
  status: WidgetDataStatus;
  observedAt?: string;
  staleAt?: string;
  message?: string;
  data?: TData;
}
