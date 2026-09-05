import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(directory: string) {
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, 'ink-stack.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS dashboard (
      id TEXT PRIMARY KEY, draft TEXT NOT NULL, draft_revision INTEGER NOT NULL,
      published TEXT, published_revision INTEGER, snapshot TEXT, publication_sequence INTEGER NOT NULL DEFAULT 0,
      display_hash TEXT, last_display_request TEXT, last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL, config TEXT NOT NULL, revision INTEGER NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, generated_at TEXT NOT NULL, data_status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
      editor_revision INTEGER, sequence INTEGER NOT NULL, created_at TEXT NOT NULL,
      snapshot TEXT, error TEXT
    );
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connection_versions (
      connection_id TEXT NOT NULL REFERENCES connections(id), revision INTEGER NOT NULL,
      settings TEXT NOT NULL, PRIMARY KEY(connection_id,revision)
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id), revision INTEGER NOT NULL,
      ciphertext TEXT NOT NULL
    );
    INSERT OR IGNORE INTO migrations VALUES (1);
  `);
  db.prepare("UPDATE jobs SET status='failed',error='interrupted_by_restart' WHERE status IN ('queued','running')").run();
  return db;
}
export type InkDatabase = ReturnType<typeof openDatabase>;
