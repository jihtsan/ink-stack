import { describe, expect, it } from "vitest";
import { renderScale, wrapText } from "./render-utils.js";
import { renderCodexUsageWidget } from "./codex-usage/render.js";
import { renderDateWidget } from "./date/render.js";
import { renderTodoWidget } from "./todo/render.js";
import { renderTextWidget } from "./text/render.js";
import { normalizeCodexUsageSnapshot } from "./codex-usage/normalize.js";

const context = { now: "2026-09-05T00:00:00.000Z", timeZone: "Asia/Shanghai", screen: { width: 1072, height: 1448 }, rect: { x: 0, y: 0, width: 480, height: 200 } };
const instance = { id: "fixture", type: "text", configVersion: 1, column: 0, row: 0, columnSpan: 2, rowSpan: 1 };

function textElements(svg: string) {
  return [...svg.matchAll(/<text\b([^>]*)>(.*?)<\/text>/g)].map((match) => ({
    text: match[2]!,
    y: Number(match[1]!.match(/\by="([^"]+)"/)?.[1]),
    size: Number(match[1]!.match(/\bfont-size="([^"]+)"/)?.[1])
  }));
}

describe("component content bounds", () => {
  it.each(["short", "full", "numeric"] as const)("keeps %s date and subtitle inside a short PW3 card", (format) => {
    const svg = renderDateWidget({ context, instance: { ...instance, config: { format, showWeekday: true, subtitle: "今天也要保持专注" } } });
    const texts = textElements(svg);
    expect(texts.some((text) => text.text === "星期六")).toBe(true);
    for (const text of texts) expect(text.y + text.size * 0.2).toBeLessThan(context.rect.height);
  });

  it("reserves a separate footer when todo rows exceed the available height", () => {
    const svg = renderTodoWidget({ context, instance: { ...instance, config: { title: "今日待办", items: Array.from({ length: 8 }, (_, i) => ({ id: String(i), text: `待办${i}`, done: i < 2 })), sort: "manual", maxVisible: 8 } } });
    const texts = textElements(svg);
    expect(svg).toContain("2/8");
    const footer = texts.find((text) => text.text.startsWith("还有"))!;
    const lastRow = texts.filter((text) => /待办\d/.test(text.text)).at(-1)!;
    expect(footer.y - lastRow.y).toBeGreaterThanOrEqual(lastRow.size);
  });

  it("keeps Chinese body text inside its width and escapes custom content", () => {
    const svg = renderTextWidget({ context, instance: { ...instance, config: { title: "<提醒>", text: "中文内容".repeat(30), size: "large", align: "right", showBorder: false, showBackground: false } } });
    expect(svg).toContain("&lt;提醒&gt;");
    expect(svg).toContain('text-anchor="end"');
    expect(svg).not.toContain("<rect");
    for (const text of textElements(svg).slice(1)) {
      expect([...text.text].length * text.size).toBeLessThan(context.rect.width);
      expect(text.y + text.size * 0.2).toBeLessThan(context.rect.height);
    }
  });

  it.each([{ width: 220, height: 90 }, { width: 480, height: 200 }, { width: 1000, height: 420 }])("fits date and text at $width × $height", (rect) => {
    const renderContext = { ...context, rect: { x: 0, y: 0, ...rect } };
    for (const format of ["short", "full", "numeric"] as const) {
      const svg = renderDateWidget({ context: renderContext, instance: { ...instance, config: { format, showWeekday: true, subtitle: "保持专注".repeat(20) } } });
      for (const text of textElements(svg)) {
        expect(text.y - text.size).toBeGreaterThanOrEqual(0);
        expect(text.y + text.size * 0.2).toBeLessThan(rect.height);
      }
    }
    for (const size of ["small", "medium", "large"] as const) {
      const svg = renderTextWidget({ context: renderContext, instance: { ...instance, config: { title: "今日摘录", text: "中文长内容".repeat(500), size, align: "center", showBorder: true, showBackground: true } } });
      const texts = textElements(svg);
      expect(texts.length).toBeGreaterThan(1);
      expect(svg).toContain("…");
      for (const text of texts) expect(text.y + text.size * 0.2).toBeLessThan(rect.height);
    }
  });

  it("preserves todo sorting and maxVisible while counting all completed items", () => {
    const svg = renderTodoWidget({ context: { ...context, rect: { x: 0, y: 0, width: 480, height: 650 } }, instance: { ...instance, config: { title: "今日待办", items: [{ id: "1", text: "已完成", done: true }, { id: "2", text: "<未完成>", done: false }], sort: "open-first", maxVisible: 1 } } });
    expect(svg).toContain("1/2");
    expect(svg).toContain("&lt;未完成&gt;");
    expect(svg).not.toContain(">已完成</text>");
    expect(svg).toContain("还有 1 项");
  });
});

