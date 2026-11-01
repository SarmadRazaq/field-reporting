import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps, NavigatorScreenParams } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type TabParams = {
  Reports: undefined;
  Sent: undefined;
  Settings: undefined;
};

export type RootParams = {
  Tabs: NavigatorScreenParams<TabParams>;
  NewReport: undefined;
  ReportDetail: { id: string };
  SentReport: { id: string };
};

export type RootScreenProps<K extends keyof RootParams> = NativeStackScreenProps<RootParams, K>;
export type TabScreenProps<K extends keyof TabParams> = CompositeScreenProps<
  BottomTabScreenProps<TabParams, K>,
  NativeStackScreenProps<RootParams>
>;
