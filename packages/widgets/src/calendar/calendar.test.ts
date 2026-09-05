import { describe, expect, it, vi } from "vitest";
import type { WidgetDataEnvelope } from "@ink-stack/shared";
import { validateWidgetInstanceConfig } from "../catalog.js";
import { renderWidgetToSvg } from "../registry.server.js";
import { textWidth } from "../render-utils.js";
import { calendarRange, eventDates, eventsInRange, type CalendarConfig, type CalendarSnapshot } from "./model.js";
import { CalendarAdapterError, collectCalendarData, normalizeGoogleEvents } from "./server.js";
import { renderCalendarWidget } from "./render.js";
import defaults from "./defaults.json" with { type: "json" };
import manifest from "./manifest.json" with { type: "json" };
import fixture from "./fixtures/default.json" with { type: "json" };
import empty from "./fixtures/empty.json" with { type: "json" };
import unauthenticated from "./fixtures/unauthenticated.json" with { type: "json" };

const config = { ...defaults, connectionId: "test-google" } as CalendarConfig;
const now = "2026-09-05T00:00:00.000Z";
const context = { now, timeZone: "Asia/Shanghai", screen: { width: 600, height: 800 }, rect: { x: 0, y: 0, width: 552, height: 360 } };
const data = fixture as WidgetDataEnvelope<CalendarSnapshot>;
const instance = { id: "calendar-a", type: "calendar", configVersion: 1, column: 0, row: 0, columnSpan: 4, rowSpan: 3, config };
const read = () => ({ ...data.data!, observedAt: now });

describe("calendar config and date rules", () => {
  it("accepts defaults and refuses credentials, invalid month, selections and unbounded ranges", () => {
    expect(validateWidgetInstanceConfig({ ...instance, config: defaults }).ok).toBe(true);
    for (const changes of [{ accessToken: "secret" }, { month: "2026-13" }, { calendarIds: [] }, { calendarIds: ["primary", "primary"] }, { eventRangeDays: 0 }, { eventRangeDays: 32 }, { maxVisible: 100 }, { weekStartsOn: 3 }, { connectionRevision: 0 }]) {
      expect(validateWidgetInstanceConfig({ ...instance, config: { ...defaults, ...changes } }).ok).toBe(false);
    }
  });

  it("uses the dashboard zone at month boundaries, leap months, and local calendar days across DST", () => {
    expect(calendarRange(config, "2026-08-31T23:00:00Z", "Asia/Shanghai")).toMatchObject({ startDate: "2026-09-01", endDate: "2026-10-01" });
    expect(calendarRange({ ...config, month: "2028-02" }, now, "UTC")).toMatchObject({ startDate: "2028-02-01", endDate: "2028-03-01" });
    expect(calendarRange({ ...config, layout: "list", eventRangeDays: 2 }, "2026-03-08T06:00:00Z", "America/New_York")).toEqual({ startDate: "2026-03-08", endDate: "2026-03-10", timeZone: "America/New_York" });
  });

  it("excludes all-day and timed events ending exactly at the range start", () => {
    const events = normalizeGoogleEvents("primary", [
      { id: "old", start: { date: "2026-09-04" }, end: { date: "2026-09-05" } },
      { id: "midnight", start: { dateTime: "2026-09-04T20:00:00+08:00" }, end: { dateTime: "2026-09-05T00:00:00+08:00" } },
      { id: "overlap", start: { date: "2026-09-04" }, end: { date: "2026-09-06" } },
      { id: "future", start: { date: "2026-09-06" }, end: { date: "2026-09-07" } }
    ]);
    expect(eventsInRange(events, { startDate: "2026-09-05", endDate: "2026-09-06", timeZone: "Asia/Shanghai" }).map(event => event.id)).toEqual(["overlap"]);
    expect(eventDates(data.data!.events[2]!, "Asia/Shanghai")).toEqual({ start: "2026-09-06", last: "2026-09-07" });
  });

  it("strips Google metadata, ignores cancellations and rejects malformed dates", () => {
    const normalized = normalizeGoogleEvents("primary", [{ id: "cancelled", status: "cancelled" }, { id: "one", description: "private", organizer: { email: "private" }, start: { date: "2026-09-05" }, end: { date: "2026-09-06" } }]);
    expect(normalized).toEqual([{ id: "one", calendarId: "primary", title: "（无标题）", allDay: true, start: "2026-09-05", end: "2026-09-06" }]);
    for (const start of ["2026-02-30", "nonsense"]) expect(() => normalizeGoogleEvents("primary", [{ id: "bad", start: { date: start }, end: { date: "2026-09-06" } }])).toThrow();
    expect(() => normalizeGoogleEvents("primary", [{ id: "bad", start: { dateTime: "2026-09-05T10:00:00" }, end: { dateTime: "2026-09-05T11:00:00Z" } }])).toThrow();
  });
});

