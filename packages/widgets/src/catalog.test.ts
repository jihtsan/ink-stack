import { describe, expect, it } from "vitest";
import { validateDashboardLayout, DEFAULT_GRID_SPEC, DEFAULT_SCREEN_SPEC } from "@ink-stack/shared";
import { renderWidgetToSvg, widgetServerRegistry } from "./registry.server.js";
import { minimumPixelSizeByWidgetType, supportedSizesByWidgetType, validateWidgetInstanceConfig, widgetCatalog } from "./catalog.js";

describe("widget catalog", () => {
  it("contains the four first-version widgets with consistent server renderers", () => {
    expect(widgetCatalog.map((definition) => definition.manifest.type)).toEqual(["text", "date", "todo", "codex-usage"]);
    expect(widgetServerRegistry.map((definition) => definition.manifest.type)).toEqual(["text", "date", "todo", "codex-usage"]);
    expect(widgetCatalog.find((definition) => definition.manifest.type === "codex-usage")?.manifest.supportedSizes).toEqual([
      { columns: 2, rows: 4 }
    ]);
    expect(minimumPixelSizeByWidgetType.get("codex-usage")).toEqual({ width: 220, height: 330 });
  });

  it("validates each default config and rejects unknown config fields", () => {
    for (const definition of widgetCatalog) {
      expect(validateWidgetInstanceConfig({
        type: definition.manifest.type,
        configVersion: definition.manifest.configVersion,
        config: definition.defaults
      })).toEqual({ ok: true });
    }

    expect(validateWidgetInstanceConfig({
      type: "text",
      configVersion: 1,
      config: {
        title: "x",
        text: "x",
        size: "medium",
        align: "left",
        showBorder: true,
        showBackground: true,
        apiKey: "must-not-pass"
      }
    }).ok).toBe(false);
  });

  it("lets shared layout validation reject the wrong codex usage size", () => {
    const result = validateDashboardLayout(
      DEFAULT_SCREEN_SPEC,
      DEFAULT_GRID_SPEC,
      [
        {
          id: "codex",
          type: "codex-usage",
          configVersion: 1,
          config: {},
          column: 0,
          row: 0,
          columnSpan: 4,
          rowSpan: 2
        }
      ],
      { supportedSizesByType: supportedSizesByWidgetType, minimumPixelSizeByType: minimumPixelSizeByWidgetType }
    );
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.code === "unsupported-size")).toBe(true);
  });

  it("renders without network data and leaves SVG positioning to the platform", () => {
    const svg = renderWidgetToSvg(
      {
        id: "text-1",
        type: "text",
        configVersion: 1,
        config: {
          title: "测试",
          text: "中文内容",
          size: "medium",
          align: "left",
          showBorder: true,
          showBackground: true
        },
        column: 0,
        row: 0,
        columnSpan: 4,
        rowSpan: 1
      },
      {
        now: "2026-09-05T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
        screen: { width: 600, height: 800 },
        rect: { x: 0, y: 0, width: 552, height: 114 }
      }
    );
    expect(svg).toContain("中文内容");
    expect(svg).not.toContain("http");
  });
});
