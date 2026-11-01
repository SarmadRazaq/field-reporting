import ReactNativeBlobUtil from 'react-native-blob-util';
import type { FileStore } from '../core/ports';

const { fs } = ReactNativeBlobUtil;

export const DIRS = {
  photos: `${fs.dirs.DocumentDir}/photos`,
  /** Byte ranges cut from photos for upload. */
  chunks: `${fs.dirs.CacheDir}/upload-chunks`,
  /** Where the resizer writes before we move the result into place. */
  encoder: `${fs.dirs.CacheDir}/encoder`,
};

const stripScheme = (uri: string) => uri.replace(/^file:\/\//, '');

export async function ensureDir(dir: string) {
  if (!(await fs.exists(dir))) await fs.mkdir(dir);
}

export class BlobFileStore implements FileStore {
  readonly photosDir = DIRS.photos;

  async importPhoto(sourceUri: string, dest: string): Promise<{ bytes: number }> {
    await ensureDir(this.photosDir);
    if (await fs.exists(dest)) await fs.unlink(dest);
    if (sourceUri.startsWith('content://')) await ReactNativeBlobUtil.MediaCollection.copyToInternal(sourceUri, dest);
    else await fs.cp(stripScheme(sourceUri), dest);
    // The picker may have made its own cache copy; ours is the one that matters now.
    if (sourceUri.startsWith('file://') && sourceUri.includes(fs.dirs.CacheDir))
      await fs.unlink(stripScheme(sourceUri)).catch(() => {});
    return { bytes: Number((await fs.stat(dest)).size) };
  }

  async size(path: string): Promise<number | null> {
    if (!(await fs.exists(path))) return null;
    return Number((await fs.stat(path)).size);
  }

  async move(from: string, to: string): Promise<void> {
    if (await fs.exists(to)) await fs.unlink(to);
    await fs.mv(from, to);
  }

  async remove(path: string): Promise<void> {
    if (await fs.exists(path)) await fs.unlink(path);
  }

  sha256(path: string): Promise<string> {
    return fs.hash(path, 'sha256');
  }

  async list(dir: string): Promise<string[]> {
    if (!(await fs.exists(dir))) return [];
    return (await fs.ls(dir)).map(name => `${dir}/${name}`);
  }

  /** Photos, chunk and encoder scratch, and anything the image picker left in the cache. */
  async clearAll(): Promise<void> {
    if (await fs.exists(DIRS.photos)) await fs.unlink(DIRS.photos);
    for (const name of await fs.ls(fs.dirs.CacheDir).catch(() => [] as string[]))
      await fs.unlink(`${fs.dirs.CacheDir}/${name}`).catch(() => {});
  }
}
