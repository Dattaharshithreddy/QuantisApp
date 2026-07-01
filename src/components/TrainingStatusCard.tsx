import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Modal } from 'react-native';
import { Theme } from '../theme/colors';
import { getLatestTrainingStatus, getTrainingHistory, TrainingStatusInfo, TrainingStatusType } from '../utils/trainingHistory';
import { getSampleHistory, SampleHistoryEntry } from '../utils/sampleHistory';

const STATUS_META: Record<TrainingStatusType, { icon: string; label: string; color: (T: Theme) => string }> = {
  trained: { icon: '🟢', label: 'New Model Trained', color: (T) => T.green },
  reused: { icon: '🟡', label: 'Existing Model Reused', color: (T) => T.amber },
  skipped: { icon: '🔵', label: 'Training Skipped', color: (T) => T.blue },
  rejected: { icon: '🔴', label: 'New Model Rejected', color: (T) => T.red },
  failed: { icon: '🔴', label: 'Training Failed', color: (T) => T.red },
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function fmtPct(v: number | null): string {
  return v == null ? 'n/a' : `${v.toFixed(1)}%`;
}
function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function Row({ label, value, T, color }: { label: string; value: string; T: Theme; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
      <Text style={{ color: T.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: color ?? T.textSub, fontSize: 10, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}

export function TrainingStatusCard({ symbol, timeframe, theme: T, refreshKey }: { symbol: string; timeframe: string; theme: Theme; refreshKey?: any }) {
  const [latest, setLatest] = useState<TrainingStatusInfo | null>(null);
  const [history, setHistory] = useState<TrainingStatusInfo[]>([]);
  const [sampleHist, setSampleHist] = useState<SampleHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showSamples, setShowSamples] = useState(false);
  const [detailRow, setDetailRow] = useState<TrainingStatusInfo | null>(null);

  const refresh = useCallback(() => {
    getLatestTrainingStatus(symbol, timeframe).then(setLatest);
    getTrainingHistory(symbol, timeframe).then(setHistory);
    getSampleHistory(symbol, timeframe).then(setSampleHist);
  }, [symbol, timeframe]);

  // Re-fetches on symbol/timeframe change AND whenever refreshKey changes
  // (the parent passes ml.data so this updates the instant a new
  // trainAndPredict call completes, not just on mount).
  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  if (!latest) {
    return (
      <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: T.cardBorder }}>
        <Text style={{ color: T.textDim, fontSize: 10 }}>No training has been attempted yet for {symbol}/{timeframe}.</Text>
      </View>
    );
  }

  const meta = STATUS_META[latest.type];
  const statusColor = meta.color(T);

  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: T.cardBorder, ...T.elev1 }}>
        <Text style={{ color: T.purple, fontSize: 9, fontWeight: '700', marginBottom: 8, letterSpacing: 0.4 }}>
          📋 ARCHITECTURE v{latest.architectureVersion} · TRAINING RUN #{latest.trainingRunNumber ?? 'n/a'} · ACCEPTED MODEL #{latest.newVersion ?? latest.previousVersion ?? 'n/a'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: statusColor + '15', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 10 }}>
          <Text style={{ fontSize: 12 }}>{meta.icon}</Text>
          <Text style={{ color: statusColor, fontSize: 13, fontWeight: '800' }}>{meta.label}</Text>
        </View>

        {latest.type === 'trained' && (
          <View>
            <Row label="Previous Version → New Version" value={`v${latest.previousVersion ?? '—'} → v${latest.newVersion}`} T={T} color={T.green} />
            <Row label="Old Accuracy → New Accuracy" value={`${fmtPct(latest.previousAccuracy)} → ${fmtPct(latest.newAccuracy)}`} T={T} />
            <Row label="Samples Used" value={String(latest.samplesUsed)} T={T} />
            <Row label="Training Time" value={fmtDuration(latest.durationMs)} T={T} />
          </View>
        )}
        {latest.type === 'reused' && (
          <View>
            <Row label="Current Version" value={`v${latest.previousVersion ?? latest.newVersion ?? '—'}`} T={T} />
            <Row label="Current Samples Available" value={String(latest.currentSamples)} T={T} />
            <Row label="Samples Used At Last Training" value={String(latest.samplesAtLastTraining ?? 'n/a')} T={T} />
            <Row label="New Candles Since Last Training" value={String(latest.newCandles ?? 'n/a')} T={T} />
            <Row label="Minimum Required To Retrain" value={String(latest.minRequired ?? 'n/a')} T={T} />
            <Text style={{ color: T.amber, fontSize: 9, fontWeight: '700', marginTop: 6 }}>Decision: Existing model reused.</Text>
          </View>
        )}
        {latest.type === 'rejected' && (
          <View>
            <Row label="Version (kept, unchanged)" value={`v${latest.previousVersion ?? latest.newVersion ?? '—'}`} T={T} color={T.red} />
            <Row label="This Run's Accuracy" value={fmtPct(latest.newAccuracy)} T={T} />
            <Row label="Previous Accuracy (still active)" value={fmtPct(latest.previousAccuracy)} T={T} />
            <Row label="Samples Trained This Run" value={String(latest.samplesUsed)} T={T} />
            <Row label="Training Time" value={fmtDuration(latest.durationMs)} T={T} />
          </View>
        )}
        {latest.type === 'skipped' && (
          <Text style={{ color: T.textSub, fontSize: 10, lineHeight: 15 }}>{latest.skipReason}</Text>
        )}
        {latest.type === 'failed' && (
          <Text style={{ color: T.red, fontSize: 10, lineHeight: 15 }}>{latest.errorMessage}</Text>
        )}

        <View style={{ height: 1, backgroundColor: T.border, marginVertical: 8 }} />
        <Row label="Current Available Samples" value={String(latest.currentSamples ?? latest.samplesUsed ?? 'n/a')} T={T} />
        <Row label="Last Training Time" value={fmtDate(latest.timestamp)} T={T} />
        <Row label="Validation Accuracy" value={fmtPct(latest.newAccuracy ?? latest.previousAccuracy)} T={T} />
        <Row label="Walk-Forward Accuracy" value={fmtPct(latest.walkForwardAccuracy)} T={T} />
        <Row label="Calibration Score" value={latest.calibrationScore != null ? latest.calibrationScore.toFixed(0) : 'n/a (not enough resolved predictions yet)'} T={T} />
        <Row label="Current Confidence" value={latest.confidence != null ? `${latest.confidence.toFixed(0)}/100` : 'n/a'} T={T} />

        <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8, lineHeight: 13, fontStyle: 'italic' }}>{latest.explanation}</Text>
      </View>

      <TouchableOpacity onPress={() => setShowHistory(v => !v)} style={{ paddingVertical: 6 }}>
        <Text style={{ color: T.blue, fontSize: 10, fontWeight: '700' }}>{showHistory ? '▼' : '▶'} Training History ({history.length} run{history.length !== 1 ? 's' : ''})</Text>
      </TouchableOpacity>
      {showHistory && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          <View>
            <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: T.border, paddingBottom: 4 }}>
              {['Date/Time', 'Symbol', 'Asset Class', 'Run #', 'Accepted v', 'Samples', 'Val Acc', 'WF Acc', 'Duration', 'Status'].map(h => (
                <Text key={h} style={{ color: T.textDim, fontSize: 9, fontWeight: '700', width: 90 }}>{h}</Text>
              ))}
            </View>
            {history.map((h, i) => {
              const m = STATUS_META[h.type];
              return (
                <TouchableOpacity key={i} onPress={() => setDetailRow(h)} style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.border }}>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{new Date(h.timestamp).toLocaleString()}</Text>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{h.symbol}</Text>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{h.assetClass}</Text>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{h.trainingRunNumber ?? '—'}</Text>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{h.newVersion != null ? `v${h.newVersion}` : '—'}</Text>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{h.samplesUsed ?? h.currentSamples ?? '—'}</Text>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{fmtPct(h.newAccuracy ?? h.previousAccuracy)}</Text>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{fmtPct(h.walkForwardAccuracy)}</Text>
                  <Text style={{ color: T.textSub, fontSize: 9, width: 90 }}>{fmtDuration(h.durationMs)}</Text>
                  <Text style={{ color: m.color(T), fontSize: 9, fontWeight: '700', width: 90 }}>{m.icon} {h.type}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>
      )}

      <TouchableOpacity onPress={() => setShowSamples(v => !v)} style={{ paddingVertical: 6 }}>
        <Text style={{ color: T.blue, fontSize: 10, fontWeight: '700' }}>{showSamples ? '▼' : '▶'} Sample Count History</Text>
      </TouchableOpacity>
      {showSamples && (
        <View style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 10 }}>
          {sampleHist.length === 0 && <Text style={{ color: T.textDim, fontSize: 10 }}>No sample count changes recorded yet.</Text>}
          {sampleHist.map((s, i) => (
            <View key={i} style={{ marginBottom: i < sampleHist.length - 1 ? 8 : 0 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: T.text, fontSize: 12, fontWeight: '800' }}>{s.count}</Text>
                <Text style={{ color: T.textDim, fontSize: 9 }}>{new Date(s.timestamp).toLocaleString()}</Text>
              </View>
              <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 13 }}>{s.reason}</Text>
              {i < sampleHist.length - 1 && <Text style={{ color: T.textDim, fontSize: 10, textAlign: 'center' }}>↓</Text>}
            </View>
          ))}
        </View>
      )}

      <Modal visible={!!detailRow} transparent animationType="fade" onRequestClose={() => setDetailRow(null)}>
        <View style={{ flex: 1, backgroundColor: '#000000a0', justifyContent: 'center', padding: 20 }}>
          <View style={{ backgroundColor: T.bg2, borderRadius: 10, padding: 16, borderWidth: 1, borderColor: T.border }}>
            {detailRow && (
              <>
                <Text style={{ color: STATUS_META[detailRow.type].color(T), fontSize: 14, fontWeight: '800', marginBottom: 8 }}>
                  {STATUS_META[detailRow.type].icon} {STATUS_META[detailRow.type].label}
                </Text>
                <Row label="Date/Time" value={fmtDate(detailRow.timestamp)} T={T} />
                <Row label="Training Run #" value={String(detailRow.trainingRunNumber ?? 'n/a')} T={T} />
                <Row label="Duration" value={fmtDuration(detailRow.durationMs)} T={T} />
                <Text style={{ color: T.textSub, fontSize: 11, marginTop: 10, lineHeight: 16 }}>{detailRow.explanation}</Text>
                <TouchableOpacity onPress={() => setDetailRow(null)} style={{ marginTop: 14, alignItems: 'center', backgroundColor: T.bg3, borderRadius: 8, paddingVertical: 10 }}>
                  <Text style={{ color: T.text, fontWeight: '700', fontSize: 12 }}>Close</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
