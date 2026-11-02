import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { batteryOptimisation } from '../../infra/uploadService';

/**
 * Whether battery saver (Doze) can hold back background sending, re-checked
 * when the app returns from the system dialog. Null until known.
 */
export function useBatteryExemption() {
  const [exempt, setExempt] = useState<boolean | null>(null);

  const refresh = useCallback(() => {
    batteryOptimisation.isExempt().then(setExempt, () => setExempt(null));
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', s => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  return { exempt, request: batteryOptimisation.requestExemption };
}
