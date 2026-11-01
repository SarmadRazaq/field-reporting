import type { EncodeStep, FileStore, ImageEncoder } from './ports';
import { DeliveryError } from './retry';
import { LIMITS, type LocalImage, type ProcessedImage } from './types';

/**
 * Steps tried in order until the JPEG fits. The first one keeps a 4096 px long
 * edge at high quality; 18 MB camera originals land around 2–4 MB here, which
 * is plenty to read a serial plate or a crack width. Later steps only kick in
 * for unusually detailed scenes.
 */
export const QUALITY_LADDER: readonly EncodeStep[] = [
  { maxEdge: 4096, quality: 85 },
  { maxEdge: 4096, quality: 75 },
  { maxEdge: 3072, quality: 80 },
  { maxEdge: 2560, quality: 75 },
  { maxEdge: 2048, quality: 70 },
  { maxEdge: 1600, quality: 70 },
];

/** A photo that crashed or failed the encoder this many times is given up on. */
export const MAX_PROCESSING_ATTEMPTS = 3;

export const photoPaths = (dir: string, imageId: string) => ({
  source: `${dir}/${imageId}.src`,
  tmp: `${dir}/${imageId}.tmp.jpg`,
  final: `${dir}/${imageId}.jpg`,
});

/**
 * Re-encode one photo down the ladder until it is under the target size, then hash it.
 * Output goes to a temp file and is moved into place only once complete, so a
 * kill at any point leaves either nothing or a finished file behind.
 */
export async function processPhoto(
  image: LocalImage,
  deps: { files: FileStore; encoder: ImageEncoder; position: number },
): Promise<ProcessedImage> {
  const { files, encoder, position } = deps;
  const paths = photoPaths(files.photosDir, image.id);
  const label = `Photo ${position + 1}`;

  if (!image.sourcePath || (await files.size(image.sourcePath)) === null)
    throw new DeliveryError({
      type: 'permanent',
      problem: { code: 'photo_missing', message: `${label} is no longer on this phone`, imageId: image.id },
    });

  const out = await encoder.encodeToFit({
    src: image.sourcePath,
    dest: paths.tmp,
    steps: QUALITY_LADDER,
    maxBytes: LIMITS.targetImageBytes,
  });
  // Trust the encoder's verdict, but check its arithmetic against the file it wrote.
  const written = out.kind === 'ok' ? await files.size(paths.tmp) : null;
  if (out.kind !== 'ok' || written === null || written > LIMITS.targetImageBytes) {
    await files.remove(paths.tmp);
    throw new DeliveryError({
      type: 'permanent',
      problem: {
        code: 'photo_unreadable',
        message:
          out.kind === 'unreadable'
            ? `${label} could not be read as an image`
            : `${label} could not be made small enough to send`,
        imageId: image.id,
      },
    });
  }
  const sha256 = await files.sha256(paths.tmp);
  await files.move(paths.tmp, paths.final);
  return { path: paths.final, size: written, sha256, width: out.width, height: out.height };
}
