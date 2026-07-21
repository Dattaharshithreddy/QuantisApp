// ─────────────────────────────────────────────────────────────────────────────
// PERFORMANCE METRICS  (v1.0.0)
//
// Tracks system latency for the performance dashboard.
// Measures prediction time, gate evaluation, order submission, broker ACK,
// fill time, and reconciliation — all the numbers from the architect's example.
//
// Design:
//   • start(label) / end(label) — bracket any operation
//   • All measurements stored in AsyncStorage, capped at 200 per label
//   • getStats(label) — returns mean, p50, p95, p99 for any label
//   • No React dependency — usable anywhere in the codebase
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Metric labels ─────────────────────────────────────────────────────────────
// These are the exact categories the architect specified.
export type MetricLabel =
  | 'prediction'          // ML prediction time (features → action)
  | 'signal_gates'        // evaluateSignalGates()
  | 'order_submission'    // placeLiveOrder() start → broker API response
  | 'broker_ack'          // submitted → acknowledged by broker
  | 'fill_time'           // acknowledged → filled
  | 'reconciliation'      // one full reconciliation run
  | 'paper_trade'         // paper trade open (no broker)
  | 'candle_load'         // loadCandles() cache miss → render
  | 'market_context';     // fetchUnifiedMarketContext()

export type MetricSample = {
  durationMs: number;
  recordedAt: number;
};

export type MetricStats = {
  label:     MetricLabel;
  count:     number;
  meanMs:    number;
  p50Ms:     number;
  p95Ms:     number;
  p99Ms:     number;
  minMs:     number;
  maxMs:     number;
  lastMs:    number;
  lastAt:    number;
};

const KEY_PREFIX = 'perfMetrics_v1_';
const MAX_SAMPLES = 200;

// ── In-flight timers (in-memory, not persisted) ───────────────────────────────
const activeTimers = new Map<string, number>(); // timerId → startTime

function timerId(label: MetricLabel, id?: string): string {
  return `${label}:${id ?? 'default'}`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start a timer. Returns a unique ID to pass to end().
 * If id is omitted, uses 'default' — only one concurrent timer per label.
 */
export function startMetric(label: MetricLabel, id?: string): void {
  activeTimers.set(timerId(label, id), Date.now());
}

/**
 * End a timer and persist the measurement.
 * Returns the duration in ms (useful for logging).
 */
export async function endMetric(label: MetricLabel, id?: string): Promise<number> {
  const key    = timerId(label, id);
  const start  = activeTimers.get(key);
  if (!start) return 0;
  activeTimers.delete(key);

  const durationMs = Date.now() - start;
  await appendSample(label, { durationMs, recordedAt: Date.now() });
  return durationMs;
}

/**
 * Record a known duration directly (e.g., from an already-measured operation).
 */
export async function recordMetric(label: MetricLabel, durationMs: number): Promise<void> {
  await appendSample(label, { durationMs, recordedAt: Date.now() });
}

/**
 * Measure an async operation and record it.
 */
export async function measureAsync<T>(
  label: MetricLabel,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const dur = Date.now() - start;
    appendSample(label, { durationMs: dur, recordedAt: Date.now() })
      .catch(() => {}); // non-blocking, never throws
  }
}

// ── Stats computation ─────────────────────────────────────────────────────────

export async function getMetricStats(label: MetricLabel): Promise<MetricStats | null> {
  const samples = await loadSamples(label);
  if (!samples.length) return null;

  const durations = samples.map(s => s.durationMs).sort((a, b) => a - b);
  const n         = durations.length;
  const mean      = durations.reduce((s, d) => s + d, 0) / n;
  const p50       = durations[Math.floor(n * 0.50)] ?? 0;
  const p95       = durations[Math.floor(n * 0.95)] ?? 0;
  const p99       = durations[Math.floor(n * 0.99)] ?? 0;
  const last      = samples[samples.length - 1];

  return {
    label,
    count:   n,
    meanMs:  Math.round(mean),
    p50Ms:   p50,
    p95Ms:   p95,
    p99Ms:   p99,
    minMs:   durations[0],
    maxMs:   durations[n - 1],
    lastMs:  last.durationMs,
    lastAt:  last.recordedAt,
  };
}

export async function getAllMetricStats(): Promise<MetricStats[]> {
  const labels: MetricLabel[] = [
    'prediction', 'signal_gates', 'order_submission',
    'broker_ack', 'fill_time', 'reconciliation',
    'paper_trade', 'candle_load', 'market_context',
  ];
  const results = await Promise.all(labels.map(l => getMetricStats(l)));
  return results.filter((r): r is MetricStats => r !== null);
}

export async function clearMetrics(label?: MetricLabel): Promise<void> {
  if (label) {
    await AsyncStorage.removeItem(KEY_PREFIX + label);
  } else {
    const keys = await AsyncStorage.getAllKeys();
    const metricKeys = keys.filter(k => k.startsWith(KEY_PREFIX));
    await AsyncStorage.multiRemove(metricKeys);
  }
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function loadSamples(label: MetricLabel): Promise<MetricSample[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFIX + label);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function appendSample(label: MetricLabel, sample: MetricSample): Promise<void> {
  try {
    const samples = await loadSamples(label);
    samples.push(sample);
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    await AsyncStorage.setItem(KEY_PREFIX + label, JSON.stringify(samples));
  } catch { /* non-fatal */ }
}