describe("calendar server boundary", () => {
  it("keeps an unconfigured or unimplemented connection explicit without calling an adapter", async () => {
    const adapter = { read: vi.fn(async () => read()) };
    expect((await collectCalendarData(defaults as CalendarConfig, context, adapter)).status).toBe("unauthenticated");
    expect(adapter.read).not.toHaveBeenCalled();
    expect((await collectCalendarData(config, context)).status).toBe("unsupported");
  });

  it("passes versioned selections and sanitizes successful display snapshots", async () => {
    const adapter = { read: vi.fn(async () => ({ ...read(), accessToken: "secret", events: read().events.map(event => ({ ...event, description: "private" })) })) };
    const result = await collectCalendarData(config, context, adapter);
    expect(adapter.read.mock.calls[0]?.[0]).toMatchObject({ connectionId: "test-google", connectionRevision: 1, calendarIds: ["primary"], startDate: "2026-09-01", endDate: "2026-10-01", timeZone: "Asia/Shanghai", maxEvents: 100 });
    expect(result.status).toBe("fresh");
    expect(JSON.stringify(result)).not.toMatch(/secret|private|accessToken/);
  });

  it("does not leak errors or reuse data after auth failure, malformed responses or foreign-calendar data", async () => {
    const revoked = await collectCalendarData(config, context, { read: async () => { throw new CalendarAdapterError("unauthenticated"); } });
    expect(revoked).toEqual({ status: "unauthenticated", message: "Google 授权失效，请重新连接" });
    const failed = await collectCalendarData(config, context, { read: async () => { throw new Error("Bearer private-token"); } });
    expect(JSON.stringify(failed)).not.toContain("private-token");
    expect((await collectCalendarData(config, context, { read: async () => ({ ...read(), events: [{ ...read().events[0]!, calendarId: "foreign" }] }) })).status).toBe("unavailable");
  });

  it("marks old snapshots stale without changing observedAt and discards expired data", async () => {
    const observedAt = "2026-09-04T23:45:00.000Z";
    const stale = await collectCalendarData(config, context, { read: async () => ({ ...read(), observedAt }) });
    expect(stale).toMatchObject({ status: "stale", observedAt });
    const expired = await collectCalendarData(config, context, { read: async () => ({ ...read(), observedAt: "2026-09-04T22:00:00.000Z" }) });
    expect(expired.status).toBe("unavailable");
    expect(expired.data).toBeUndefined();
  });

  it("bounds a stalled adapter and aborts it", async () => {
    let signal: AbortSignal | undefined;
    const result = await collectCalendarData(config, context, { read: async (_request, received) => { signal = received; return new Promise(() => {}); } }, 5);
    expect(result.status).toBe("unavailable");
    expect(signal?.aborted).toBe(true);
  });
});

describe("calendar drawing", () => {
  it.each(manifest.supportedSizes)("renders every layout at $columns × $rows, including minimum pixels", size => {
    for (const rect of [{ width: 552, height: size.rows * 122 - 8 }, { width: 320, height: 210 }]) {
      for (const layout of ["month", "list", "month-list"] as const) {
        const input = { context: { ...context, rect: { x: 0, y: 0, ...rect } }, instance: { ...instance, config: { ...config, layout, title: "中文日历标题".repeat(20) } }, data };
        const svg = renderCalendarWidget(input);
        expect(svg).toContain("示例数据");
        expect(svg).not.toMatch(/NaN|Infinity|https?:/);
        const texts = [...svg.matchAll(/<text\b([^>]*)>(.*?)<\/text>/g)];
        for (const match of texts) {
          const attributes = match[1]!;
          const x = Number(attributes.match(/\bx="([^"]+)"/)?.[1]);
          const y = Number(attributes.match(/\by="([^"]+)"/)?.[1]);
          const font = Number(attributes.match(/\bfont-size="([^"]+)"/)?.[1]);
          expect(y - font).toBeGreaterThanOrEqual(0);
          expect(y + font * 0.2).toBeLessThan(rect.height);
          const width = textWidth(match[2]!, font);
          const left = attributes.includes('text-anchor="end"') ? x - width : attributes.includes('text-anchor="middle"') ? x - width / 2 : x;
          expect(left).toBeGreaterThanOrEqual(0);
          expect(left + width).toBeLessThanOrEqual(rect.width);
        }
      }
    }
  });

  it("preserves the local month for auth failures and distinguishes empty from unknown", () => {
    const revoked = renderCalendarWidget({ context, instance, data: unauthenticated as WidgetDataEnvelope<CalendarSnapshot> });
    expect(revoked).toContain("2026年09月");
    expect(revoked).toContain("Google 授权失效");
    expect(revoked).not.toContain("0 项日程");
    const svg = renderCalendarWidget({ context, instance: { ...instance, config: { ...config, layout: "list" } }, data: empty as WidgetDataEnvelope<CalendarSnapshot> });
    expect(svg).toContain("此范围暂无日程");
    const expired = renderCalendarWidget({ context: { ...context, now: "2026-09-06T00:00:00Z" }, instance, data });
    expect(expired).toContain("日程暂不可用");
    expect(expired).not.toContain("项目讨论");
  });

  it("escapes event text, shows bounded overflow and isolates repeated instances", () => {
    const unsafe = { ...data, data: { ...data.data!, events: [{ ...data.data!.events[0]!, title: "<script>&中文" }, ...data.data!.events.slice(1)] } };
    const input = { context, instance: { ...instance, config: { ...config, layout: "list" as const, maxVisible: 1 } }, data: unsafe };
    const svg = renderCalendarWidget(input);
    expect(svg).toContain("&lt;script&gt;&amp;中文");
    expect(svg).toContain("还有 2 项");
    expect(svg).not.toContain("<script>");
    const other = renderWidgetToSvg({ ...instance, id: "calendar-b", config: { ...defaults, title: "第二个日历", month: "2028-02" } }, context);
    expect(other).toContain("第二个日历");
    expect(other).toContain("2028年02月");
    expect(other).not.toContain("&lt;script&gt;");
  });
});
