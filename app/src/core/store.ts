import type { FileStore, ReportRepo } from './ports';
import { Cancelled } from './retry';
import type { LocalReport } from './types';

/** Every file a report's photos use on this phone. */
export function imagePaths(r: LocalReport): string[] {
  return r.images.flatMap(i => [i.sourcePath, i.processed?.path].filter((p): p is string => !!p));
}

/**
 * The reports on this phone: an in-memory copy of the repo, written through.
 * Shared by the draft composer and the uploader, so each sees the other's
 * writes at once.
 *
 * `epoch` is bumped by reset and stop. A write made under an older epoch is
 * refused, so work already in flight can't bring a wiped report back.
 */
export class ReportStore {
  private readonly reports = new Map<string, LocalReport>();
  epoch = 0;

  constructor(
    private readonly repo: ReportRepo,
    private readonly files: FileStore,
    private readonly changed: () => void,
  ) {}

  async load(): Promise<void> {
    for (const report of await this.repo.load()) this.reports.set(report.id, report);
  }

  get(id: string): LocalReport | undefined {
    return this.reports.get(id);
  }

  all(): LocalReport[] {
    return [...this.reports.values()];
  }

  /** Persist first, then publish. Throws Cancelled if a reset or stop came in between. */
  async write(report: LocalReport, epoch = this.epoch): Promise<LocalReport> {
    if (epoch !== this.epoch) throw new Cancelled();
    await this.repo.save(report);
    if (epoch !== this.epoch) throw new Cancelled();
    this.reports.set(report.id, report);
    this.changed();
    return report;
  }

  /** Change a report in memory only (e.g. forget a backoff timer); it is persisted with its next write. */
  patch(report: LocalReport): void {
    this.reports.set(report.id, report);
  }

  /** Remove a report and its photo files, except any listed in `keep`. */
  async discard(r: LocalReport, keep: ReadonlySet<string> = new Set()): Promise<void> {
    await this.repo.remove(r.id);
    this.reports.delete(r.id);
    this.changed();
    for (const path of imagePaths(r)) if (!keep.has(path)) await this.files.remove(path);
  }

  async clear(): Promise<void> {
    await this.repo.clear();
    this.reports.clear();
    this.changed();
  }

  /** Every photo file some report still uses. */
  referencedPaths(): Set<string> {
    return new Set(this.all().flatMap(imagePaths));
  }
}
