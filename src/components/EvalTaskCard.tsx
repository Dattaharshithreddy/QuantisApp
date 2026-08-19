import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useEvalTasks, EvalTask } from '../context/EvalTaskContext';
import { RADIUS } from '../theme/colors';

// Compact floating card shown whenever a background eval/optimizer task
// is running. Appears at the bottom of whatever screen the user is on.
// Tapping it navigates back to ProductionEvaluationScreen.
// Cancellation requires an explicit confirmation dialog.

function formatMs(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function TaskRow({ task, onCancel, onNavigate }: {
  task: EvalTask;
  onCancel: (id: string) => void;
  onNavigate: () => void;
}) {
  const { theme: T } = useTheme();
  const pct = task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0;
  const label = task.type === 'evaluation' ? 'Production Evaluation' : 'Optimizer';
  const symbolLabel = task.symbol.length > 20 ? task.symbol.slice(0, 18) + '…' : task.symbol;

  const handleCancel = () => {
    Alert.alert(
      `Cancel ${label}?`,
      'Progress will be lost.',
      [
        { text: 'Keep Running', style: 'cancel' },
        { text: 'Cancel Task', style: 'destructive', onPress: () => onCancel(task.id) },
      ]
    );
  };

  return (
    <TouchableOpacity
      onPress={onNavigate}
      activeOpacity={0.85}
      style={{
        backgroundColor: T.bg1,
        borderRadius: RADIUS.md,
        padding: 10,
        marginBottom: 6,
        borderWidth: 1,
        borderColor: T.accent + '40',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10}}
    >
      {/* Pulsing accent dot */}
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: T.accent }} />

      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>{label}</Text>
          <Text style={{ color: T.accent, fontSize: 11, fontWeight: '700' }}>{pct}%</Text>
        </View>
        <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>
          {symbolLabel} · {task.timeframe} · {formatMs(task.elapsedMs)} elapsed
          {task.etaMs ? ` · ~${formatMs(task.etaMs)} remaining` : ''}
        </Text>
        {/* Progress bar */}
        <View style={{ height: 3, backgroundColor: T.bg3, borderRadius: 2, marginTop: 5, overflow: 'hidden' }}>
          <View style={{ height: 3, width: `${pct}%`, backgroundColor: T.accent, borderRadius: 2 }} />
        </View>
      </View>

      {/* Cancel button */}
      <TouchableOpacity onPress={handleCancel} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={{ color: T.textDim, fontSize: 16, lineHeight: 16 }}>✕</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

export function EvalTaskFloatingCard({ onNavigateToEval }: { onNavigateToEval: () => void }) {
  const { runningTasks, cancelTask } = useEvalTasks();
  const { theme: T } = useTheme();

  if (!runningTasks.length) return null;

  return (
    <View style={{
      position: 'absolute', bottom: 90, left: 16, right: 16, zIndex: 999}}>
      {runningTasks.map(task => (
        <TaskRow
          key={task.id}
          task={task}
          onCancel={cancelTask}
          onNavigate={onNavigateToEval}
        />
      ))}
    </View>
  );
}
