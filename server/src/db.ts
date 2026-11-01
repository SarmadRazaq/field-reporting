import Database from 'better-sqlite3';
import path from 'node:path';

export type ReportStatus = 'pending' | 'committed';

export interface ReportRow {
  id: string;
  description: string;
  created_at: string;
  received_at: string;
  committed_at: string | null;
  status: ReportStatus;
  manifest_hash: string;
}

export interface ImageRow {
  id: string;
  report_id: string;
  idx: number;
  sha256: string;
  size: number;
  mime: string;
  width: number | null;
  height: number | null;
}

export type Db = ReturnType<typeof openDb>;

export function openDb(dataDir: string) {
  const db = new Database(path.join(dataDir, 'reports.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id            TEXT PRIMARY KEY,
      description   TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      received_at   TEXT NOT NULL,
      committed_at  TEXT,
      status        TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
      manifest_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id        TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      idx       INTEGER NOT NULL,
      sha256    TEXT NOT NULL,
      size      INTEGER NOT NULL,
      mime      TEXT NOT NULL,
      width     INTEGER,
      height    INTEGER
    );
    CREATE INDEX IF NOT EXISTS images_by_report ON images(report_id, idx);
  `);

  const stmts = {
    getReport: db.prepare<[string], ReportRow>('SELECT * FROM reports WHERE id = ?'),
    getImages: db.prepare<[string], ImageRow>('SELECT * FROM images WHERE report_id = ? ORDER BY idx'),
    getImage: db.prepare<[string], ImageRow>('SELECT * FROM images WHERE id = ?'),
    insertReport: db.prepare(
      `INSERT INTO reports (id, description, created_at, received_at, status, manifest_hash)
       VALUES (@id, @description, @created_at, @received_at, 'pending', @manifest_hash)`,
    ),
    insertImage: db.prepare(
      `INSERT INTO images (id, report_id, idx, sha256, size, mime)
       VALUES (@id, @report_id, @idx, @sha256, @size, @mime)`,
    ),
    setDims: db.prepare('UPDATE images SET width = ?, height = ? WHERE id = ?'),
    commit: db.prepare(
      `UPDATE reports SET status = 'committed', committed_at = ? WHERE id = ? AND status = 'pending'`,
    ),
    listCommitted: db.prepare<[], ReportRow>(
      `SELECT * FROM reports WHERE status = 'committed' ORDER BY committed_at DESC`,
    ),
    listAll: db.prepare<[], ReportRow>('SELECT * FROM reports ORDER BY received_at DESC'),
    stalePending: db.prepare<[string], ReportRow>(
      `SELECT * FROM reports WHERE status = 'pending' AND received_at < ?`,
    ),
    deleteReport: db.prepare('DELETE FROM reports WHERE id = ?'),
    deleteAll: db.prepare('DELETE FROM reports'),
  };

  const createReport = db.transaction(
    (report: Omit<ReportRow, 'committed_at' | 'status'>, images: Omit<ImageRow, 'width' | 'height'>[]) => {
      stmts.insertReport.run(report);
      for (const image of images) stmts.insertImage.run(image);
    },
  );

  return { raw: db, stmts, createReport, close: () => db.close() };
}
