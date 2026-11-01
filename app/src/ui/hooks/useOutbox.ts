import { useSyncExternalStore } from 'react';
import { outbox } from '../../infra/outbox';
import type { OutboxSnapshot } from '../../core/types';

/** The outbox's current state; re-renders on every change. */
export function useOutbox(): OutboxSnapshot {
  const box = outbox();
  return useSyncExternalStore(box.subscribe, box.getSnapshot);
}
