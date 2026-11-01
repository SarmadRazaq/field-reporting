import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { startOutboxLifecycle } from './src/infra/lifecycle';
import { outbox } from './src/infra/outbox';
import { ErrorBoundary } from './src/ui/components/ErrorBoundary';
import { OutboxProvider } from './src/ui/hooks/useOutbox';
import { RootNavigator } from './src/ui/navigation/RootNavigator';

const queryClient = new QueryClient();

export default function App() {
  useEffect(() => startOutboxLifecycle(), []);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <OutboxProvider outbox={outbox()}>
          {/* Light theme by design: it reads best outdoors in daylight. */}
          <StatusBar barStyle="dark-content" />
          <ErrorBoundary>
            <RootNavigator />
          </ErrorBoundary>
        </OutboxProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
