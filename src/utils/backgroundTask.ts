import { logger } from './logger';

// ═══════════════════════════════════════════════════════════════════════
// BACKGROUND EXECUTION — removed after a real EAS build failure
// ═══════════════════════════════════════════════════════════════════════
//
// This previously wired in expo-background-task + expo-task-manager as a
// best-effort supplement to the foreground scanner. That build failed:
// expo-background-task@0.1.x requires expo-task-manager@~12.0.6, but this
// project is on Expo SDK 51, which only supports the expo-task-manager
// 11.x line — a genuine, unresolvable version mismatch without upgrading
// the entire SDK (a much larger, riskier change for a feature that was
// already documented as low-value: no interval guarantee on iOS, stops
// completely on force-quit, requires a custom dev build).
//
// Rather than chase SDK-version compatibility for a feature that was
// never the reliable mechanism anyway, this is now an honest no-op. The
// REAL reliability comes entirely from ScannerServiceProvider's foreground
// polling, which is unaffected by this removal and was always the actual
// backbone — this file's only job was ever a "bonus if it happens to
// fire" supplement on top of that, never the primary guarantee.
//
// If genuine always-on background scanning becomes a real requirement
// later, the architecturally correct answer is still what was documented
// before: a server-side polling service running independently of the
// phone, not a client-only background task — that was true regardless of
// which Expo SDK version this project is on.
// ═══════════════════════════════════════════════════════════════════════

export async function registerBackgroundTask(): Promise<{ registered: boolean; reason: string }> {
  logger.info('backgroundTask', 'Background task registration skipped — removed after a real build failure (expo-background-task/expo-task-manager version mismatch on Expo SDK 51). Foreground scanning is unaffected.');
  return { registered: false, reason: 'Background task support removed due to an SDK version incompatibility. The foreground scanner is the real mechanism and is unaffected.' };
}

export async function unregisterBackgroundTask(): Promise<void> {
  // Nothing to unregister — never registered in the first place.
}

export function setBackgroundScanCallback(_fn: () => Promise<void>): void {
  // No-op — kept only so ScannerService.tsx doesn't need a structural
  // change for a feature that was always optional and best-effort.
}
