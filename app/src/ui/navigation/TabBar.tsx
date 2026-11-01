import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../components/Icon';
import { color, radius, space, type } from '../theme';

const ICONS: Record<string, IconName> = { Reports: 'list', Sent: 'cloudCheck', Settings: 'sliders' };

/** Three tabs: what is on this phone, what the server holds, and settings. */
export function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingBottom: Math.max(insets.bottom, space[2]) }]}>
      <View style={styles.bar} accessibilityRole="tablist">
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const tint = focused ? color.brand : color.muted;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={route.name}
              onPress={() => {
                const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
              }}
              android_ripple={{ color: color.bg2, borderless: true }}
              style={styles.tab}
            >
              <Icon name={ICONS[route.name] ?? 'list'} size={22} color={tint} />
              <Text style={[type.tab, { color: tint, fontFamily: focused ? type.tab.fontFamily : 'Geist-Medium' }]}>
                {route.name}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: color.bg, paddingHorizontal: space[3], paddingTop: space[2] },
  bar: {
    flexDirection: 'row',
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    padding: 6,
  },
  tab: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 3 },
});
