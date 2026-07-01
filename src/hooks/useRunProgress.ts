import { useState, useEffect, useRef, useCallback } from 'react';

// Shared by VerificationScreen and ProductionEvaluationScreen so neither
// screen reimplements ETA/elapsed math independently. A real ticking
// clock (not just "elapsed at last state update") so the displayed
// elapsed/ETA actually counts up live while a batch run is in progress.

export function useRunProgress() {
  const [total, setTotal] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [currentLabel, setCurrentLabel] = useState('');
  const [running, setRunning] = useState(false);
  const startTimeRef = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  const start = useCallback((totalCount: number) => {
    setTotal(totalCount); setCompleted(0); setCurrentLabel('');
    startTimeRef.current = Date.now();
    setRunning(true);
  }, []);

  const setCurrent = useCallback((label: string) => setCurrentLabel(label), []);
  const advance = useCallback(() => setCompleted(c => c + 1), []);
  const finish = useCallback(() => setRunning(false), []);

  const elapsedMs = startTimeRef.current ? Date.now() - startTimeRef.current : 0;
  const avgMsPerItem = completed > 0 ? elapsedMs / completed : 0;
  const remaining = Math.max(0, total - completed);
  const etaMs = avgMsPerItem * remaining;

  function formatDuration(ms: number): string {
    if (ms < 1000) return '0s';
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60), s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  return {
    total, completed, remaining, currentLabel, running,
    elapsedLabel: formatDuration(elapsedMs),
    etaLabel: completed > 0 ? formatDuration(etaMs) : 'calculating…',
    start, setCurrent, advance, finish,
  };
}
