import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Image bytes live on disk. The upload offset for an image is simply the length
 * of its file, so a connection that dies mid-chunk leaves a valid prefix behind
 * and the client resumes from wherever the bytes actually stopped.
 */
export class Storage {
  constructor(readonly root: string) {}

  reportDir(reportId: string) {
    return path.join(this.root, 'uploads', reportId);
  }

  imagePath(reportId: string, imageId: string) {
    return path.join(this.reportDir(reportId), `${imageId}.jpg`);
  }

  thumbPath(imageId: string, width: number) {
    return path.join(this.root, 'thumbs', `${imageId}-w${width}.jpg`);
  }

  async init() {
    await fs.mkdir(path.join(this.root, 'uploads'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'thumbs'), { recursive: true });
  }

  async offset(reportId: string, imageId: string): Promise<number> {
    try {
      return (await fs.stat(this.imagePath(reportId, imageId))).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw e;
    }
  }

  async ensureReportDir(reportId: string) {
    await fs.mkdir(this.reportDir(reportId), { recursive: true });
  }

  async sha256(reportId: string, imageId: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.imagePath(reportId, imageId))) hash.update(chunk);
    return hash.digest('hex');
  }

  async discardImage(reportId: string, imageId: string) {
    await fs.rm(this.imagePath(reportId, imageId), { force: true });
  }

  async deleteReport(reportId: string, imageIds: string[]) {
    await fs.rm(this.reportDir(reportId), { recursive: true, force: true });
    await Promise.all(imageIds.map(id => this.deleteThumbs(id)));
  }

  async deleteEverything() {
    await fs.rm(path.join(this.root, 'uploads'), { recursive: true, force: true });
    await fs.rm(path.join(this.root, 'thumbs'), { recursive: true, force: true });
    await this.init();
  }

  private async deleteThumbs(imageId: string) {
    const dir = path.join(this.root, 'thumbs');
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      names.filter(n => n.startsWith(`${imageId}-`)).map(n => fs.rm(path.join(dir, n), { force: true })),
    );
  }
}
