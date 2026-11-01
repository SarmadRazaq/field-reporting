import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { outbox } from './outbox';

/**
 * Start the uploader and give it every useful wake-up signal. Connectivity is
 * only a hint: the outbox never skips work because NetInfo says "offline".
 * Returns a function that unsubscribes.
 */
export function startOutboxLifecycle(): () => void {
  const box = outbox();
  box.start().catch(e => console.error('[outbox] failed to start', e));

  const unsubscribeNet = NetInfo.addEventListener(state => {
    box.connectivityChanged(state.isConnected === true && state.isInternetReachable !== false);
  });
  const appState = AppState.addEventListener('change', next => {
    if (next === 'active') box.retryNow('foreground');
  });

  return () => {
    unsubscribeNet();
    appState.remove();
  };
}
