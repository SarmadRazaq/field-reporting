/**
 * The domain of the outbox. Everything here is plain data, persisted as-is,
 * so the app can be killed between any two writes and resume from disk.
 */

export const LIMITS = {
  minImages: 1,
  maxImages: 5,
  /** Hard ceiling at the destination: 5 MB read the strict way (decimal), also below 5 MiB. */
  maxImageBytes: 5_000_000,
  /** What the encoder aims for, leaving headroom under the ceiling. */
  targetImageBytes: 4_800_000,
  maxDescriptionChars: 2000,
} as const;

/**
 * draft            being composed; never touched by the uploader
 * queued           saved on the phone, nothing done yet
 * processing       photos being resized/re-encoded
 * uploading        manifest and photo bytes going to the server
 * committing       all bytes sent; asking the server to make it visible
 * uploaded         the server confirmed the commit
 * needs_attention  the server (or the photo itself) refused; retrying would not help
 */
export type ReportState =
  | 'draft'
  | 'queued'
  | 'processing'
  | 'uploading'
  | 'committing'
  | 'uploaded'
  | 'needs_attention';

export const PENDING_STATES: readonly ReportState[] = ['queued', 'processing', 'uploading', 'committing'];

export interface ProcessedImage {
  path: string;
  size: number;
  sha256: string;
  width: number;
  height: number;
}

export interface LocalImage {
  id: string;
  /** App-owned copy of what the user picked. Dropped once processed. */
  sourcePath: string | null;
  sourceBytes: number;
  processed: ProcessedImage | null;
  /** Bumped before each attempt, so a photo that crashes the encoder can't crash-loop the app. */
  processingAttempts: number;
  /** Last offset the server confirmed. Display only; the server's answer is always the truth. */
  uploadedBytes: number;
}

export type ProblemCode =
  | 'refused'
  | 'too_large'
  | 'forbidden'
  | 'conflict'
  | 'invalid'
  | 'photo_unreadable'
  | 'photo_missing'
  | 'corrupted_repeatedly';

/** Why a report stopped and will not continue without the user. */
export interface Problem {
  code: ProblemCode;
  message: string;
  status?: number;
  imageId?: string;
}

export type TransientReason = 'offline' | 'timeout' | 'server' | 'busy' | 'rate_limited';

/** Why the last attempt failed, while we keep retrying on our own. */
export interface TransientIssue {
  reason: TransientReason;
  message: string;
  at: number;
}

export interface LocalReport {
  id: string;
  description: string;
  /** Set when the report is submitted. */
  createdAt: string | null;
  updatedAt: number;
  state: ReportState;
  images: LocalImage[];
  /** Consecutive failed attempts, for backoff. */
  attempts: number;
  nextAttemptAt: number | null;
  lastIssue: TransientIssue | null;
  problem: Problem | null;
  uploadedAt: string | null;
}

export type Stage = 'processing' | 'uploading' | 'committing';

/** What the uploader is doing right now. In memory only. */
export interface Activity {
  reportId: string;
  stage: Stage;
  /** Zero-based index of the photo being worked on. */
  imageIndex: number;
  imageCount: number;
  bytesSent: number;
  bytesTotal: number;
}

export interface OutboxSnapshot {
  ready: boolean;
  reports: readonly LocalReport[];
  activity: Activity | null;
}
