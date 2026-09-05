import type { WidgetDataEnvelope } from "@ink-stack/shared";
import { calendarRange, eventsInRange, type CalendarConfig, type CalendarEvent, type CalendarRange, type CalendarSnapshot } from "./model.js";

export interface CalendarReadRequest extends CalendarRange {
  connectionId: string;
  connectionRevision: number;
  calendarIds: string[];
  maxEvents: number;
}

// Trusted server adapter resolves the versioned connection and credentials. No tokens cross this boundary.
export interface CalendarAdapter {
  read(request: CalendarReadRequest, signal: AbortSignal): Promise<CalendarSnapshot & { observedAt: string }>;
}

export class CalendarAdapterError extends Error {
  constructor(public readonly code: "unauthenticated" | "unavailable" | "unsupported") {
    super(code);
  }
}

export async function collectCalendarData(
  config: CalendarConfig,
  context: { now: string; timeZone: string },
  adapter?: CalendarAdapter,
  timeoutMs = 5000
): Promise<WidgetDataEnvelope<CalendarSnapshot>> {
  if (!config.connectionId) return { status: "unauthenticated", message: "未连接 Google Calendar" };
  if (!adapter) return { status: "unsupported", message: "Google 授权接入尚未完成" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request: CalendarReadRequest = { ...calendarRange(config, context.now, context.timeZone), connectionId: config.connectionId,
      connectionRevision: config.connectionRevision, calendarIds: [...config.calendarIds], maxEvents: 100 };
    const snapshot = await Promise.race([
      adapter.read(request, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CalendarAdapterError("unavailable")); }, timeoutMs); })
    ]);
    const age = Date.parse(context.now) - Date.parse(snapshot.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 3600_000 || !["google", "fixture"].includes(snapshot.source)
      || typeof snapshot.truncated !== "boolean" || !Array.isArray(snapshot.events) || snapshot.events.length > 500) {
      throw new CalendarAdapterError("unavailable");
    }
    // Copy only display fields; never forward adapter payloads or upstream errors wholesale.
    const events = snapshot.events.map(sanitizeEvent);
    if (events.some((event) => !request.calendarIds.includes(event.calendarId))) throw new CalendarAdapterError("unavailable");
    const selected = eventsInRange(events, request);
    const stale = age > 600_000;
    return { status: stale ? "stale" : "fresh", observedAt: snapshot.observedAt,
      staleAt: new Date(Date.parse(snapshot.observedAt) + 600_000).toISOString(),
      data: { source: snapshot.source, events: selected.slice(0, request.maxEvents), truncated: snapshot.truncated || selected.length > request.maxEvents } };
  } catch (error) {
    const status = error instanceof CalendarAdapterError ? error.code : "unavailable";
    return { status, message: status === "unauthenticated" ? "Google 授权失效，请重新连接" : status === "unsupported" ? "Google 授权接入尚未完成" : "日程暂不可用" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CalendarAdapterError("unavailable");
  return value as Record<string, unknown>;
}

function validDate(value: unknown, allDay: boolean): value is string {
  if (typeof value !== "string") return false;
  if (allDay) return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function sanitizeEvent(value: unknown): CalendarEvent {
  const event = record(value);
  if (typeof event.id !== "string" || !event.id || event.id.length > 1024 || typeof event.calendarId !== "string" || !event.calendarId
    || event.calendarId.length > 256 || typeof event.title !== "string" || typeof event.allDay !== "boolean"
    || !validDate(event.start, event.allDay) || !validDate(event.end, event.allDay) || Date.parse(event.end) <= Date.parse(event.start)) {
    throw new CalendarAdapterError("unavailable");
  }
  return { id: event.id, calendarId: event.calendarId, title: event.title.trim().slice(0, 300) || "（无标题）", allDay: event.allDay, start: event.start, end: event.end } as CalendarEvent;
}

// Feed expanded events.list items here. Pagination and bounded HTTP are the future adapter's responsibility.
export function normalizeGoogleEvents(calendarId: string, items: unknown): CalendarEvent[] {
  if (!Array.isArray(items) || items.length > 500) throw new CalendarAdapterError("unavailable");
  return items.flatMap((item) => {
    const raw = record(item);
    if (raw.status === "cancelled") return [];
    const start = record(raw.start);
    const end = record(raw.end);
    const allDay = typeof start.date === "string";
    return [sanitizeEvent({ id: raw.id, calendarId, title: raw.summary ?? "（无标题）", allDay,
      start: allDay ? start.date : start.dateTime, end: allDay ? end.date : end.dateTime })];
  });
}

export type { CalendarConfig, CalendarEvent, CalendarSnapshot } from "./model.js";
