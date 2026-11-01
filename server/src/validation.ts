import { createHash } from 'node:crypto';
import { LIMITS } from './limits.js';

export interface ManifestImage {
  id: string;
  sha256: string;
  size: number;
  mime: string;
}

export interface Manifest {
  description: string;
  createdAt: string;
  images: ManifestImage[];
}

export type Validation =
  | { ok: true; manifest: Manifest }
  | { ok: false; status: 413 | 422; code: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const fail = (code: string, message: string, status: 413 | 422 = 422): Validation => ({
  ok: false,
  status,
  code,
  message,
});

export function validateManifest(body: unknown): Validation {
  if (typeof body !== 'object' || body === null) return fail('invalid_body', 'Expected a JSON object');
  const { description, createdAt, images } = body as Record<string, unknown>;

  if (typeof description !== 'string' || description.trim().length === 0)
    return fail('description_required', 'Description must not be blank');
  if (description.length > LIMITS.maxDescriptionChars)
    return fail('description_too_long', `Description is over ${LIMITS.maxDescriptionChars} characters`);
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)))
    return fail('invalid_created_at', 'createdAt must be an ISO date');
  if (!Array.isArray(images)) return fail('invalid_images', 'images must be an array');
  if (images.length < LIMITS.minImages || images.length > LIMITS.maxImages)
    return fail('image_count', `A report needs ${LIMITS.minImages}–${LIMITS.maxImages} images, got ${images.length}`);

  const parsed: ManifestImage[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of images.entries()) {
    const img = raw as Record<string, unknown>;
    if (!isId(img?.id)) return fail('invalid_image_id', `images[${i}].id must be a UUID`);
    if (seen.has(img.id)) return fail('duplicate_image_id', `images[${i}].id is repeated`);
    seen.add(img.id);
    if (typeof img.sha256 !== 'string' || !SHA256.test(img.sha256))
      return fail('invalid_sha256', `images[${i}].sha256 must be lowercase hex`);
    if (typeof img.size !== 'number' || !Number.isInteger(img.size) || img.size <= 0)
      return fail('invalid_size', `images[${i}].size must be a positive integer`);
    if (img.size > LIMITS.maxImageBytes)
      return fail('image_too_large', `images[${i}] is ${img.size} bytes; the limit is ${LIMITS.maxImageBytes}`, 413);
    if (!(LIMITS.acceptedMime as readonly string[]).includes(img.mime as string))
      return fail('unsupported_mime', `images[${i}].mime must be one of ${LIMITS.acceptedMime.join(', ')}`);
    parsed.push({ id: img.id, sha256: img.sha256, size: img.size, mime: img.mime as string });
  }

  return { ok: true, manifest: { description: description.trim(), createdAt, images: parsed } };
}

/** Stable fingerprint, so a repeated PUT can be told apart from a conflicting one. */
export function manifestHash(m: Manifest): string {
  const canonical = JSON.stringify([m.description, m.createdAt, m.images.map(i => [i.id, i.sha256, i.size, i.mime])]);
  return createHash('sha256').update(canonical).digest('hex');
}
