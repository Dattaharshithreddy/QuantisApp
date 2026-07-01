import React from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable } from 'react-native';
import { Theme, RADIUS, SPACING } from '../theme/colors';

export type DialogAction = { label: string; onPress: () => void; destructive?: boolean; primary?: boolean };

// Centered confirm/alert dialog. Follows the same shape as a native iOS
// alert / Material 3 dialog: title, message, up to a few stacked or
// side-by-side actions. `onRequestClose` (back button / backdrop tap)
// defaults to a no-op so confirmation dialogs for destructive actions
// can't be dismissed accidentally without the caller opting in.
export function ConfirmDialog({
  visible, title, message, actions, theme: T, onRequestClose,
}: {
  visible: boolean; title: string; message?: string; actions: DialogAction[]; theme: Theme; onRequestClose?: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: SPACING.xl }}
        onPress={onRequestClose}
      >
        <Pressable
          onPress={() => {}}
          style={{ width: '100%', maxWidth: 360, backgroundColor: T.card, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.xl, ...T.elev3 }}
        >
          <Text style={{ color: T.text, fontSize: 17, fontWeight: '800', marginBottom: message ? 8 : 16, textAlign: 'center' }}>{title}</Text>
          {message && <Text style={{ color: T.textSub, fontSize: 13, lineHeight: 19, marginBottom: 20, textAlign: 'center' }}>{message}</Text>}
          <View style={{ gap: 8 }}>
            {actions.map((a, i) => (
              <TouchableOpacity
                key={i}
                onPress={a.onPress}
                activeOpacity={0.75}
                style={{
                  paddingVertical: 13, borderRadius: RADIUS.md, alignItems: 'center',
                  backgroundColor: a.primary ? T.accent : a.destructive ? T.red + '15' : T.bg3,
                }}
              >
                <Text style={{ color: a.primary ? '#fff' : a.destructive ? T.red : T.text, fontWeight: '700', fontSize: 14 }}>{a.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
