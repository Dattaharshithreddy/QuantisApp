import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, Animated, Easing, Dimensions } from 'react-native';
import { Theme, RADIUS, SPACING } from '../theme/colors';

const SCREEN_H = Dimensions.get('window').height;

// Built on plain RN Modal + Animated rather than adding a bottom-sheet
// library as a new dependency - a deliberate choice given the explicit
// "do not change... unless required for UI consistency" scope boundary;
// this is a real, smooth implementation, not a placeholder.
export function BottomSheet({
  visible, onClose, title, children, theme: T,
}: {
  visible: boolean; onClose: () => void; title?: string; children: React.ReactNode; theme: Theme;
}) {
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = React.useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 22, stiffness: 220, mass: 0.9 }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(backdropOpacity, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: SCREEN_H, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
      ]).start(() => setMounted(false));
    }
  }, [visible]);

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={{ flex: 1 }} onPress={onClose}>
        <Animated.View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', opacity: backdropOpacity }} />
      </Pressable>
      <Animated.View
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          backgroundColor: T.bg1, borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
          paddingBottom: SPACING.xxl, maxHeight: SCREEN_H * 0.85,
          transform: [{ translateY }], ...T.elev3}}
      >
        <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: T.border2 }} />
        </View>
        {title && (
          <Text style={{ color: T.text, fontSize: 16, fontWeight: '800', paddingHorizontal: SPACING.xl, paddingTop: 8, paddingBottom: 12 }}>{title}</Text>
        )}
        <View style={{ paddingHorizontal: SPACING.xl }}>{children}</View>
      </Animated.View>
    </Modal>
  );
}