describe("render helpers", () => {
  it("wraps Chinese text by actual characters", () => {
    expect(wrapText("中文长文本换行", 4, 3)).toEqual(["中文长文", "本换行"]);
  });

  it("scales typography for a high-density Kindle screen", () => {
    expect(renderScale({ width: 600, height: 800 })).toBe(1);
    expect(renderScale({ width: 1072, height: 1448 })).toBeCloseTo(1.787, 3);
  });
});

describe("codex usage render", () => {
  const baseInput = {
    instance: {
      id: "codex",
      type: "codex-usage",
      configVersion: 1,
      column: 0,
      row: 0,
      columnSpan: 2,
      rowSpan: 4,
      config: {
        alias: "很长很长很长很长的账号别名",
        connectionId: "local-codex-app-server",
        connectionRevision: 1,
        quotaGroupId: "codex",
        lowBalanceThreshold: 20
      }
    },
    context: {
      now: "2026-09-05T00:00:00.000Z",
      timeZone: "Asia/Shanghai",
      screen: { width: 600, height: 800 },
      rect: { x: 0, y: 0, width: 220, height: 330 }
    }
  } as const;

  it("does not draw a zero-width quota fill when remaining percent is unknown", () => {
    const svg = renderCodexUsageWidget({
      ...baseInput,
      data: {
        status: "fresh",
        observedAt: "2026-09-05T00:00:00.000Z",
        data: {
          state: "fresh",
          quotaGroupId: "codex",
          quotaGroupName: "一个非常非常长的额度分组名称",
          observedAt: "2026-09-05T00:00:00.000Z",
          windows: [
            {
              id: "primary",
              label: "额度窗口",
              resetPending: false
            }
          ]
        }
      }
    });
    expect(svg).toContain("进度未知");
    expect(svg).not.toContain('fill="#444444"');
    expect(svg).toContain("…");
  });

  it("uses envelope observedAt when no normalized snapshot is available", () => {
    const svg = renderCodexUsageWidget({
      ...baseInput,
      data: {
        status: "unavailable",
        observedAt: "2026-09-05T00:00:00.000Z",
        message: "读取失败"
      }
    });
    expect(svg).toContain("读取失败");
    expect(svg).toContain("采集于 09/05");
  });

  it.each([{ width: 220, height: 330 }, { width: 480, height: 850 }])("keeps two quota windows above the observedAt footer at $width × $height", (rect) => {
    const data = normalizeCodexUsageSnapshot({ rateLimits: { limitId: "codex", limitName: "Codex", rateLimitReachedType: null, primary: { usedPercent: 32, windowDurationMins: 300 }, secondary: { usedPercent: 100, windowDurationMins: 10080 } } }, { observedAt: context.now });
    const svg = renderCodexUsageWidget({ ...baseInput, context: { ...context, rect: { x: 0, y: 0, ...rect } }, data: { status: "fresh", observedAt: context.now, data } });
    expect(svg).toContain("剩余 68%");
    expect(svg).toContain("剩余 0%");
    expect(svg).toContain("额度已耗尽");
    const texts = textElements(svg);
    const footer = texts.find((text) => text.text === "额度已耗尽")!;
    const lastReset = texts.filter((text) => text.text.startsWith("重置 ")).at(-1)!;
    expect(footer.y - lastReset.y).toBeGreaterThan(lastReset.size);
    expect(texts.at(-1)?.text).toBe("采集于 09/05 08:00");
    for (const text of texts) expect(text.y + text.size * 0.2).toBeLessThan(rect.height);
  });

  it("keeps stale normalized data unknown and identifies the stale state", () => {
    const data = normalizeCodexUsageSnapshot({ rateLimits: { limitId: "codex", limitName: "Codex", rateLimitReachedType: null, primary: { usedPercent: 32, windowDurationMins: 300 } } }, { observedAt: context.now, now: "2026-09-06T00:00:00Z", maxStaleMs: 60_000 });
    const svg = renderCodexUsageWidget({ ...baseInput, data: { status: "stale", observedAt: context.now, data } });
    expect(svg).toContain("剩余未知");
    expect(svg).toContain("数据已过期");
    expect(svg).not.toContain("68%");
    expect(svg).not.toContain('fill="#444444"');
  });
});
