import { useSyncExternalStore } from 'react';
import { lastResetResult, resetProgress } from '../../infra/reset';

/** Where a running Start over stands, and how the last one ended; both outlive the screen that started it. */
export function useReset() {
  const progress = useSyncExternalStore(resetProgress.subscribe, resetProgress.get);
  // Re-read on every notification (a reset finished, or its outcome was dismissed).
  const result = useSyncExternalStore(resetProgress.subscribe, lastResetSnapshot);
  return { progress, result };
}

let cachedKey = '';
let cached: ReturnType<typeof lastResetResult> = null;

/** useSyncExternalStore needs the same object back while nothing changed. */
function lastResetSnapshot() {
  const next = lastResetResult();
  const key = JSON.stringify(next);
  if (key !== cachedKey) {
    cachedKey = key;
    cached = next;
  }
  return cached;
}
