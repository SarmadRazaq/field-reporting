import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { check, openSettings, PERMISSIONS, request, type PermissionStatus } from 'react-native-permissions';

/**
 * Camera permission, re-checked whenever the app comes back to the
 * foreground, so a grant made in Settings works without a restart.
 */
export function useCameraPermission() {
  const [status, setStatus] = useState<PermissionStatus | 'unknown'>('unknown');

  const refresh = useCallback(() => {
    check(PERMISSIONS.ANDROID.CAMERA).then(setStatus, () => setStatus('unavailable'));
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener('change', next => next === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  /** Ask if we still may; resolves true when the camera can be used. */
  const ensure = useCallback(async () => {
    const current = await check(PERMISSIONS.ANDROID.CAMERA);
    if (current === 'granted' || current === 'limited') return true;
    if (current === 'blocked' || current === 'unavailable') {
      setStatus(current);
      return false;
    }
    const next = await request(PERMISSIONS.ANDROID.CAMERA);
    setStatus(next);
    return next === 'granted';
  }, []);

  return { status, ensure, openSettings: () => openSettings() };
}
