import React from 'react';
import { Text, TouchableOpacity, ScrollView } from 'react-native';

type Props = { children: React.ReactNode; fallbackLabel?: string };
type State = { error: Error | null };

// Wraps a screen so that if a JS render error occurs, the app shows a readable
// error message instead of crashing/closing silently — critical in release
// builds, where the default red-box error overlay is disabled and an uncaught
// error otherwise just kills the app with no diagnostic shown to the user.
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: any) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <ScrollView style={{ flex: 1, backgroundColor: '#131722' }} contentContainerStyle={{ padding: 24, paddingTop: 60 }}>
          <Text style={{ fontSize: 40, marginBottom: 16 }}>⚠️</Text>
          <Text style={{ color: '#ef5350', fontSize: 16, fontWeight: '800', marginBottom: 10 }}>
            {this.props.fallbackLabel || 'Something went wrong on this screen'}
          </Text>
          <Text style={{ color: '#d1d4dc', fontSize: 12, lineHeight: 18, marginBottom: 20 }}>
            {this.state.error.message}
          </Text>
          <Text style={{ color: '#787b86', fontSize: 10, lineHeight: 15, marginBottom: 20 }}>
            {this.state.error.stack}
          </Text>
          <TouchableOpacity onPress={() => this.setState({ error: null })} style={{ backgroundColor: '#2962ff', padding: 12, borderRadius: 8, alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>Try Again</Text>
          </TouchableOpacity>
        </ScrollView>
      );
    }
    return this.props.children;
  }
}
