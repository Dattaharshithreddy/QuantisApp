import React, { useEffect, useRef, useState } from 'react';
// ─────────────────────────────────────────────────────────────────────────────
// OnboardingTooltip  (v1.0.0)
//
// One-time contextual tooltip. Appears once, dismissed forever.
// Stored via onboarding.dismissTooltip(id).
// Zero render overhead when already dismissed.
// ─────────────────────────────────────────────────────────────────────────────
import { View, Text, TouchableOpacity, Animated } from 'react-native';
import { isTooltipDismissed, dismissTooltip, TooltipId } from '../utils/onboarding';
import { RADIUS, SPACING } from '../theme/colors';

type Props = {
  id:       TooltipId;
  title:    string;
  body:     string;
  T:        any;
  position?: 'above' | 'below';
  children: React.ReactNode;   // the component the tooltip anchors to
};

export function OnboardingTooltip({ id, title, body, T, position = 'below', children }: Props) {
  const [visible,  setVisible]  = useState(false);
  const [checked,  setChecked]  = useState(false);
  const opacity = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    isTooltipDismissed(id).then(dismissed => {
      setChecked(true);
      if (!dismissed) {
        setVisible(true);
        Animated.timing(opacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();
      }
    }).catch(() => setChecked(true));
  }, [id]);

  function handleDismiss() {
    Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true })
      .start(() => setVisible(false));
    dismissTooltip(id).catch(() => {});
  }

  if (!checked) return <>{children}</>;

  return (
    <View>
      {position === 'below' && children}
      {visible && (
        <Animated.View style={{
          opacity,
          backgroundColor: T.accent,
          borderRadius: RADIUS.md,
          padding: SPACING.sm,
          marginTop: position === 'below' ? 6 : 0,
          marginBottom: position === 'above' ? 6 : 0,
          // Accessibility
          accessibilityLiveRegion: 'polite'}}>
          {/* Arrow indicator */}
          {position === 'below' && (
            <View style={{
              position: 'absolute', top: -6, left: 20,
              width: 0, height: 0,
              borderLeftWidth: 6, borderRightWidth: 6, borderBottomWidth: 6,
              borderLeftColor: 'transparent', borderRightColor: 'transparent',
              borderBottomColor: T.accent}} />
          )}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between',
            alignItems: 'flex-start' }}>
            <View style={{ flex: 1, marginRight: 8 }}>
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800',
                marginBottom: 3 }}>{title}</Text>
              <Text style={{ color: '#ffffffcc', fontSize: 11, lineHeight: 16 }}>
                {body}
              </Text>
            </View>
            <TouchableOpacity onPress={handleDismiss}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Dismiss tip"
              accessibilityRole="button"
              style={{ width: 20, height: 20, borderRadius: 10,
                backgroundColor: 'rgba(255,255,255,0.2)',
                justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>✕</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}
      {position === 'above' && children}
    </View>
  );
}
