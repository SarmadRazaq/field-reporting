import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { freeBytes, STORAGE } from '../../infra/deviceStorage';

export type SpaceLevel = 'ok' | 'low' | 'full';

/** How much room is left for photos, re-checked on focus and after each add. */
export function useFreeSpace() {
  const [level, setLevel] = useState<SpaceLevel>('ok');

  const refresh = useCallback(async () => {
    const free = await freeBytes();
    setLevel(free === null || free >= STORAGE.lowBytes ? 'ok' : free >= STORAGE.fullBytes ? 'low' : 'full');
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', s => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  return { level, refresh };
}
