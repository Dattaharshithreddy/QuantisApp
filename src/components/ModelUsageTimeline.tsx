import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Theme, RADIUS, SPACING } from '../theme/colors';
import { MLPrediction } from '../utils/mlSignal';

// PHASE 3B: each step now gets a distinct icon reflecting what kind of
// event it is (request, model version, accept/reject outcome, data,
// result) instead of a uniform dot - "use icons, timeline style" per the
// brief. Connecting line refined to a continuous rule rather than a
// separate arrow glyph per step.
function Step({ icon, label, detail, T, last, accent }: { icon: string; label: string; detail: string; T: Theme; last?: boolean; accent?: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ alignItems: 'center' }}>
        <View style={{
          width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
          backgroundColor: (accent ?? T.purple) + '18', borderWidth: 1, borderColor: (accent ?? T.purple) + '40',
        }}>
          <Text style={{ fontSize: 12 }}>{icon}</Text>
        </View>
        {!last && <View style={{ width: 2, flex: 1, backgroundColor: T.border, marginTop: 2, minHeight: 16 }} />}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : 14 }}>
        <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>{label}</Text>
        <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2, lineHeight: 14 }}>{detail}</Text>
      </View>
    </View>
  );
}

// Model Usage Timeline — every step's detail text is built directly from
// real MLPrediction fields, the same ones the Prediction Source Card and
// Training Status Card already read. This component adds no new backend
// data; it's a different, lifecycle-oriented presentation of values that
// already exist.
export function ModelUsageTimeline({ prediction, theme: T }: { prediction: MLPrediction; theme: Theme }) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = prediction.trainingStatusType === 'trained' ? 'Trained' : prediction.trainingStatusType === 'reused' ? 'Reused' : 'Rejected';
  const statusIcon = prediction.trainingStatusType === 'trained' ? '✅' : prediction.trainingStatusType === 'reused' ? '♻️' : '⛔';
  const statusColor = prediction.trainingStatusType === 'trained' ? T.green : prediction.trainingStatusType === 'reused' ? T.amber : T.red;

  return (
    <View style={{ marginBottom: 10 }}>
      <TouchableOpacity onPress={() => setExpanded(v => !v)} activeOpacity={0.7} style={{ paddingVertical: 7 }}>
        <Text style={{ color: T.blue, fontSize: 10, fontWeight: '700' }}>{expanded ? '▼' : '▶'} Model Usage Timeline</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, padding: SPACING.md, borderWidth: 1, borderColor: T.cardBorder, ...T.elev1 }}>
          <Step icon="📡" label="Prediction Requested" detail={`${prediction.action} signal requested for this chart`} T={T} />
          <Step icon="🧠" label={`Model v${prediction.modelVersion}`} detail={`Architecture v1, Training Run #${prediction.trainingRunNumber}`} T={T} />
          <Step icon={statusIcon} label={statusLabel} detail={prediction.acceptRejectReason} T={T} accent={statusColor} />
          <Step icon="📊" label="Trained On" detail={`${prediction.samplesAtActiveModelTraining} samples (the model actually generating this prediction)`} T={T} />
          <Step icon="🕐" label="Current History" detail={`${prediction.sampleCount} samples available right now${prediction.sampleCount !== prediction.samplesAtActiveModelTraining ? ' — different from training count above because the model was not retrained on this exact call' : ''}`} T={T} />
          <Step icon="🎯" label="Prediction Generated" detail={`${prediction.action} · ${prediction.confidence.toFixed(0)}/100 confidence`} T={T} accent={T.blue} last />
        </View>
      )}
    </View>
  );
}
