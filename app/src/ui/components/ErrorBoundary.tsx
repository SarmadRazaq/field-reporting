import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { color, space, type } from '../theme';
import { Button } from './Button';

/**
 * A render bug should never look like lost work. Reports live in the database,
 * not in React, so this can say so truthfully and let the user carry on.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[ui] render error', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={styles.root}>
        <Text style={[type.h2, { color: color.ink }]}>This screen hit a problem</Text>
        <Text style={[type.body, { color: color.soft }]}>
          Your reports are stored on this phone and keep sending in the background. Nothing was lost.
        </Text>
        <Button label="Try again" onPress={() => this.setState({ error: null })} />
      </View>
    );
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: space[5], gap: space[4], backgroundColor: color.bg },
});
