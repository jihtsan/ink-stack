import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createDefaultDashboard, type DashboardDraft, type WidgetDataEnvelope } from '@ink-stack/shared';
import { Renderer } from './renderer.js';
import type { RenderInput } from '../workers/render.worker.js';

function writeWorker(source: string): URL {
  const directory = mkdtempSync(join(tmpdir(), 'inkstack-renderer-worker-'));
  const file = join(directory, 'worker.mjs');
  writeFileSync(file, source, 'utf8');
  return new URL(`file:///${file.replace(/\\/g, '/')}`);
}

function dashboard(widgets: DashboardDraft['widgets'] = []): DashboardDraft {
  return createDefaultDashboard({
    id: 'main',
    revision: 1,
    timeZone: 'Asia/Shanghai',
    widgets
  });
}

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    dashboard: dashboard(),
    data: {},
    now: '2026-09-04T16:00:00.000Z',
    fontPath: resolve('assets/fonts/NotoSansCJKsc-Regular.otf'),
    ...overrides
  };
}

describe('Renderer', () => {
  it('reuses one worker across successful renders', async () => {
    const renderer = new Renderer(1_000, writeWorker(`
      import { parentPort } from 'node:worker_threads';
      let count = 0;
      parentPort.on('message', () => parentPort.postMessage({ png: Buffer.from(String(++count)) }));
    `));

    await expect(renderer.render(input())).resolves.toEqual(Buffer.from('1'));
    await expect(renderer.render(input())).resolves.toEqual(Buffer.from('2'));
    await renderer.close();
  });

  it('rejects concurrent renders while the shared worker is busy', async () => {
    const renderer = new Renderer(1_000, writeWorker(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', () => setTimeout(() => parentPort.postMessage({ png: Buffer.from('done') }), 50));
    `));

    const first = renderer.render(input());
    await expect(renderer.render(input())).rejects.toThrow('renderer_busy');
    await expect(first).resolves.toEqual(Buffer.from('done'));
    await renderer.close();
  });

  it('terminates a stuck worker on timeout and recovers with a new worker', async () => {
    const renderer = new Renderer(50, writeWorker(`
      import { parentPort } from 'node:worker_threads';
      let count = 0;
      parentPort.on('message', message => {
        if (message.mode === 'spin') {
          while (true) {}
        }
        parentPort.postMessage({ png: Buffer.from(String(++count)) });
      });
    `));

    await expect(renderer.render({ ...input(), mode: 'spin' } as RenderInput)).rejects.toThrow('render_timeout');
    await expect(renderer.render(input())).resolves.toEqual(Buffer.from('1'));
    await renderer.close();
  });

  it('passes only the render input to the worker and does not add credential material', async () => {
    const renderer = new Renderer(1_000, writeWorker(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', message => parentPort.postMessage({ png: Buffer.from(JSON.stringify(message)) }));
    `));
    const data: Record<string, WidgetDataEnvelope> = {
      codex: {
        status: 'fresh',
        observedAt: '2026-09-04T16:00:00.000Z',
        data: {
          quotaGroupId: 'codex',
          quotaGroupName: 'Codex',
          windows: [{ id: 'primary', remainingPercent: 75 }]
        }
      }
    };
    const rendered = await renderer.render(input({
      dashboard: dashboard([{ id: 'codex', type: 'codex-usage', configVersion: 1, config: { quotaGroupId: 'codex' }, column: 0, row: 0, columnSpan: 2, rowSpan: 4 }]),
      data
    }));
    const payload = JSON.parse(rendered.toString()) as unknown;
    const text = JSON.stringify(payload);

    expect(text).not.toContain('secret');
    expect(text).not.toContain('identity');
    expect(text).not.toContain('Bearer');
    await renderer.close();
  });

  it('renders with the real compiled render.worker output to an opaque grayscale PNG', async () => {
    const renderer = new Renderer(5_000, new URL('../../dist/workers/render.worker.js', import.meta.url));
    const rendered = await renderer.render(input({
      dashboard: dashboard([{ id: 'text-1', type: 'text', configVersion: 1, config: { title: '问候', text: '墨栈中文渲染', size: 'medium', align: 'center', weight: 'regular', showBorder: true }, column: 0, row: 0, columnSpan: 2, rowSpan: 1 }])
    }));
    const metadata = await sharp(rendered).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.width).toBe(600);
    expect(metadata.height).toBe(800);
    expect(metadata.channels).toBe(1);
    expect(metadata.hasAlpha).toBe(false);
    expect(rendered.length).toBeGreaterThan(1_000);
    await renderer.close();
  });

  it('terminates a worker during bounded native resvg work and then renders with the real worker again', async () => {
    const resvgModuleUrl = import.meta.resolve('@resvg/resvg-js');
    const workerUrl = writeWorker(`
      import { parentPort } from 'node:worker_threads';
      import { Resvg } from '${resvgModuleUrl}';
      parentPort.on('message', () => {
        const shapes = Array.from({ length: 10_000 }, (_, index) => {
          const x = (index * 17) % 2048;
          const y = (index * 31) % 2048;
          const shade = index % 255;
          return '<rect x="' + x + '" y="' + y + '" width="96" height="96" fill="rgb(' + shade + ',' + shade + ',' + shade + ')" transform="rotate(' + (index % 360) + ' 1024 1024)"/>';
        }).join('');
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048"><rect width="2048" height="2048" fill="white"/>' + shapes + '</svg>';
        parentPort.postMessage({ status: 'started' });
        new Resvg(svg).render().asPng();
        parentPort.postMessage({ status: 'finished' });
      });
    `);
    const worker = new Worker(workerUrl);
    let finished = false;
    const started = new Promise<void>((resolveStarted, rejectStarted) => {
      const timer = setTimeout(() => rejectStarted(new Error('native_resvg_probe_not_started')), 2_000);
      worker.on('message', message => {
        if (message?.status === 'started') {
          clearTimeout(timer);
          resolveStarted();
        }
        if (message?.status === 'finished') finished = true;
      });
      worker.once('error', rejectStarted);
    });

    worker.postMessage({});
    await started;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
    expect(finished).toBe(false);

    const startedTerminateAt = performance.now();
    const exitCode = await Promise.race([
      worker.terminate(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('native_resvg_worker_terminate_timeout')), 3_000))
    ]);
    expect(performance.now() - startedTerminateAt).toBeLessThan(3_000);
    expect(exitCode).not.toBe(0);

    const renderer = new Renderer(5_000, new URL('../../dist/workers/render.worker.js', import.meta.url));
    const rendered = await renderer.render(input({
      dashboard: dashboard([{ id: 'text-after-native-timeout', type: 'text', configVersion: 1, config: { title: '恢复', text: 'resvg 回收后继续渲染', size: 'small', align: 'center', weight: 'regular', showBorder: true }, column: 0, row: 0, columnSpan: 2, rowSpan: 1 }])
    }));
    const metadata = await sharp(rendered).metadata();

    expect(metadata.format).toBe('png');
    expect(metadata.channels).toBe(1);
    expect(metadata.hasAlpha).toBe(false);
    await renderer.close();
  }, 10_000);
});
