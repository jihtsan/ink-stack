import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getWidgetDefinition } from '@ink-stack/widgets';
import { collectCalendarData, type CalendarConfig } from '@ink-stack/widgets/calendar/server';
import { openDatabase } from '../storage/database.js';
import { Connections } from '../data/connections.js';
import { GoogleCalendarService } from './google-calendar.js';

it('keeps slow multi-page calendar reads within the collector observation time', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ink-calendar-time-'));
  const db = openDatabase(directory);
  try {
    let clock = Date.parse('2026-09-05T00:00:00Z');
    const requestedAt = new Date(clock).toISOString();
    const connections = new Connections(db, undefined, { masterKey: Buffer.alloc(32, 8) });
    const calendar = new GoogleCalendarService(db, connections, {
      now: () => new Date(clock),
      http: async ({ url }) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return { status: 200, body: { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 } };
        }
        // Model two seconds of network latency without sleeping the test.
        clock += 2000;
        return { status: 200, body: {
          items: [{ id: 'meeting', summary: '会议', start: { date: '2026-09-05' }, end: { date: '2026-09-06' } }],
          ...(new URL(url).searchParams.has('pageToken') ? {} : { nextPageToken: 'page-two' })
        } };
      }
    });
    calendar.setApp('1234567890.apps.googleusercontent.com', 'test-client-secret');
    const authorization = new URL(await calendar.start('session', 'http://localhost:3210'));
    const connection = await calendar.complete('session', authorization.searchParams.get('state')!, 'code', 'http://localhost:3210');
    // Earlier widgets can take time before the calendar adapter is invoked.
    clock += 2000;
    const config = { ...getWidgetDefinition('calendar')!.defaults, connectionId: connection.id, connectionRevision: 1 } as unknown as CalendarConfig;
    const result = await collectCalendarData(config, { now: requestedAt, timeZone: 'Asia/Shanghai' }, calendar);
    expect(clock - Date.parse(requestedAt)).toBeGreaterThanOrEqual(6000);
    expect(result).toMatchObject({ status: 'fresh', observedAt: requestedAt });
    expect(result.data?.events.length).toBeGreaterThan(0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
