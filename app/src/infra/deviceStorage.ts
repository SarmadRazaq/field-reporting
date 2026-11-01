import ReactNativeBlobUtil from 'react-native-blob-util';

/** Five camera originals plus their prepared copies need roughly this much room. */
export const STORAGE = { lowBytes: 300_000_000, fullBytes: 100_000_000 } as const;

/** Free bytes on the app's internal storage, or null if the OS won't say. */
export async function freeBytes(): Promise<number | null> {
  try {
    const df = await ReactNativeBlobUtil.fs.df();
    const free = Number(df.internal_free ?? df.free);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

export const isNoSpaceError = (e: unknown) => /ENOSPC|no space left/i.test(String(e));
