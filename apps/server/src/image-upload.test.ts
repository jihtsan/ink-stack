import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createApp } from './app.js';

it('accepts browser-encoded Chinese filenames and image bodies above the JSON request limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-upload-'));
  const origin = 'http://127.0.0.1:3210';
  const password = 'test-upload-password';
  const { app } = await createApp({ directory, password, origin, refreshMs: 0 });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/session', headers: { origin }, payload: { password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const created = await app.inject({ method: 'POST', url: '/api/image-sources', headers: { origin, cookie }, payload: { type: 'album', name: '测试' } });
    const png = await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    expect(png.length).toBeGreaterThan(128 * 1024);
    // Native Headers applies the same ByteString constraint as browser fetch.
    const header = new Headers({ 'X-InkStack-Filename': encodeURIComponent('日出 100%.png') });
    const uploaded = await app.inject({ method: 'POST', url: `/api/image-sources/${created.json().id}/uploads`, headers: {
      origin, cookie, 'content-type': 'image/png', 'x-inkstack-filename': header.get('X-InkStack-Filename')!
    }, payload: png });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json().filename).toBe('日出 100%.png');
    const listed = await app.inject({ url: `/api/image-sources/${created.json().id}/images?revision=1`, headers: { cookie } });
    expect(listed.json().images).toMatchObject([{ name: '日出 100%.png' }]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
