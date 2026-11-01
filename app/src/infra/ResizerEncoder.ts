import ImageResizer from '@bam.tech/react-native-image-resizer';
import ReactNativeBlobUtil from 'react-native-blob-util';
import type { EncodeRequest, ImageEncoder } from '../core/ports';
import { DIRS, ensureDir } from './BlobFileStore';

const { fs } = ReactNativeBlobUtil;

/**
 * Native decode/scale/encode, off the JS thread. The library subsamples on
 * decode (inSampleSize), applies EXIF orientation, and drops metadata,
 * including GPS, because keepMeta is false.
 */
export class ResizerEncoder implements ImageEncoder {
  async encodeJpeg({ src, dest, maxEdge, quality }: EncodeRequest) {
    await ensureDir(DIRS.encoder);
    const out = await ImageResizer.createResizedImage(
      `file://${src}`,
      maxEdge,
      maxEdge,
      'JPEG',
      quality,
      0,
      DIRS.encoder,
      false,
      { mode: 'contain', onlyScaleDown: true },
    );
    if (await fs.exists(dest)) await fs.unlink(dest);
    await fs.mv(out.path, dest);
    return { size: Number((await fs.stat(dest)).size), width: out.width, height: out.height };
  }
}
