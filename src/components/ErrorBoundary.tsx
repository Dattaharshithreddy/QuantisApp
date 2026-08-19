import React from 'react';
import { Text, TouchableOpacity, ScrollView, View } from 'react-native';
import { captureRenderError } from '../utils/crashReporter';
import { BUILD_VERSION } from '../buildInfo';

type Props  = { children: React.ReactNode; fallbackLabel?: string };
type State  = { error: Error | null; errorId: string | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, errorId: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const id = `eb_${Date.now()}`;
    this.setState({ errorId: id });
    // Persist + optionally forward to Sentry
    captureRenderError(error, info.componentStack ?? '');
    console.error('[ErrorBoundary]', error.message, info.componentStack);
  }

  render() {
    const { error, errorId } = this.state;
    if (error) {
      return (
        <ScrollView
          style={{ flex: 1, backgroundColor: '#131722' }}
          contentContainerStyle={{ padding: 24, paddingTop: 60 }}>
          <Text style={{ fontSize: 36, marginBottom: 16 }}>⚠️</Text>
          <Text style={{ color: '#ef5350', fontSize: 16, fontWeight: '800', marginBottom: 8 }}>
            {this.props.fallbackLabel ?? 'Something went wrong on this screen'}
          </Text>
          <Text style={{ color: '#d1d4dc', fontSize: 12, lineHeight: 18, marginBottom: 16 }}>
            {error.message}
          </Text>
          {/* Error ID for support reference */}
          {errorId && (
            <View style={{ backgroundColor: '#1e222d', borderRadius: 6,
              padding: 10, marginBottom: 16 }}>
              <Text style={{ color: '#787b86', fontSize: 10 }}>
                Crash ID: {errorId}{'\n'}Build: v{BUILD_VERSION}
              </Text>
            </View>
          )}
          <Text style={{ color: '#787b86', fontSize: 9, lineHeight: 14, marginBottom: 20 }}>
            {error.stack?.slice(0, 500)}
          </Text>
          <Text style={{ color: '#787b86', fontSize: 9, marginBottom: 20, lineHeight: 14 }}>
            This crash has been recorded automatically. If this persists,
            note the Crash ID above and contact support.
          </Text>
          <TouchableOpacity
            onPress={() => this.setState({ error: null, errorId: null })}
            style={{ backgroundColor: '#2962ff', padding: 14,
              borderRadius: 8, alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
              Try Again
            </Text>
          </TouchableOpacity>
        </ScrollView>
      );
    }
    return this.props.children;
  }
}
