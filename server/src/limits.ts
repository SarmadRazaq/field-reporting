/**
 * Limits the server enforces as a backstop. The app enforces the same numbers
 * on its own; the server exists to catch a client that gets it wrong.
 */
export const LIMITS = {
  /** "5 MB" read the strict way: decimal megabytes, which is also below 5 MiB. */
  maxImageBytes: 5_000_000,
  minImages: 1,
  maxImages: 5,
  maxDescriptionChars: 2000,
  acceptedMime: ['image/jpeg'] as const,
} as const;

/** Uncommitted uploads older than this are garbage-collected. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
