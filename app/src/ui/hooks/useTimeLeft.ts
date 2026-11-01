import { useEffect, useRef, useState } from 'react';
import type { Activity } from '../../core/types';

const WINDOW_MS = 30_000;

/**
 * Estimate of the time left for the report being sent, from the last 30 s of
 * progress. Null until there is enough data to say anything honest.
 */
export function useTimeLeft(activity: Activity | null): number | null {
  const samples = useRef<{ at: number; bytes: number; reportId: string }[]>([]);
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (!activity || activity.stage !== 'uploading') {
      samples.current = [];
      setLeft(null);
      return;
    }
    const now = Date.now();
    const list = samples.current.filter(s => s.reportId === activity.reportId && now - s.at <= WINDOW_MS);
    list.push({ at: now, bytes: activity.bytesSent, reportId: activity.reportId });
    samples.current = list;
    const first = list[0]!;
    const elapsed = (now - first.at) / 1000;
    const moved = activity.bytesSent - first.bytes;
    setLeft(elapsed >= 5 && moved > 0 ? ((activity.bytesTotal - activity.bytesSent) / (moved / elapsed)) * 1000 : null);
  }, [activity]);

  return left;
}
