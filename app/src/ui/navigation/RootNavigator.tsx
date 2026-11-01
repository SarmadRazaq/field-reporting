import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { NewReportScreen } from '../screens/NewReportScreen';
import { ReportDetailScreen } from '../screens/ReportDetailScreen';
import { ReportsScreen } from '../screens/ReportsScreen';
import { SentReportScreen } from '../screens/SentReportScreen';
import { SentScreen } from '../screens/SentScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { color } from '../theme';
import { TabBar } from './TabBar';
import type { RootParams, TabParams } from './types';

const Stack = createNativeStackNavigator<RootParams>();
const Tab = createBottomTabNavigator<TabParams>();

const theme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: color.bg, primary: color.brand } };

function Tabs() {
  return (
    <Tab.Navigator tabBar={props => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Reports" component={ReportsScreen} />
      <Tab.Screen name="Sent" component={SentScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export function RootNavigator() {
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }}>
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="NewReport" component={NewReportScreen} options={{ animation: 'slide_from_bottom', gestureEnabled: false }} />
        <Stack.Screen name="ReportDetail" component={ReportDetailScreen} />
        <Stack.Screen name="SentReport" component={SentReportScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
