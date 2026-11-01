import { useQuery } from '@tanstack/react-query';
import { fetchServerReports } from '../../infra/serverApi';
import { PENDING_STATES } from '../../core/types';
import { useOutbox } from './useOutbox';

export const SERVER_REPORTS_KEY = ['server-reports'] as const;

/** True while reports are waiting on this phone: the link belongs to them. */
export function useUploadsWaiting(): boolean {
  return useOutbox().reports.some(r => PENDING_STATES.includes(r.state));
}

/**
 * What the server holds. On failure the last good list stays on screen
 * (with its age), instead of a spinner or an empty page. While reports are
 * waiting to go, it never refreshes by itself: on 2G every byte spent here is
 * a byte not spent sending.
 */
export function useServerReports() {
  const waiting = useUploadsWaiting();
  return useQuery({
    queryKey: SERVER_REPORTS_KEY,
    queryFn: fetchServerReports,
    retry: 1,
    staleTime: 15_000,
    refetchInterval: waiting ? false : 60_000,
    refetchOnMount: waiting ? false : true,
  });
}
