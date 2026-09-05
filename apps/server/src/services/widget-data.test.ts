import { describe, expect, it } from 'vitest';
import { createDefaultDashboard, type DashboardDraft } from '@ink-stack/shared';
import { collectWidgetData } from './widget-data.js';
import type { Connections } from '../data/connections.js';
import type { CodexLimitsResult } from '../connectors/codex-app-server.js';

function dashboard(widgets: DashboardDraft['widgets']): DashboardDraft {
  return createDefaultDashboard({
    id: 'main',
    revision: 1,
    timeZone: 'Asia/Shanghai',
    widgets
  });
}

function codexWidget(id: string, quotaGroupId = 'codex') {
  return {
    id,
    type: 'codex-usage',
    configVersion: 1,
    config: { alias: '工作账号', connectionId: 'local-codex-app-server', connectionRevision: 1, quotaGroupId, lowBalanceThreshold: 20 },
    column: 0,
    row: 0,
    columnSpan: 2,
    rowSpan: 4
  } as const;
}

function result(overrides: Partial<CodexLimitsResult> = {}): CodexLimitsResult {
  const observedAt = new Date().toISOString();
  return {
    status: 'ok',
    observedAt,
    identity: 'hashed-account',
    raw: {
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          planType: 'prolite',
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1788556800 },
          secondary: null,
          rateLimitReachedType: null
        }
      }
    },
    ...overrides
  };
}

function connections(results: CodexLimitsResult[]): Connections {
  let index = 0;
  let lastGood: CodexLimitsResult | undefined;
  return {
    read: async () => {
      const value = results[Math.min(index, results.length - 1)]!;
      index += 1;
      if (value.status === 'ok') lastGood = value;
      return value;
    },
    previous: () => lastGood
  } as unknown as Connections;
}

function connectionsWithPrevious(current: CodexLimitsResult, previous: CodexLimitsResult): Connections {
  return {
    read: async () => current,
    previous: () => previous
  } as unknown as Connections;
}

describe('collectWidgetData', () => {
  it('normalizes real raw quota fields without forwarding account identity', async () => {
    const data = await collectWidgetData(dashboard([codexWidget('usage')]), connections([result()]));
    const envelope = data.usage!;
    const serialized = JSON.stringify(envelope);

    expect(envelope.status).toBe('fresh');
    expect(envelope.observedAt).toBeTruthy();
    expect(envelope.data).toMatchObject({
      quotaGroupId: 'codex',
      quotaGroupName: 'Codex',
      windows: [{ id: 'primary', usedPercent: 25, remainingPercent: 75, windowDurationMins: 300 }]
    });
    expect(serialized).not.toContain('hashed-account');
    expect(serialized).not.toContain('identity');
  });

  it('reuses one same-host read for multiple codex usage widgets', async () => {
    let reads = 0;
    const fake = {
      read: async () => {
        reads += 1;
        return result();
      },
      previous: () => undefined
    } as unknown as Connections;

    const data = await collectWidgetData(dashboard([codexWidget('left'), codexWidget('right')]), fake);

    expect(reads).toBe(1);
    expect(Object.keys(data)).toEqual(['left', 'right']);
  });

  it('distinguishes unauthenticated and unsupported local Codex states', async () => {
    const loggedOut = await collectWidgetData(
      dashboard([codexWidget('usage')]),
      connections([{ status: 'not_logged_in', observedAt: '2026-09-04T16:00:00.000Z' }])
    );
    expect(loggedOut.usage).toMatchObject({ status: 'unauthenticated', message: '需要在服务主机登录 Codex' });

    const unsupported = await collectWidgetData(
      dashboard([codexWidget('usage')]),
      connections([{ status: 'unsupported_auth', observedAt: '2026-09-04T16:00:00.000Z' }])
    );
    expect(unsupported.usage).toMatchObject({ status: 'unsupported', message: '此登录方式不支持 Codex 额度' });
  });

  it('marks missing selected quota groups unavailable rather than leaking previous account data', async () => {
    const data = await collectWidgetData(dashboard([codexWidget('spark', 'missing-group')]), connections([result()]));

    expect(data.spark?.status).toBe('unavailable');
    expect(JSON.stringify(data.spark)).not.toContain('hashed-account');
  });

  it('reuses same-account previous successful quota data as stale when the current read fails', async () => {
    const previous = result({ observedAt: new Date(Date.now() - 10 * 60_000).toISOString(), identity: 'same-account' });
    const current: CodexLimitsResult = {
      status: 'timeout',
      observedAt: new Date().toISOString(),
      identity: 'same-account',
      error: 'Codex app-server request timed out'
    };

    const data = await collectWidgetData(dashboard([codexWidget('usage')]), connectionsWithPrevious(current, previous));

    expect(data.usage?.status).toBe('stale');
    expect(data.usage?.observedAt).toBe(previous.observedAt);
    expect(data.usage?.data).toMatchObject({
      state: 'stale',
      message: '读取失败或数据过期，显示上次采集值',
      windows: [{ id: 'primary', remainingPercent: 75 }]
    });
    expect(JSON.stringify(data.usage)).not.toContain('same-account');
  });

  it('does not reuse previous quota data when a failed read has unknown or different identity', async () => {
    const previous = result({ observedAt: new Date(Date.now() - 10 * 60_000).toISOString(), identity: 'previous-account' });
    const unknownIdentity: CodexLimitsResult = {
      status: 'timeout',
      observedAt: new Date().toISOString(),
      error: 'timeout'
    };
    const differentIdentity: CodexLimitsResult = {
      status: 'timeout',
      observedAt: new Date().toISOString(),
      identity: 'different-account',
      error: 'timeout'
    };

    const unknown = await collectWidgetData(dashboard([codexWidget('unknown')]), connectionsWithPrevious(unknownIdentity, previous));
    const different = await collectWidgetData(dashboard([codexWidget('different')]), connectionsWithPrevious(differentIdentity, previous));

    expect(unknown.unknown).toMatchObject({ status: 'unavailable', message: 'Codex 额度暂不可用' });
    expect(different.different).toMatchObject({ status: 'unavailable', message: 'Codex 额度暂不可用' });
    expect(JSON.stringify(unknown)).not.toContain('previous-account');
    expect(JSON.stringify(different)).not.toContain('previous-account');
  });
});
