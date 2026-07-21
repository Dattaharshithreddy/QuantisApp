import React from 'react';
import { View, Text, TouchableOpacity, Modal } from 'react-native';
import { Theme } from '../theme/colors';
import { TrainingStatusInfo } from '../utils/trainingHistory';

function Row({ label, value, T, color }: { label: string; value: string; T: Theme; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 11, fontWeight: '700' }}>{value}</Text>
    </View>
  );
}

// TRAINING SUMMARY (shown after every Train press) — uses the exact same
// TrainingStatusInfo just recorded by trainAndPredict for this attempt;
// nothing here is a second, separately-computed summary. Uniform across
// all 5 outcomes rather than special-casing "did trainAndPredict return a
// prediction" vs "did it return null" — skipped/failed attempts return
// null but still get a real, recorded status to show here.
export function TrainingSummaryModal({ visible, onClose, status, theme: T }: {
  visible: boolean; onClose: () => void; status: TrainingStatusInfo | null; theme: Theme;
}) {
  if (!status) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000000a0', justifyContent: 'center', padding: 20 }}>
        <View style={{ backgroundColor: T.bg2, borderRadius: 12, padding: 18, borderWidth: 1, borderColor: T.border }}>
          {status.type === 'trained' && (
            <>
              <Text style={{ color: T.green, fontSize: 15, fontWeight: '800', marginBottom: 10 }}>🟢 New Model Accepted</Text>
              <Row label="Previous Version" value={status.previousVersion != null ? `v${status.previousVersion}` : '—'} T={T} />
              <Row label="New Version" value={`v${status.newVersion}`} T={T} color={T.green} />
              <Row label="Samples" value={String(status.samplesUsed)} T={T} />
              <Row label="Validation" value={`${status.previousAccuracy != null ? status.previousAccuracy.toFixed(1) + '%' : '—'} → ${status.newAccuracy?.toFixed(1)}%`} T={T} />
              <Row label="Walk Forward" value={status.walkForwardAccuracy != null ? `${status.walkForwardAccuracy.toFixed(1)}%` : 'n/a'} T={T} />
              <Row label="Training Time" value={`${(status.durationMs / 1000).toFixed(1)}s`} T={T} />
            </>
          )}
          {status.type === 'rejected' && (
            <>
              <Text style={{ color: T.red, fontSize: 15, fontWeight: '800', marginBottom: 10 }}>🔴 New Model Rejected</Text>
              <Row label="Current Version (kept)" value={status.previousVersion != null ? `v${status.previousVersion}` : '—'} T={T} />
              <Row label="This Run's Accuracy" value={status.newAccuracy != null ? `${status.newAccuracy.toFixed(1)}%` : 'n/a'} T={T} color={T.red} />
              <Row label="Previous Accuracy" value={status.previousAccuracy != null ? `${status.previousAccuracy.toFixed(1)}%` : 'n/a'} T={T} />
              <Row label="Samples Trained This Run" value={String(status.samplesUsed)} T={T} />
              <Row label="Training Time" value={`${(status.durationMs / 1000).toFixed(1)}s`} T={T} />
            </>
          )}
          {status.type === 'reused' && (
            <>
              <Text style={{ color: T.amber, fontSize: 15, fontWeight: '800', marginBottom: 10 }}>🟡 Existing Model Reused</Text>
              <Row label="Version" value={status.previousVersion != null ? `v${status.previousVersion}` : (status.newVersion != null ? `v${status.newVersion}` : '—')} T={T} />
              <Row label="Current Samples" value={String(status.currentSamples)} T={T} />
              <Row label="Model Trained On" value={String(status.samplesAtLastTraining ?? 'n/a')} T={T} />
              <Row label="New Candles" value={String(status.newCandles ?? 'n/a')} T={T} />
              <Row label="Threshold" value={String(status.minRequired ?? 'n/a')} T={T} />
              <Text style={{ color: T.textDim, fontSize: 10, marginTop: 8 }}>Decision: no retraining performed.{'\n'}Prediction generated using saved model.</Text>
            </>
          )}
          {status.type === 'skipped' && (
            <>
              <Text style={{ color: T.blue, fontSize: 15, fontWeight: '800', marginBottom: 10 }}>🔵 Training Skipped</Text>
              <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 16, marginBottom: 8 }}>{status.skipReason}</Text>
              <Text style={{ color: T.textDim, fontSize: 10 }}>Prediction unavailable.</Text>
            </>
          )}
          {status.type === 'failed' && (
            <>
              <Text style={{ color: T.red, fontSize: 15, fontWeight: '800', marginBottom: 10 }}>🔴 Training Failed</Text>
              <Text style={{ color: T.red, fontSize: 11, lineHeight: 16 }}>{status.errorMessage}</Text>
            </>
          )}

          <TouchableOpacity onPress={onClose} style={{ marginTop: 16, alignItems: 'center', backgroundColor: T.bg3, borderRadius: 8, paddingVertical: 11 }}>
            <Text style={{ color: T.text, fontWeight: '700', fontSize: 12 }}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
