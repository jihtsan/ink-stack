import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { InkDatabase } from '../storage/database.js';

export type SecretUpdate = { action: 'keep' } | { action: 'clear' } | { action: 'replace'; value: string };
/** Credential ownership is authenticated as additional data; plaintext never leaves the data layer. */
export class CredentialStore {
  constructor(private db: InkDatabase, private key: Buffer | undefined, private invalidate: (connection: string) => void) {}
  has(connection: string, id: string): boolean {
    const row = this.db.prepare('SELECT ciphertext FROM credentials WHERE id=? AND connection_id=?').get(id, connection) as { ciphertext: string } | undefined;
    return Boolean(row?.ciphertext);
  }
  write(connection: string, id: string, update: SecretUpdate): { configured: boolean; revision: number } {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id=?').get(id) as { connection_id: string; revision: number; ciphertext: string } | undefined;
    if (row && row.connection_id !== connection) throw new Error('credential_ownership');
    if (update.action === 'keep') return { configured: Boolean(row?.ciphertext), revision: row?.revision ?? 0 };
    const revision = (row?.revision ?? 0) + 1;
    let ciphertext = '';
    if (update.action === 'replace') {
      if (!this.key || this.key.length !== 32) throw new Error('master_key_unavailable');
      if (!update.value || update.value.length > 8192) throw new Error('invalid_secret');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from(`${connection}:${id}:${revision}`));
      const encrypted = Buffer.concat([cipher.update(update.value, 'utf8'), cipher.final()]);
      ciphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    }
    this.db.prepare('INSERT INTO credentials VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext').run(id, connection, revision, ciphertext);
    this.invalidate(connection);
    return { configured: Boolean(ciphertext), revision };
  }
  read(connection: string, id: string): string | undefined {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id=? AND connection_id=?').get(id, connection) as {revision:number;ciphertext:string} | undefined;
    if (!row?.ciphertext) return undefined;
    if (!this.key || this.key.length !== 32) throw new Error('master_key_unavailable');
    try {
      const bytes = Buffer.from(row.ciphertext, 'base64');
      const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0,12));
      cipher.setAuthTag(bytes.subarray(12,28));
      cipher.setAAD(Buffer.from(`${connection}:${id}:${row.revision}`));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    } catch { throw new Error('credential_decryption_failed'); }
  }
}
