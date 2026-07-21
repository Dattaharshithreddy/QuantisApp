import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { evaluateProductionModel, ProductionEvalResult } from '../utils/productionEvaluation';
import { computeOptimalConfig, OptimalConfig } from '../utils/modelOptimization';
import { fetchMaxHistoryForAsset } from '../utils/multiSourceFetch';

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND TASK CONTEXT  (v2 — scanner-capable, stale-task recovery)
//
// Manages three task types: evaluation, optimization, scanner.
// Tasks live here, not in any Screen. Screens are pure observers.
//
// Event-loop yielding: every step issues `await tick()` before AND after the
// heavy call so the JS thread yields to the event loop. React Navigation
// animations, scroll events, and button presses stay responsive.
//
// App lifecycle: tasks continue running while the app is alive — including
// while backgrounded, because the JS thread continues executing in the
// background (iOS gives ~30s, Android varies). We do NOT cancel tasks on
// background/inactive transitions because the app may return to foreground
// within seconds and the task would still be running correctly.
//
// Stale task recovery: when a task starts, its ID is persisted to AsyncStorage.
// When it finishes (any outcome), the ID is removed. On provider mount we
// check AsyncStorage for any IDs that were never removed — these represent
// tasks that were interrupted by a process kill (not a background/inactive
// transition) and are marked 'interrupted' on the next launch.
// ─────────────────────────────────────────────────────────────────────────────

export type TaskType = 'evaluation' | 'optimization' | 'scanner';
export type TaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type TaskStep = {
  key: string;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
};

export type AppTask = {
  id: string;
  type: TaskType;
  label: string;
  symbol: string;       // display label (may be comma-separated for multi)
  timeframe: string;
  status: TaskStatus;
  steps: TaskStep[];
  completed: number;
  total: number;
  startedAt: number;
  completedAt?: number;
  elapsedMs: number;
  etaMs: number | null;
  skipped: string[];
  error?: string;
  evalResults: ProductionEvalResult[];
  optResults: OptimalConfig[];
  scanSignalCount?: number;    // scanner: how many BUY/SELL signals found
  scanSymbolCount?: number;    // scanner: how many symbols were evaluated
};

// Keep old name exported for backward compat with EvalTaskCard.tsx
export type EvalTask = AppTask;

export type ComboSpec = {
  asset: { symbol: string; src: string; type: string; [key: string]: any };
  tf: string;
};

export type SessionParams = {
  aoSession: any;
  avKey: string | null;
};

type AppTaskContextValue = {
  tasks: Record<string, AppTask>;
  runningTasks: AppTask[];
  startEvaluation: (combos: ComboSpec[], session: SessionParams, strategyMode?: 'ALL' | 'SELECTED') => string | null;
  startOptimization: (combos: ComboSpec[], session: SessionParams) => string | null;
  startScanner: (assets: any[], session: SessionParams) => string | null;
  cancelTask: (id: string) => void;
  getTask: (id: string) => AppTask | null;
};

const EvalTaskContext = createContext<AppTaskContextValue>({
  tasks: {}, runningTasks: [],
  startEvaluation: () => null, startOptimization: () => null, startScanner: () => null,
  cancelTask: () => {}, getTask: () => null,
});

export function useEvalTasks() { return useContext(EvalTaskContext); }

// One event-loop tick — yields to React, navigation, and native animations
const tick = () => new Promise<void>(r => setTimeout(r, 0));

function makeComboId(type: TaskType, combos: ComboSpec[]): string {
  const key = combos.map(c => `${c.asset.symbol}_${c.tf}`).sort().join('|');
  return `${type}__${key}`;
}

function buildSteps(type: TaskType, combos: ComboSpec[]): TaskStep[] {
  return combos.flatMap(({ asset, tf }) => {
    const base = `${asset.symbol}/${tf}`;
    const steps: TaskStep[] = [
      { key: `fetch_${base}`, label: `Fetching candles — ${base}`, status: 'pending' },
    ];
    if (type === 'evaluation') steps.push({ key: `eval_${base}`, label: `Evaluating ${base}`, status: 'pending' });
    if (type === 'optimization') steps.push({ key: `optim_${base}`, label: `Optimizing ${base}`, status: 'pending' });
    return steps;
  });
}

