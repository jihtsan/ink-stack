import type { WidgetInstance, WidgetRenderContext } from "@ink-stack/shared";
import { getWidgetDefinition } from "./catalog.js";
import type { AnyWidgetServerDefinition, WidgetRenderInput } from "./types.js";
import { renderTextWidget } from "./text/render.js";
import { renderDateWidget } from "./date/render.js";
import { renderTodoWidget } from "./todo/render.js";
import { renderCodexUsageWidget } from "./codex-usage/render.js";
import { renderWeatherWidget } from "./weather/render.js";
const textManifest = getRequiredManifest("text");
const dateManifest = getRequiredManifest("date");
const todoManifest = getRequiredManifest("todo");
const codexManifest = getRequiredManifest("codex-usage");

export const widgetServerRegistry = [
  { manifest: textManifest, render: asRegisteredRenderer(renderTextWidget) },
  { manifest: dateManifest, render: asRegisteredRenderer(renderDateWidget) },
  { manifest: todoManifest, render: asRegisteredRenderer(renderTodoWidget) },
  { manifest: codexManifest, render: asRegisteredRenderer(renderCodexUsageWidget) },
  { manifest: getRequiredManifest("weather"), render: asRegisteredRenderer(renderWeatherWidget) }
] as const satisfies readonly AnyWidgetServerDefinition[];

export const widgetServerRegistryByType = new Map(widgetServerRegistry.map((definition) => [definition.manifest.type, definition]));

assertServerRegistryMatchesCatalog(widgetServerRegistry);

export function renderWidgetToSvg(instance: WidgetInstance, context: WidgetRenderContext, data?: WidgetRenderInput["data"]): string {
  const definition = widgetServerRegistryByType.get(instance.type);
  if (!definition) {
    throw new Error(`No server renderer registered for widget type ${instance.type}.`);
  }
  return definition.render({ instance, context, data } as WidgetRenderInput);
}

function getRequiredManifest(type: string) {
  const definition = getWidgetDefinition(type);
  if (!definition) {
    throw new Error(`Missing widget definition ${type}.`);
  }
  return definition.manifest;
}

function asRegisteredRenderer(render: unknown): AnyWidgetServerDefinition["render"] {
  return render as AnyWidgetServerDefinition["render"];
}

function assertServerRegistryMatchesCatalog(definitions: readonly AnyWidgetServerDefinition[]): void {
  for (const definition of definitions) {
    const publicDefinition = getWidgetDefinition(definition.manifest.type);
    if (!publicDefinition) {
      throw new Error(`Server renderer ${definition.manifest.type} is not present in the public catalog.`);
    }
    if (publicDefinition.manifest.version !== definition.manifest.version) {
      throw new Error(`Manifest version mismatch for ${definition.manifest.type}.`);
    }
    if (publicDefinition.manifest.configVersion !== definition.manifest.configVersion) {
      throw new Error(`Config version mismatch for ${definition.manifest.type}.`);
    }
  }
}
