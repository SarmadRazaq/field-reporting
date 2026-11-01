import { open, type DB } from '@op-engineering/op-sqlite';

let db: DB | null = null;

/**
 * One SQLite file for the whole app. synchronous=FULL so that a report the UI
 * has called "saved" survives power loss, not just a force-quit.
 */
export function database(): DB {
  if (db) return db;
  db = open({ name: 'field-reports.db' });
  db.executeSync('PRAGMA journal_mode = WAL');
  db.executeSync('PRAGMA synchronous = FULL');
  db.executeSync('CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL)');
  db.executeSync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  return db;
}
