import { describe, expect, it } from 'vitest';
import { validateTarget } from './target.js';

async function expectRejected(input: string, allowedOrigins: readonly string[]) {
  await expect(validateTarget(input, allowedOrigins)).rejects.toThrow(/invalid_target|target_not_allowed/);
}

describe('validateTarget', () => {
  it('requires an explicit origin allowlist and allows public pinned IP targets', async () => {
    await expectRejected('https://8.8.8.8/status', []);

    await expect(validateTarget('https://8.8.8.8/status', ['https://8.8.8.8'])).resolves.toMatchObject({
      addresses: ['8.8.8.8']
    });

    await expect(validateTarget('https://[2606:4700:4700::1111]/status', ['https://[2606:4700:4700::1111]'])).resolves.toMatchObject({
      addresses: ['2606:4700:4700::1111']
    });
  });

  it('rejects unsupported protocols, credentials, query secrets, hashes, and unlisted origins', async () => {
    await expectRejected('file:///etc/passwd', ['file://']);
    await expectRejected('https://user:pass@example.com/', ['https://example.com']);
    await expectRejected('https://example.com/?token=secret', ['https://example.com']);
    await expectRejected('https://example.com/#token=secret', ['https://example.com']);
    await expectRejected('https://other.example.com/', ['https://example.com']);
  });

  it('rejects IPv4 private, loopback, link-local, metadata, documentation, and multicast ranges', async () => {
    const blocked = [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255'
    ];

    for (const address of blocked) {
      await expectRejected(`http://${address}/`, [`http://${address}`]);
    }
  });

  it('allows explicit private IPv4 and loopback targets only when requested', async () => {
    await expectRejected('http://192.168.1.50:8080/status', ['http://192.168.1.50:8080']);
    await expect(validateTarget('http://192.168.1.50:8080/status', ['http://192.168.1.50:8080'], { allowPrivate: true })).resolves.toMatchObject({
      addresses: ['192.168.1.50']
    });
    await expect(validateTarget('http://127.0.0.1:8080/status', ['http://127.0.0.1:8080'], { allowPrivate: true })).resolves.toMatchObject({
      addresses: ['127.0.0.1']
    });

    await expectRejected('http://169.254.169.254/', ['http://169.254.169.254']);
    await expect(validateTarget('http://169.254.169.254/', ['http://169.254.169.254'], { allowPrivate: true })).rejects.toThrow('target_not_allowed');
  });

  it('rejects IPv6 local, mapped metadata, translation, documentation, and multicast ranges', async () => {
    const blocked = [
      '[::]',
      '[::1]',
      '[::ffff:169.254.169.254]',
      '[::ffff:a9fe:a9fe]',
      '[64:ff9b::808:808]',
      '[100::]',
      '[2001:db8::1]',
      '[2002::1]',
      '[fc00::1]',
      '[fd00::1]',
      '[fe80::1]',
      '[ff00::1]'
    ];

    for (const address of blocked) {
      await expectRejected(`http://${address}/`, [`http://${address}`]);
    }
  });

  it('rejects DNS names that resolve to local addresses', async () => {
    await expectRejected('http://localhost/', ['http://localhost']);
  });
});
