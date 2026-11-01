import type { DB } from '@op-engineering/op-sqlite';
import type { ReportRepo } from '../core/ports';
import { parseReport, serializeReport } from '../core/schema';
import type { LocalReport } from '../core/types';

/**
 * A report is a small document, stored as one row. A single-row upsert is
 * atomic, so there is never a half-written report on disk. Rows carry their
 * schema version and are upgraded as they load.
 */
export class SqliteReportRepo implements ReportRepo {
  constructor(private readonly db: DB) {}

  async load(): Promise<LocalReport[]> {
    const { rows } = await this.db.execute('SELECT json FROM reports');
    return rows.map(row => parseReport(String(row.json)));
  }

  async save(report: LocalReport): Promise<void> {
    await this.db.execute('INSERT OR REPLACE INTO reports (id, json) VALUES (?, ?)', [report.id, serializeReport(report)]);
  }

  async remove(id: string): Promise<void> {
    await this.db.execute('DELETE FROM reports WHERE id = ?', [id]);
  }

  async clear(): Promise<void> {
    await this.db.execute('DELETE FROM reports');
  }
}
