import type { JsonObject, WidgetDataEnvelope, WidgetInstance, WidgetManifest, WidgetRenderContext } from "@ink-stack/shared";

export interface PublicWidgetDefinition<TConfig extends JsonObject = JsonObject> {
  manifest: WidgetManifest;
  configSchema: Record<string, unknown>;
  connectionSchema?: Record<string, unknown>;
  defaults: TConfig;
}

export interface WidgetRenderInput<TConfig extends object = JsonObject, TData = unknown> {
  instance: Omit<WidgetInstance, "config"> & { config: TConfig };
  context: WidgetRenderContext;
  data?: WidgetDataEnvelope<TData>;
}

export interface WidgetServerDefinition<TConfig extends JsonObject = JsonObject, TData = unknown> {
  manifest: WidgetManifest;
  render(input: WidgetRenderInput<TConfig, TData>): string;
}

export type AnyWidgetServerDefinition = {
  manifest: WidgetManifest;
  render(input: WidgetRenderInput<JsonObject, unknown>): string;
};

export type WidgetConfigValidation =
  | { ok: true }
  | { ok: false; errors: { path: string; message: string }[] };
