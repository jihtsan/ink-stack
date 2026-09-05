import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialStore } from './credentials.js';
import { openDatabase } from '../storage/database.js';

function createStore(key = randomBytes(32)) {
  const db = openDatabase(mkdtempSync(join(tmpdir(), 'inkstack-credentials-')));
  db.prepare('INSERT INTO connections VALUES (?,?,?)').run('conn-a', 'codex-local', 'Connection A');
  db.prepare('INSERT INTO connection_versions VALUES (?,?,?)').run('conn-a', 1, '{}');
  db.prepare('INSERT INTO connections VALUES (?,?,?)').run('conn-b', 'codex-local', 'Connection B');
  db.prepare('INSERT INTO connection_versions VALUES (?,?,?)').run('conn-b', 1, '{}');
  const invalidated: string[] = [];
  return {
    db,
    invalidated,
    store: new CredentialStore(db, key, connection => invalidated.push(connection))
  };
}

describe('CredentialStore', () => {
  it('keeps, replaces, reads, and clears a credential without echoing plaintext', () => {
    const { db, store, invalidated } = createStore();

    expect(store.write('conn-a', 'api-key', { action: 'keep' })).toEqual({ configured: false, revision: 0 });
    expect(invalidated).toEqual([]);

    const written = store.write('conn-a', 'api-key', { action: 'replace', value: 'super-secret-token' });
    expect(written).toEqual({ configured: true, revision: 1 });
    expect(store.read('conn-a', 'api-key')).toBe('super-secret-token');
    expect(invalidated).toEqual(['conn-a']);

    const row = db.prepare('SELECT revision,ciphertext FROM credentials WHERE id=?').get('api-key') as { revision: number; ciphertext: string };
    expect(row.revision).toBe(1);
    expect(row.ciphertext).not.toContain('super-secret-token');

    expect(store.write('conn-a', 'api-key', { action: 'keep' })).toEqual({ configured: true, revision: 1 });
    expect(invalidated).toEqual(['conn-a']);

    const cleared = store.write('conn-a', 'api-key', { action: 'clear' });
    expect(cleared).toEqual({ configured: false, revision: 2 });
    expect(store.read('conn-a', 'api-key')).toBeUndefined();
    expect(invalidated).toEqual(['conn-a', 'conn-a']);
  });

  it('rejects cross-connection writes for an existing credential id', () => {
    const { store } = createStore();
    store.write('conn-a', 'shared-id', { action: 'replace', value: 'secret-a' });

    expect(() => store.write('conn-b', 'shared-id', { action: 'replace', value: 'secret-b' })).toThrow('credential_ownership');
    expect(() => store.write('conn-b', 'shared-id', { action: 'clear' })).toThrow('credential_ownership');
    expect(store.read('conn-a', 'shared-id')).toBe('secret-a');
    expect(store.read('conn-b', 'shared-id')).toBeUndefined();
  });

  it('requires a valid master key for replace and read but not clear', () => {
    const { db, store } = createStore();
    store.write('conn-a', 'api-key', { action: 'replace', value: 'secret' });

    const missingKeyStore = new CredentialStore(db, undefined, () => undefined);
    expect(() => missingKeyStore.read('conn-a', 'api-key')).toThrow('master_key_unavailable');
    expect(() => missingKeyStore.write('conn-a', 'other-key', { action: 'replace', value: 'secret' })).toThrow('master_key_unavailable');

    expect(missingKeyStore.write('conn-a', 'api-key', { action: 'clear' })).toEqual({ configured: false, revision: 2 });
    expect(missingKeyStore.read('conn-a', 'api-key')).toBeUndefined();
  });

  it('detects wrong master keys, tampered ciphertext, and invalid secret values', () => {
    const { db, store } = createStore();
    store.write('conn-a', 'api-key', { action: 'replace', value: 'secret' });

    const wrongKeyStore = new CredentialStore(db, randomBytes(32), () => undefined);
    expect(() => wrongKeyStore.read('conn-a', 'api-key')).toThrow('credential_decryption_failed');

    db.prepare('UPDATE credentials SET ciphertext=? WHERE id=?').run(Buffer.from('not-a-valid-gcm-payload').toString('base64'), 'api-key');
    expect(() => store.read('conn-a', 'api-key')).toThrow('credential_decryption_failed');

    expect(() => store.write('conn-a', 'empty', { action: 'replace', value: '' })).toThrow('invalid_secret');
    expect(() => store.write('conn-a', 'huge', { action: 'replace', value: 'x'.repeat(8193) })).toThrow('invalid_secret');
  });
});
