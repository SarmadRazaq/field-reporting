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
