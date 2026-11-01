import type { LocalReport } from './types';

/**
 * Reports outlive app versions: one saved before an update may only be sent
 * after it. Every stored report carries the schema it was written with, and
 * loading brings it up to the current one, one step at a time.
 *
 *   1  (no `schema` field) the first release
 *   2  TransientIssue.since; LocalImage.problem
 */
export const REPORT_SCHEMA = 2;

type Stored = Record<string, unknown> & { schema?: number };

const UPGRADES: Record<number, (r: Stored) => Stored> = {
  1: r => {
    const issue = r.lastIssue as { at: number; since?: number } | null | undefined;
    const images = (r.images as Record<string, unknown>[]) ?? [];
    return {
      ...r,
      lastIssue: issue ? { ...issue, since: issue.since ?? issue.at } : null,
      images: images.map(i => ({ ...i, problem: i.problem ?? null })),
    };
  },
};

/** The JSON to store for a report. */
export function serializeReport(report: LocalReport): string {
  return JSON.stringify({ ...report, schema: REPORT_SCHEMA });
}

/**
 * Parse a stored report and upgrade it to the current schema. A report written
 * by a newer app (after a downgrade) is returned as it is rather than guessed at.
 */
export function parseReport(json: string): LocalReport {
  let r = JSON.parse(json) as Stored;
  let version = r.schema ?? 1;
  while (version < REPORT_SCHEMA) {
    const upgrade = UPGRADES[version];
    if (!upgrade) throw new Error(`No upgrade from report schema ${version}`);
    r = upgrade(r);
    version += 1;
  }
  const report = { ...r };
  delete report.schema;
  return report as unknown as LocalReport;
}
