import type { JsonObject, WidgetInstance, WidgetManifest } from "@ink-stack/shared";
import type { PublicWidgetDefinition, WidgetConfigValidation } from "./types.js";
import {
  validateCalendarConfig,
  validateCodexUsageConfig,
  validateDateConfig,
  validateImageConfig,
  validateTextConfig,
  validateTodoConfig,
  type GeneratedValidateFunction,
  type GeneratedValidationError
} from "./generated/config-validators.js";
import textManifest from "./text/manifest.json" with { type: "json" };
import textConfigSchema from "./text/config.schema.json" with { type: "json" };
import textDefaults from "./text/defaults.json" with { type: "json" };
import dateManifest from "./date/manifest.json" with { type: "json" };
import dateConfigSchema from "./date/config.schema.json" with { type: "json" };
import dateDefaults from "./date/defaults.json" with { type: "json" };
import todoManifest from "./todo/manifest.json" with { type: "json" };
import todoConfigSchema from "./todo/config.schema.json" with { type: "json" };
import todoDefaults from "./todo/defaults.json" with { type: "json" };
import codexManifest from "./codex-usage/manifest.json" with { type: "json" };
import codexConfigSchema from "./codex-usage/config.schema.json" with { type: "json" };
import codexConnectionSchema from "./codex-usage/connection.schema.json" with { type: "json" };
import codexDefaults from "./codex-usage/defaults.json" with { type: "json" };
import calendarManifest from "./calendar/manifest.json" with { type: "json" };
import calendarSchema from "./calendar/config.schema.json" with { type: "json" };
import calendarDefaults from "./calendar/defaults.json" with { type: "json" };
import calendarConnectionSchema from "./calendar/connection.schema.json" with { type: "json" };

import imageManifest from "./image/manifest.json" with { type: "json" };
import imageConfigSchema from "./image/config.schema.json" with { type: "json" };
import imageDefaults from "./image/defaults.json" with { type: "json" };

export const widgetCatalog = [
  defineWidget(textManifest, textConfigSchema, textDefaults),
  defineWidget(imageManifest, imageConfigSchema, imageDefaults),
  defineWidget(dateManifest, dateConfigSchema, dateDefaults),
  defineWidget(todoManifest, todoConfigSchema, todoDefaults),
  defineWidget(codexManifest, codexConfigSchema, codexDefaults, codexConnectionSchema),
  defineWidget(calendarManifest, calendarSchema, calendarDefaults, calendarConnectionSchema)
] as const satisfies readonly PublicWidgetDefinition[];

export const widgetCatalogByType = new Map(widgetCatalog.map((definition) => [definition.manifest.type, definition]));

export const supportedSizesByWidgetType = new Map(
  widgetCatalog.map((definition) => [definition.manifest.type, definition.manifest.supportedSizes])
);

export const minimumPixelSizeByWidgetType = new Map(
  widgetCatalog
    .filter((definition) => definition.manifest.minimumPixelSize)
    .map((definition) => [definition.manifest.type, definition.manifest.minimumPixelSize!])
);

const configValidators = new Map<string, GeneratedValidateFunction>([
  ["text", validateTextConfig],
  ["image", validateImageConfig],
  ["date", validateDateConfig],
  ["todo", validateTodoConfig],
  ["codex-usage", validateCodexUsageConfig],
  ["calendar", validateCalendarConfig]
]);

assertCatalogIsConsistent(widgetCatalog);

export function getWidgetDefinition(type: string): PublicWidgetDefinition | undefined {
  return widgetCatalogByType.get(type);
}

export function validateWidgetInstanceConfig(instance: Pick<WidgetInstance, "type" | "configVersion" | "config">): WidgetConfigValidation {
  const definition = widgetCatalogByType.get(instance.type);
  if (!definition) {
    return { ok: false, errors: [{ path: "/type", message: `Unknown widget type ${instance.type}.` }] };
  }
  if (instance.configVersion !== definition.manifest.configVersion) {
    return {
      ok: false,
      errors: [
        {
          path: "/configVersion",
          message: `Unsupported config version ${instance.configVersion} for ${instance.type}.`
        }
      ]
    };
  }

  const validator = configValidators.get(instance.type);
  if (!validator) {
    return { ok: false, errors: [{ path: "/type", message: `Missing config validator for ${instance.type}.` }] };
  }

  if (validator(instance.config)) {
    return { ok: true };
  }
  return {
    ok: false,
    errors: (validator.errors ?? []).map(formatAjvError)
  };
}

function defineWidget(
  manifest: unknown,
  configSchema: Record<string, unknown>,
  defaults: unknown,
  connectionSchema?: Record<string, unknown>
): PublicWidgetDefinition {
  return {
    manifest: manifest as WidgetManifest,
    configSchema,
    connectionSchema,
    defaults: defaults as JsonObject
  };
}

function assertCatalogIsConsistent(definitions: readonly PublicWidgetDefinition[]): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    const { manifest } = definition;
    if (seen.has(manifest.type)) {
      throw new Error(`Duplicate widget type ${manifest.type}.`);
    }
    seen.add(manifest.type);
    if (!manifest.supportedSizes.some((size) => size.columns === manifest.defaultSize.columns && size.rows === manifest.defaultSize.rows)) {
      throw new Error(`Default size for ${manifest.type} is not listed in supportedSizes.`);
    }
  }
}

function formatAjvError(error: GeneratedValidationError): { path: string; message: string } {
  return {
    path: error.instancePath || error.schemaPath,
    message: error.message ?? "Invalid widget config."
  };
}
