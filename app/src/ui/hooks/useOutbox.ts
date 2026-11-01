import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { Outbox } from '../../core/outbox';
import type { OutboxSnapshot } from '../../core/types';

const OutboxContext = createContext<Outbox | null>(null);

/**
 * Hands the screens their outbox. The app passes the real one; tests pass one
 * built over fakes. Screens never import infra to reach it.
 */
export function OutboxProvider({ outbox, children }: { outbox: Outbox; children: ReactNode }) {
  return createElement(OutboxContext.Provider, { value: outbox }, children);
}

/** The outbox's commands (retry, send first, drafts…). */
export function useOutboxCommands(): Outbox {
  const box = useContext(OutboxContext);
  if (!box) throw new Error('useOutboxCommands needs an <OutboxProvider>');
  return box;
}

/** The outbox's current state; re-renders on every change. */
export function useOutbox(): OutboxSnapshot {
  const box = useOutboxCommands();
  return useSyncExternalStore(box.subscribe, box.getSnapshot);
}
