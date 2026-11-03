import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { startBackgroundWork, takeBack } from './background';
import { outbox } from './outbox';
import { finishInterruptedReset } from './reset';

/**
 * Start the uploader and give it every useful wake-up signal. Connectivity is
 * only a hint: the outbox never skips work because NetInfo says "offline".
 * Returns a function that unsubscribes.
 */
export function startOutboxLifecycle(): () => void {
  const box = outbox();
  finishInterruptedReset()
    .then(() => {
      // Held until whatever a native sender did before this launch is applied (see takeBack).
      box.pause();
      return box.start();
    })
    .then(takeBack)
    .catch(e => console.error('[outbox] failed to start', e));
  const stopBackground = startBackgroundWork();

  const unsubscribeNet = NetInfo.addEventListener(state => {
    box.connectivityChanged(state.isConnected === true && state.isInternetReachable !== false);
  });
  const appState = AppState.addEventListener('change', next => {
    if (next === 'active') box.retryNow('foreground');
  });

  return () => {
    unsubscribeNet();
    appState.remove();
    stopBackground();
  };
}
