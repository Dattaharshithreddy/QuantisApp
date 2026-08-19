import React from 'react';
import { View, Text } from 'react-native';
import { Theme, RADIUS, SPACING } from '../theme/colors';
import { MLPrediction, NEW_CANDLES_THRESHOLD } from '../utils/mlSignal';
import { ARCHITECTURE_VERSION } from '../utils/modelConstants';

function Row({ label, value, T, color }: { label: string; value: string; T: Theme; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ color: T.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: color ?? T.textSub, fontSize: 10, fontWeight: '700' }}>{value}</Text>
    </View>
  );
}

function GroupLabel({ children, T }: { children: React.ReactNode; T: Theme }) {
  return <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, marginBottom: 4, marginTop: 10 }}>{children}</Text>;
}

// PREDICTION SOURCE CARD (highest priority per the request) — every field
// here reads directly from the live MLPrediction object that produced the
// signal currently on screen, not from a separate persisted-history fetch.
// This is deliberate: trainingStatusType, samplesAtActiveModelTraining,
// modelVersion, trainingRunNumber, candlesAtTraining, sampleCount,
// trainedAt, walkForwardAccuracy, confidence, and
// confidenceBreakdown.calibrationComponent are ALL fields that already
// existed on (or were added to) MLPrediction itself, computed inside the
// exact same trainAndPredict call that produced this prediction — so
// "which model generated this" can never be stale or mismatched against
// a concurrent call for the same symbol/timeframe.
//
// PHASE 3B REDESIGN: previously a flat list of 13 undifferentiated rows -
// "feels technical" per the brief. Now: a prominent status badge up top
// (the single most important fact - was this model new/reused/rejected),
// then three clearly grouped sections (Model Identity, Training Data,
// Performance) instead of one long list. No field added, removed, or
// recomputed - same MLPrediction fields, same values, reorganized.
export function PredictionSourceCard({ prediction, symbol, timeframe, theme: T, overallConfidence }: {
  prediction: MLPrediction; symbol: string; timeframe: string; theme: Theme;
  overallConfidence?: number;
}) {
  const statusLabel = prediction.trainingStatusType === 'trained' ? 'New Model Trained'
    : prediction.trainingStatusType === 'reused' ? 'Existing Model Reused'
    : 'Model Rejected — Previous Kept';
  const statusColor = prediction.trainingStatusType === 'trained' ? T.green
    : prediction.trainingStatusType === 'reused' ? T.amber
    : T.red;
  const statusIcon = prediction.trainingStatusType === 'trained' ? '🟢'
    : prediction.trainingStatusType === 'reused' ? '🟡'
    : '🔴';

  return (
    <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: 10, borderWidth: 1, borderColor: T.cardBorder, ...T.elev1 }}>
      <Text style={{ color: T.purple, fontSize: 10, fontWeight: '800', letterSpacing: 0.6, marginBottom: 10 }}>🔎 PREDICTION SOURCE</Text>

      {/* Status badge — the single most important fact, surfaced first */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: statusColor + '15', borderRadius: RADIUS.sm, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 4 }}>
        <Text style={{ fontSize: 13 }}>{statusIcon}</Text>
        <Text style={{ color: statusColor, fontWeight: '800', fontSize: 12, flex: 1 }}>{statusLabel}</Text>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700' }}>Active: v{prediction.modelVersion}</Text>
      </View>

      <GroupLabel T={T}>MODEL IDENTITY</GroupLabel>
      <Row label="Asset / Timeframe" value={`${symbol} · ${timeframe}`} T={T} />
      <Row label="Architecture Version" value={`v${ARCHITECTURE_VERSION}`} T={T} />
      <Row label="Training Run" value={`#${prediction.trainingRunNumber}`} T={T} />
      <Row label="Accepted Model Version" value={`v${prediction.modelVersion}`} T={T} color={T.blue} />

      <GroupLabel T={T}>TRAINING DATA</GroupLabel>
      <Row label="Model Trained On" value={prediction.samplesAtActiveModelTraining ? `${prediction.samplesAtActiveModelTraining} samples` : 'Unknown'} T={T} />
      <Row label="Current Available Samples" value={`${prediction.sampleCount} samples`} T={T} />
      <Row label="New Candles Since Training" value={prediction.newCandlesSinceLastTraining != null ? String(prediction.newCandlesSinceLastTraining) : 'n/a (first run)'} T={T} />
      <Row label="Minimum Required To Retrain" value={String(NEW_CANDLES_THRESHOLD)} T={T} />
      <Row label="Last Training Time" value={prediction.trainedAt ? new Date(prediction.trainedAt).toLocaleString() : 'Unknown'} T={T} />

      <GroupLabel T={T}>PERFORMANCE</GroupLabel>
      <Row label="Walk-Forward Accuracy" value={prediction.walkForwardAccuracy >= 0 ? `${prediction.walkForwardAccuracy.toFixed(1)}%` : 'Not enough data'} T={T} />
      <Row label="Confidence" value={`${(overallConfidence ?? prediction.confidence).toFixed(0)}/100`} T={T} />

      <View style={{ height: 1, backgroundColor: T.border, marginTop: 10, marginBottom: 8 }} />
      <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 14, fontStyle: 'italic' }}>
        {prediction.acceptRejectReason}
      </Text>
    </View>
  );
}
