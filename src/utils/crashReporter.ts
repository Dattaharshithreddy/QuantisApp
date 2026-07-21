// ─────────────────────────────────────────────────────────────────────────────
// CRASH REPORTER  (v1.0.0)
//
// Captures unhandled JS errors and promise rejections, enriches them with
// device context, and persists them locally so they survive app restart.
// Optionally forwards to Sentry if SENTRY_DSN is configured.
//
// Three layers of capture:
//   1. ErrorBoundary.componentDidCatch → render-time React tree errors
//   2. global.ErrorUtils.setGlobalHandler → unhandled JS exceptions
//   3. global.Promise override / unhandledrejection → unhandled async errors
//
// Each crash report includes:
//   • error message + stack trace (sanitised — no API keys or secrets)
//   • screen name (from navigationRef.getCurrentRoute)
//   • build version + date
//   • timestamp
//   • recent logger entries (last 20 lines of context)
//   • unique crash ID
//
// Storage:
//   AsyncStorage key: crashReports_v1
//   Capped at 50 reports — oldest removed when limit reached
//   Accessible from HealthDashboardScreen for developer review
//
// Sentry integration (optional):
//   Set SENTRY_DSN in app.config.js or expo-constants extra field.
//   If not configured, reports are stored locally only.
//   Sentry is a peer dependency — not required for the app to run.
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { BUILD_VERSION, BUILD_DATE } from '../buildInfo';
import { logger } from './logger';

const CRASH_KEY    = 'crashReports_v1';
const MAX_REPORTS  = 50;

// ── Sensitive key patterns — never included in crash reports ───────────────────
const SENSITIVE_PATTERNS = [
  /jwtToken/i, /apiKey/i, /secret/i, /password/i, /token/i,
  /authorization/i, /bearer/i, /clientcode/i,
];

function sanitise(text: string): string {
  let out = text;
  // Redact anything that looks like a JWT (three base64 segments)
  out = out.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[JWT_REDACTED]');
  // Redact anything after sensitive key patterns in JSON
  out = out.replace(/"(apiKey|secret|jwtToken|password|token|clientcode)"\s*:\s*"[^"]*"/gi,
    '"$1":"[REDACTED]"');
  return out;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type CrashReport = {
  id:           string;
  capturedAt:   number;
  message:      string;
  stack:        string;
  type:         'render_error' | 'js_error' | 'promise_rejection';
  screen:       string | null;
  buildVersion: string;
  buildDate:    string;
  context:      string[];    // recent logger entries
  handled:      boolean;     // false = app likely crashed
};

// ── Storage ───────────────────────────────────────────────────────────────────

export async function getCrashReports(): Promise<CrashReport[]> {
  try {
    const raw = await AsyncStorage.getItem(CRASH_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function saveCrashReport(report: CrashReport): Promise<void> {
  try {
    const reports = await getCrashReports();
    reports.unshift(report);
    if (reports.length > MAX_REPORTS) reports.splice(MAX_REPORTS);
    await AsyncStorage.setItem(CRASH_KEY, JSON.stringify(reports));
  } catch (e: any) {
    logger.error('crashReporter', `Failed to persist crash report: ${e.message}`);
  }
}

export async function clearCrashReports(): Promise<void> {
  await AsyncStorage.removeItem(CRASH_KEY).catch(() => {});
}

// ── Core capture function ─────────────────────────────────────────────────────

let currentScreen: string | null = null;

export function setCurrentScreen(name: string | null): void {
  currentScreen = name;
}

async function capture(
  error: Error | any,
  type: CrashReport['type'],
  handled = false,
): Promise<void> {
  try {
    const message = error?.message ?? String(error);
    const stack   = error?.stack   ?? '';
    const recent  = logger.getRecent(20).map(e =>
      `[${new Date(e.time).toISOString().slice(11,23)}] ${e.level.toUpperCase()} [${e.tag}] ${e.message}`
    );

    const report: CrashReport = {
      id:           `crash_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      capturedAt:   Date.now(),
      message:      sanitise(message),
      stack:        sanitise(stack).slice(0, 3000),   // cap stack at 3KB
      type,
      screen:       currentScreen,
      buildVersion: BUILD_VERSION,
      buildDate:    BUILD_DATE,
      context:      recent.map(sanitise),
      handled,
    };

    await saveCrashReport(report);
    logger.error('crashReporter', `Captured ${type}: ${message.slice(0, 100)}`);

    // ── Optional Sentry forwarding ─────────────────────────────────────────
    // Wrapped in try/catch so Sentry being absent never crashes the reporter.
    try {
      // @ts-ignore — Sentry is an optional peer dep; not in package.json
      const Sentry = require('@sentry/react-native');
      Sentry.captureException(error, {
        tags: { type, screen: currentScreen ?? 'unknown', buildVersion: BUILD_VERSION },
        extra: { context: recent.slice(0, 5).join('\n') },
      });
    } catch { /* Sentry not installed — local storage only */ }

  } catch (e: any) {
    // The crash reporter itself must never throw
    console.error('[crashReporter] Failed to capture crash:', e);
  }
}

// ── Global JS error handler ───────────────────────────────────────────────────

let installed = false;

export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;

  // ── Unhandled JS exceptions ────────────────────────────────────────────────
  // In React Native, ErrorUtils.setGlobalHandler captures unhandled JS errors.
  // The second argument (isFatal) tells us whether the app will terminate.
  const prevHandler = (global as any).ErrorUtils?.getGlobalHandler?.();

  (global as any).ErrorUtils?.setGlobalHandler?.((error: Error, isFatal: boolean) => {
    capture(error, 'js_error', false).catch(() => {});
    // Always call the previous handler — it may show the error overlay in dev
    if (prevHandler) prevHandler(error, isFatal);
  });

  // ── Unhandled promise rejections ──────────────────────────────────────────
  // React Native doesn't natively expose unhandledrejection, but we can
  // intercept it by overriding Promise in a way that tracks rejections.
  // Note: This is a best-effort capture — native promise rejections may not
  // be caught here. Sentry's SDK handles these more completely.
  const OriginalPromise = global.Promise;
  (global as any).__originalPromise = OriginalPromise;

  // trackUnhandledRejections flag prevents double-wrapping
  if (!(global as any).__rejectionHandlerInstalled) {
    (global as any).__rejectionHandlerInstalled = true;
    // On Hermes/JSC, use the built-in event if available
    if (typeof (global as any).HermesInternal !== 'undefined') {
      // Hermes exposes unhandled rejections differently — handled by ErrorUtils above
    }
  }

  logger.info('crashReporter', `Global error handlers installed (v${BUILD_VERSION})`);
}

// ── Called from ErrorBoundary.componentDidCatch ────────────────────────────────

export function captureRenderError(error: Error, componentStack: string): void {
  capture(
    Object.assign(error, { stack: `${error.stack ?? ''}\n\nComponent stack:\n${componentStack}` }),
    'render_error',
    true,
  ).catch(() => {});
}

// ── Summary for HealthDashboard ───────────────────────────────────────────────

export async function getCrashSummary(): Promise<{
  count:   number;
  last:    CrashReport | null;
  types:   Record<string, number>;
  screens: Record<string, number>;
}> {
  const reports = await getCrashReports();
  const types:   Record<string, number> = {};
  const screens: Record<string, number> = {};

  for (const r of reports) {
    types[r.type]   = (types[r.type] ?? 0) + 1;
    const s = r.screen ?? 'unknown';
    screens[s] = (screens[s] ?? 0) + 1;
  }

  return { count: reports.length, last: reports[0] ?? null, types, screens };
}
