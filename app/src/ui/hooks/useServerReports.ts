import { useQuery } from '@tanstack/react-query';
import { fetchServerReports } from '../../infra/serverApi';

export const SERVER_REPORTS_KEY = ['server-reports'] as const;

/**
 * What the server holds. On failure the last good list stays on screen
 * (with its age), instead of a spinner or an empty page.
 */
export function useServerReports() {
  return useQuery({
    queryKey: SERVER_REPORTS_KEY,
    queryFn: fetchServerReports,
    retry: 1,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}