function buildScannerSteps(assets: any[]): TaskStep[] {
  return [
    { key: 'watchlist', label: 'Loading watchlist', status: 'pending' },
    ...assets.map(a => ({ key: `scan_${a.symbol}`, label: `Scanning ${a.symbol}`, status: 'pending' as const })),
    { key: 'rank', label: 'Ranking opportunities', status: 'pending' },
    { key: 'save', label: 'Saving results', status: 'pending' },
  ];
}

async function notify(title: string, body: string, screen = 'ProductionEval') {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true, data: { screen } },
      trigger: null,
    });
  } catch { /* permission not granted */ }
}

export async function notifyRunningInBackground(taskType: TaskType) {
  const label = taskType === 'evaluation' ? 'Production Evaluation' : taskType === 'optimization' ? 'Optimizer' : 'Scanner';
  await notify(
    `${label} running in background`,
    'You can navigate freely. Tap this notification to return to the results.',
    'ProductionEval'
  );
}

export function EvalTaskProvider({ children }: { children: React.ReactNode }) {
  const [tasks, setTasks] = useState<Record<string, AppTask>>({});
  const cancelFlags = useRef<Record<string, { cancelled: boolean }>>({});

  // P1 #4: removed global 1-second forceTick (caused all subscribers to re-render
  // every second even when no tasks were running). Elapsed time display is now
  // computed live in each screen with a local interval that only ticks during
  // active tasks. ETA values are stored in task state and updated by the task
  // loop on each step completion — no clock tick needed for those.

  // ── Stale task recovery on launch ─────────────────────────────────────────
  // When a task starts, its ID is written to AsyncStorage ('runningTaskIds').
  // When it finishes (any outcome), the ID is removed. On provider mount we
  // read this set — any IDs still present represent tasks that were running
  // when the app process was killed (not just backgrounded). We inject a
  // tombstone 'interrupted' entry so the screen can show what happened rather
  // than showing nothing. We do NOT cancel tasks on foreground/background
  // transitions because the JS thread continues executing in the background
  // and the task may complete normally before the OS suspends the process.
  const RUNNING_TASK_IDS_KEY = 'backgroundTaskContext__runningIds';
  const MAX_COMPLETED_TASKS = 10;

  useEffect(() => {
    AsyncStorage.getItem(RUNNING_TASK_IDS_KEY).then(raw => {
      if (!raw) return;
      let staleIds: string[];
      try { staleIds = JSON.parse(raw); } catch { return; }
      if (!staleIds.length) return;
      // Inject tombstone tasks so the screen shows the interruption
      const tombstones: Record<string, AppTask> = {};
      staleIds.forEach(id => {
        const parts = id.split('__');
        const type = parts[0] as TaskType;
        tombstones[id] = {
          id, type, label: type === 'evaluation' ? 'Production Evaluation' : type === 'optimization' ? 'Optimizer' : 'Scanner',
          symbol: parts[1]?.replace(/\|/g, ', ') ?? '?', timeframe: '—',
          status: 'interrupted', steps: [], completed: 0, total: 0,
          startedAt: 0, elapsedMs: 0, etaMs: null,
          skipped: [], evalResults: [], optResults: [],
          error: 'Task was interrupted — the app was closed while it was running. Tap Run again to restart.',
        };
      });
      setTasks(prev => ({ ...tombstones, ...prev })); // stale tasks behind any already-loaded state
      // Clear the stale list — they've been acknowledged
      AsyncStorage.removeItem(RUNNING_TASK_IDS_KEY).catch(() => {});
    }).catch(() => {});
  }, []);

  // Persist running task IDs to AsyncStorage so stale-task recovery works
  // across process kills. Called when a task starts and when it finishes.
  const persistRunningIds = useCallback((currentTasks: Record<string, AppTask>) => {
    const ids = Object.values(currentTasks).filter(t => t.status === 'running').map(t => t.id);
    AsyncStorage.setItem(RUNNING_TASK_IDS_KEY, JSON.stringify(ids)).catch(() => {});
  }, []);

  // Directly removes one task ID from the AsyncStorage running-IDs list.
  // Called from finally blocks so cleanup is guaranteed even if the loop
  // throws before reaching its terminal patchTask call. Does not depend on
  // React state (which may not have committed at finally-block execution time).
  const removeRunningId = useCallback(async (id: string) => {
    try {
      const raw = await AsyncStorage.getItem(RUNNING_TASK_IDS_KEY);
      const ids: string[] = raw ? JSON.parse(raw) : [];
      const next = ids.filter(x => x !== id);
      await AsyncStorage.setItem(RUNNING_TASK_IDS_KEY, JSON.stringify(next));
    } catch { /* best-effort — stale-task recovery on next launch will handle residue */ }
  }, []);

  // ── State helpers ──────────────────────────────────────────────────────────
  const evictOldTasks = useCallback(() => {
    setTasks(prev => {
      const done = Object.entries(prev)
        .filter(([, v]) => v.status === 'completed' || v.status === 'failed' || v.status === 'cancelled')
        .sort(([, a], [, b]) => ((b as any).completedAt ?? 0) - ((a as any).completedAt ?? 0));
      if (done.length <= MAX_COMPLETED_TASKS) return prev;
      const evict = new Set(done.slice(MAX_COMPLETED_TASKS).map(([k]) => k));
      const pruned: typeof prev = {};
      Object.entries(prev).forEach(([k, v]) => { if (!evict.has(k)) pruned[k] = v; });
      return pruned;
    });
  }, []);

  const patchTask = useCallback((id: string, patch: Partial<AppTask>) => {
    setTasks(prev => {
      const t = prev[id]; if (!t) return prev;
      return { ...prev, [id]: { ...t, ...patch, elapsedMs: Date.now() - t.startedAt } };
    });
  }, []);

  const patchStep = useCallback((taskId: string, stepKey: string, patch: Partial<TaskStep>) => {
    setTasks(prev => {
      const t = prev[taskId]; if (!t) return prev;
      const steps = t.steps.map(s => s.key === stepKey ? { ...s, ...patch } : s);
      return { ...prev, [taskId]: { ...t, steps, elapsedMs: Date.now() - t.startedAt } };
    });
  }, []);

  // ── Evaluation loop ────────────────────────────────────────────────────────
  const runEvalLoop = useCallback(async (id: string, combos: ComboSpec[], session: SessionParams, strategyMode: 'ALL' | 'SELECTED' = 'ALL') => {
    const flag = cancelFlags.current[id];
    const results: ProductionEvalResult[] = [];
    let completed = 0;

    try {
      for (const { asset, tf } of combos) {
        if (flag.cancelled) break;
        const base = `${asset.symbol}/${tf}`;
        const fk = `fetch_${base}`, ek = `eval_${base}`;

        // ── Yield before marking step active so UI paints the update ──────────
        await tick();
        patchStep(id, fk, { status: 'active' });
        await tick(); // yield again after state update so React commits before fetch

        let candles: any[] = [];
        try {
          const bars = ['1m','3m','5m','15m'].includes(tf) ? 10000 : 5000;
          const { candles: c, note } = await fetchMaxHistoryForAsset(asset, tf, bars, session.aoSession, session.avKey);
          candles = c;
          if (note) setTasks(prev => {
            const t = prev[id]; if (!t) return prev;
            return { ...prev, [id]: { ...t, skipped: [...new Set([...t.skipped, note])], elapsedMs: Date.now() - t.startedAt } };
          });
          patchStep(id, fk, { status: 'done', detail: `${candles.length} bars` });
        } catch (e: any) {
          patchStep(id, fk, { status: 'error', detail: e.message });
          patchStep(id, ek, { status: 'error', detail: 'Skipped' });
          completed++; patchTask(id, { completed }); continue;
        }

        if (flag.cancelled) break;

        await tick();
        patchStep(id, ek, { status: 'active' });
        await tick();

        try {
          if (candles.length >= 120) {
            // onProgress streams partial results as each major step completes.
            // Without this, nothing shows for 30+ min while the full evaluation runs.
            // Partial results are deduplicated by symbol+timeframe key.
            const onProgress = (partial: any, meta?: { stage: string; percent: number }) => {
              setTasks(prev => {
                const t = prev[id]; if (!t) return prev;
                const key = `${partial.symbol}__${partial.timeframe}`;
                const existing = t.evalResults.findIndex((r: any) => `${r.symbol}__${r.timeframe}` === key);
                const next = existing >= 0
                  ? t.evalResults.map((r: any, i: number) => i === existing ? partial : r)
                  : [...t.evalResults, partial];
                // Update the eval step detail with stage + percent for granular progress
                const steps = meta ? t.steps.map(s =>
                  s.key === `eval_${base}` && s.status === 'active'
                    ? { ...s, detail: `${meta.stage} · ${meta.percent}%` }
                    : s
                ) : t.steps;
                return { ...prev, [id]: { ...t, evalResults: next, steps, elapsedMs: Date.now() - t.startedAt } };
              });
            };
            const res = await evaluateProductionModel(candles, asset.symbol, tf, {}, onProgress, strategyMode);
            await tick();
            if (res) {
              // Final complete result — replace any partial
              setTasks(prev => {
                const t = prev[id]; if (!t) return prev;
                const elapsed = Date.now() - t.startedAt;
                const key = `${res.symbol}__${res.timeframe}`;
                const existing = t.evalResults.findIndex((r: any) => `${r.symbol}__${r.timeframe}` === key);
                const next = existing >= 0
                  ? t.evalResults.map((r: any, i: number) => i === existing ? res : r)
                  : [...t.evalResults, res];
                return { ...prev, [id]: { ...t, evalResults: next, elapsedMs: elapsed, etaMs: completed > 0 ? (elapsed / completed) * Math.max(0, t.total - completed) : null } };
              });
            }
            if (res) results.push(res); // FIX: populate local array so notification body is correct
            patchStep(id, ek, { status: 'done', detail: res ? `${res.primaryMetrics.numTrades} trades` : 'no result' });
          } else {
            patchStep(id, ek, { status: 'error', detail: `${candles.length} bars < 120` });
          }
        } catch (e: any) {
          patchStep(id, ek, { status: 'error', detail: e.message });
        }

        completed++; patchTask(id, { completed });
        await tick();
      }

      if (flag.cancelled) {
        patchTask(id, { status: 'cancelled', completedAt: Date.now() });
      } else {
        patchTask(id, { status: 'completed', completedAt: Date.now(), completed: combos.length }); evictOldTasks();
        notify(results.length ? '✓ Production Evaluation completed' : 'Production Evaluation finished',
          results.length ? `${results.length} symbol${results.length !== 1 ? 's' : ''} evaluated.` : 'No results — check data source.');
      }
    } finally {
      // Guaranteed cleanup: remove this task's ID from the AsyncStorage
      // running-IDs list regardless of how the loop exits (normal completion,
      // cancellation, or an unhandled exception escaping all inner try/catch).
      // Without finally, an unexpected throw before the terminal patchTask
      // call would leave the ID in AsyncStorage permanently, causing false
      // 'interrupted' tombstones on the next launch.
      await removeRunningId(id);
    }
  }, [patchTask, patchStep, removeRunningId]);

  // ── Optimization loop ──────────────────────────────────────────────────────
  const runOptimLoop = useCallback(async (id: string, combos: ComboSpec[], session: SessionParams) => {
    const flag = cancelFlags.current[id];
    const results: OptimalConfig[] = [];
    let completed = 0;

    try {
      for (const { asset, tf } of combos) {
        if (flag.cancelled) break;
        const base = `${asset.symbol}/${tf}`;
        const fk = `fetch_${base}`, ok = `optim_${base}`;

        await tick();
        patchStep(id, fk, { status: 'active' });
        await tick();

        let candles: any[] = [];
        try {
          const bars = ['1m','3m','5m','15m'].includes(tf) ? 10000 : 5000;
          const { candles: c, note } = await fetchMaxHistoryForAsset(asset, tf, bars, session.aoSession, session.avKey);
          candles = c;
          if (note) setTasks(prev => {
            const t = prev[id]; if (!t) return prev;
            return { ...prev, [id]: { ...t, skipped: [...new Set([...t.skipped, note])], elapsedMs: Date.now() - t.startedAt } };
          });
          patchStep(id, fk, { status: 'done', detail: `${candles.length} bars` });
        } catch (e: any) {
          patchStep(id, fk, { status: 'error', detail: e.message });
          patchStep(id, ok, { status: 'error', detail: 'Skipped' });
          completed++; patchTask(id, { completed }); continue;
        }

        if (flag.cancelled) break;

        await tick();
        patchStep(id, ok, { status: 'active' });
        await tick();

        try {
          if (candles.length >= 120) {
            const config = await computeOptimalConfig(candles, asset.symbol, tf);
            await tick();
            if (config) {
              results.push(config);
              setTasks(prev => {
                const t = prev[id]; if (!t) return prev;
                const elapsed = Date.now() - t.startedAt;
                return { ...prev, [id]: { ...t, optResults: [...results], elapsedMs: elapsed, etaMs: completed > 0 ? (elapsed / completed) * Math.max(0, t.total - completed) : null } };
              });
            }
            patchStep(id, ok, { status: 'done', detail: config ? `H=${config.bestHorizon} T=${config.bestThreshold}` : 'no result' });
          } else {
            patchStep(id, ok, { status: 'error', detail: `${candles.length} bars < 120` });
          }
        } catch (e: any) {
          patchStep(id, ok, { status: 'error', detail: e.message });
        }

        completed++; patchTask(id, { completed });
        await tick();
      }

      if (flag.cancelled) {
        patchTask(id, { status: 'cancelled', completedAt: Date.now() });
      } else {
        patchTask(id, { status: 'completed', completedAt: Date.now(), completed: combos.length }); evictOldTasks();
        notify(results.length ? '✓ Optimizer completed' : 'Optimizer finished',
          results.length ? `${results.length} symbol${results.length !== 1 ? 's' : ''} optimized.` : 'No results — check data source.');
      }
    } finally {
      await removeRunningId(id);
    }
  }, [patchTask, patchStep, removeRunningId]);

  // ── Scanner loop ───────────────────────────────────────────────────────────
  // Runs the scanner's manual "Scan Now" as a background task. The automatic
  // 5-minute interval (ScannerService) is unchanged — this only handles the
  // user-initiated Scan Now action.
  // IMPORTANT: runScanCycle is called with the same arguments as before.
  // No AI/ML/prediction/risk logic changes.
  const runScanLoop = useCallback(async (id: string, assets: any[], session: SessionParams) => {
    const flag = cancelFlags.current[id];

    try {
      await tick();
      patchStep(id, 'watchlist', { status: 'active' });
      await tick();
      patchStep(id, 'watchlist', { status: 'done', detail: `${assets.length} symbols` });

      let buySellCount = 0;
      let scannedCount = 0;

      const { runScanCycle } = await import('../utils/watchlistScanner');
      const livePrices: Record<string, number> = {};

      for (const asset of assets) {
        if (flag.cancelled) break;

        const stepKey = `scan_${asset.symbol}`;
        await tick();
        patchStep(id, stepKey, { status: 'active' });
        await tick();

        try {
          const result = await runScanCycle([asset], '15m', livePrices, session.aoSession, session.avKey);
          await tick();
          const signal = result?.lastResults?.[asset.symbol];
          const action = signal?.action ?? 'HOLD';
          if (action === 'BUY' || action === 'SELL') buySellCount++;
          scannedCount++;
          patchStep(id, stepKey, { status: 'done', detail: action });
        } catch (e: any) {
          patchStep(id, stepKey, { status: 'error', detail: e.message });
        }

        setTasks(prev => {
          const t = prev[id]; if (!t) return prev;
          const elapsed = Date.now() - t.startedAt;
          const avgMs = scannedCount > 0 ? elapsed / scannedCount : 0;
          const remaining = Math.max(0, assets.length - scannedCount);
          return { ...prev, [id]: { ...t, completed: scannedCount, elapsedMs: elapsed, etaMs: avgMs * remaining, scanSignalCount: buySellCount, scanSymbolCount: scannedCount } };
        });

        await tick();
      }

      if (flag.cancelled) {
        patchTask(id, { status: 'cancelled', completedAt: Date.now() });
        return; // finally still runs on return — removeRunningId is guaranteed
      }

      await tick();
      patchStep(id, 'rank', { status: 'active' });
      await tick();
      patchStep(id, 'rank', { status: 'done' });

      await tick();
      patchStep(id, 'save', { status: 'active' });
      await tick();
      patchStep(id, 'save', { status: 'done' });

      patchTask(id, { status: 'completed', completedAt: Date.now(), completed: assets.length, scanSignalCount: buySellCount, scanSymbolCount: scannedCount });
      notify(
        buySellCount > 0 ? `✓ Scanner completed — ${buySellCount} signal${buySellCount !== 1 ? 's' : ''} found` : '✓ Scanner completed',
        `${scannedCount} symbol${scannedCount !== 1 ? 's' : ''} scanned. ${buySellCount} BUY/SELL signal${buySellCount !== 1 ? 's' : ''} found.`,
        'Scanner'
      );
    } finally {
      await removeRunningId(id);
    }
  }, [patchTask, patchStep, removeRunningId]);

  // ── Public API ─────────────────────────────────────────────────────────────
  const startEvaluation = useCallback((combos: ComboSpec[], session: SessionParams, strategyMode: 'ALL' | 'SELECTED' = 'ALL'): string | null => {
    if (!combos.length) return null;
    const id = makeComboId('evaluation', combos);
    if (tasks[id]?.status === 'running') return id; // reconnect to existing
    const flag = { cancelled: false };
    cancelFlags.current[id] = flag;
    const task: AppTask = {
      id, type: 'evaluation', label: 'Production Evaluation',
      symbol: combos.map(c => c.asset.symbol).join(', '),
      timeframe: combos.map(c => c.tf).join(', '),
      status: 'running', steps: buildSteps('evaluation', combos),
      completed: 0, total: combos.length,
      startedAt: Date.now(), elapsedMs: 0, etaMs: null,
      skipped: [], evalResults: [], optResults: [],
    };
    setTasks(prev => ({ ...prev, [id]: task }));
    // InteractionManager.runAfterInteractions defers the loop until all
    // pending animations (screen push, tab switch) have completed. Without
    // this, the ML training starts immediately and blocks the JS thread before
    // the navigation transition finishes — making the back button and tabs
    // appear unresponsive until training completes.
    InteractionManager.runAfterInteractions(() => {
      runEvalLoop(id, combos, session, strategyMode);
    });
    return id;
  }, [tasks, runEvalLoop]);

  const startOptimization = useCallback((combos: ComboSpec[], session: SessionParams): string | null => {
    if (!combos.length) return null;
    const id = makeComboId('optimization', combos);
    if (tasks[id]?.status === 'running') return id;
    const flag = { cancelled: false };
    cancelFlags.current[id] = flag;
    const task: AppTask = {
      id, type: 'optimization', label: 'Optimizer',
      symbol: combos.map(c => c.asset.symbol).join(', '),
      timeframe: combos.map(c => c.tf).join(', '),
      status: 'running', steps: buildSteps('optimization', combos),
      completed: 0, total: combos.length,
      startedAt: Date.now(), elapsedMs: 0, etaMs: null,
      skipped: [], evalResults: [], optResults: [],
    };
    setTasks(prev => ({ ...prev, [id]: task }));
    InteractionManager.runAfterInteractions(() => {
      runOptimLoop(id, combos, session);
    });
    return id;
  }, [tasks, runOptimLoop]);

  const startScanner = useCallback((assets: any[], session: SessionParams): string | null => {
    if (!assets.length) return null;
    const id = `scanner__${assets.map(a => a.symbol).sort().join('|')}`;
    if (tasks[id]?.status === 'running') return id;
    const flag = { cancelled: false };
    cancelFlags.current[id] = flag;
    const task: AppTask = {
      id, type: 'scanner', label: 'Scanner',
      symbol: `${assets.length} symbols`,
      timeframe: '15m',
      status: 'running', steps: buildScannerSteps(assets),
      completed: 0, total: assets.length,
      startedAt: Date.now(), elapsedMs: 0, etaMs: null,
      skipped: [], evalResults: [], optResults: [],
      scanSignalCount: 0, scanSymbolCount: 0,
    };
    setTasks(prev => ({ ...prev, [id]: task }));
    InteractionManager.runAfterInteractions(() => {
      runScanLoop(id, assets, session);
    });
    return id;
  }, [tasks, runScanLoop]);

  const cancelTask = useCallback((id: string) => {
    if (cancelFlags.current[id]) cancelFlags.current[id].cancelled = true;
    patchTask(id, { status: 'cancelled', completedAt: Date.now() });
  }, [patchTask]);

  const getTask = useCallback((id: string) => tasks[id] ?? null, [tasks]);
  const runningTasks = Object.values(tasks).filter(t => t.status === 'running');

  // Keep the AsyncStorage running-IDs list in sync with in-memory task state.
  // Fires on every tasks change — cheap (just a filter + JSON.stringify).
  useEffect(() => { persistRunningIds(tasks); }, [tasks, persistRunningIds]);

  // Memoize context value — new object only when actual dependencies change
  const ctxValue = React.useMemo(
    () => ({ tasks, runningTasks, startEvaluation, startOptimization, startScanner, cancelTask, getTask }),
    [tasks, runningTasks, startEvaluation, startOptimization, startScanner, cancelTask, getTask]
  );

  return (
    <EvalTaskContext.Provider value={ctxValue}>
      {children}
    </EvalTaskContext.Provider>
  );
}
