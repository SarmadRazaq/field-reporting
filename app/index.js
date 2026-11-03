/**
 * @format
 */

import { AppRegistry } from 'react-native';
import BackgroundFetch from 'react-native-background-fetch';
import App from './App';
import { name as appName } from './app.json';
import { headlessTask } from './src/infra/background';

AppRegistry.registerComponent(appName, () => App);
// Android wakes this when the app's process was killed with reports still waiting.
BackgroundFetch.registerHeadlessTask(headlessTask);
// Held open by the native upload service while it runs, so JS timers (and with them
// fetch replies, retries and timeouts) keep working in the background. Native finishes it.
AppRegistry.registerHeadlessTask('FieldReportsKeepAlive', () => () => new Promise(() => {}));
