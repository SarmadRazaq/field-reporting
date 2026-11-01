import { useCallback, useEffect, useRef, useState } from 'react';
import { outbox } from '../../infra/outbox';
import type { LocalReport } from '../../core/types';
import { useOutbox } from './useOutbox';

const SAVE_DESCRIPTION_MS = 400;

/**
 * The report being composed. The description is kept locally while typing and
 * written to the database shortly after, so a force-quit loses at most a
 * fraction of a second of typing. Photos are copied in as soon as they're added.
 */
export function useDraft() {
  const snapshot = useOutbox();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [description, setDescriptionState] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    outbox()
      .startDraft()
      .then(d => {
        if (cancelled) return;
        setDraftId(d.id);
        setDescriptionState(d.description);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const draft: LocalReport | undefined = snapshot.reports.find(r => r.id === draftId && r.state === 'draft');

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const text = pending.current;
    pending.current = null;
    if (draftId && text !== null) await outbox().setDescription(draftId, text);
  }, [draftId]);

  const setDescription = useCallback(
    (text: string) => {
      setDescriptionState(text);
      pending.current = text;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DESCRIPTION_MS);
    },
    [flush],
  );

  useEffect(() => () => void flush(), [flush]);

  return { draft, description, setDescription, flush };
}
