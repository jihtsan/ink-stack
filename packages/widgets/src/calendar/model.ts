export interface CalendarConfig {
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
}

// Dates have no zone for all-day events; timed events must carry an explicit UTC offset.
export type CalendarEvent = { id: string; calendarId: string; title: string } & (
  | { allDay: true; start: string; end: string }
  | { allDay: false; start: string; end: string }
);

export interface CalendarSnapshot {
  source: "google" | "fixture";
  events: CalendarEvent[];
  truncated: boolean;
}

export interface CalendarRange {
  startDate: string;
  endDate: string; // Exclusive, in timeZone; providers convert to RFC3339 zoned midnights.
  timeZone: string;
}

export function dateInZone(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function displayedMonth(config: CalendarConfig, now: string, timeZone: string): string {
  return config.month || dateInZone(now, timeZone).slice(0, 7);
}

export function calendarRange(config: CalendarConfig, now: string, timeZone: string): CalendarRange {
  const today = dateInZone(now, timeZone);
  if (config.layout === "list") return { startDate: today, endDate: addDays(today, config.eventRangeDays), timeZone };
  const startDate = `${displayedMonth(config, now, timeZone)}-01`;
  const endDate = addDays(startDate, 32).slice(0, 7) + "-01";
  return { startDate, endDate, timeZone };
}

export function eventDates(event: CalendarEvent, timeZone: string): { start: string; last: string } {
  return event.allDay ? { start: event.start, last: addDays(event.end, -1) }
    : { start: dateInZone(event.start, timeZone), last: dateInZone(new Date(Date.parse(event.end) - 1).toISOString(), timeZone) };
}

export function eventsInRange(events: CalendarEvent[], range: CalendarRange): CalendarEvent[] {
  return events.filter((event) => {
    const dates = eventDates(event, range.timeZone);
    return dates.start < range.endDate && dates.last >= range.startDate;
  }).sort((a, b) => {
    const day = eventDates(a, range.timeZone).start.localeCompare(eventDates(b, range.timeZone).start);
    return day || Number(b.allDay) - Number(a.allDay) || (a.allDay ? a.start.localeCompare(b.start) : Date.parse(a.start) - Date.parse(b.start)) || a.id.localeCompare(b.id);
  });
}
