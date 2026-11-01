import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { startOutboxLifecycle } from './src/infra/lifecycle';
import { ErrorBoundary } from './src/ui/components/ErrorBoundary';
import { RootNavigator } from './src/ui/navigation/RootNavigator';

const queryClient = new QueryClient();

export default function App() {
  useEffect(() => startOutboxLifecycle(), []);
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar barStyle="dark-content" />
        <ErrorBoundary>
          <RootNavigator />
        </ErrorBoundary>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
