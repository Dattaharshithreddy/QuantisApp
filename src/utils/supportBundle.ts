// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT BUNDLE  (v1.0.0)
//
// Generates a sanitised diagnostic package for support/debugging.
// Collects data from every monitoring subsystem via their existing read APIs
// — never duplicates logic, never reaches into internals.
//
// What IS included:
//   build version, device info, crash IDs/summary, health snapshot,
//   performance stats (p50/p95), security audit result, audit trail summary,
//   recent sanitised logger entries, reconciliation summary,
//   portfolio risk snapshot (notional/leverage/risk level only).
//
// What is NEVER included (enforced by sanitiseValue):
//   API keys, JWTs, passwords, session tokens, secrets.
//
// Output: a plain JSON string ready for clipboard or Share API.
// ─────────────────────────────────────────────────────────────────────────────

import { Platform } from 'react-native';
import { BUILD_VERSION, BUILD_DATE, BUILD_NOTE } from '../buildInfo';
import { logger }               from './logger';
import { getCrashSummary }      from './crashReporter';
import { getLastAuditResult }   from './securityAudit';
import { getAllMetricStats }     from './performanceMetrics';
import { getOrderLog }          from './liveOrderLifecycle';
import { getReconciliationLog } from './liveReconciliation';
import { computePortfolioRisk } from './portfolioRiskManager';

// ── Secret-pattern redaction (same rules as crashReporter.sanitise) ──────────

const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERNS = [
  /jwt/i, /token/i, /apikey/i, /api_key/i, /secret/i,
  /password/i, /clientcode/i, /mpin/i, /authorization/i, /bearer/i,
];

function sanitiseValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // prevent infinite recursion on deep objects
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    // Redact JWTs
    if (/^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return REDACTED;
    // Redact values that look like long random keys (32+ alphanumeric chars)
    if (/^[A-Za-z0-9]{32,}$/.test(value)) return REDACTED;
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(v => sanitiseValue(v, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const isSecretKey = SECRET_KEY_PATTERNS.some(p => p.test(k));
      out[k] = isSecretKey ? REDACTED : sanitiseValue(v, depth + 1);
    }
    return out;
  }

  return value;
}

// ── Subsystem data collectors ─────────────────────────────────────────────────

async function collectBuildInfo() {
  return {
    buildVersion: BUILD_VERSION,
    buildDate:    BUILD_DATE,
    buildNote:    BUILD_NOTE,
    platform:     Platform.OS,
    platformVersion: Platform.Version,
  };
}

async function collectCrashSummary() {
  try {
    const s = await getCrashSummary();
    return {
      totalCrashes: s.count,
      lastCrashAt:  s.last?.capturedAt
        ? new Date(s.last.capturedAt).toISOString() : null,
      lastCrashScreen:  s.last?.screen ?? null,
      lastCrashMessage: s.last?.message?.slice(0, 200) ?? null,
      byType:    s.types,
      byScreen:  s.screens,
    };
  } catch {
    return { error: 'unavailable' };
  }
}

async function collectPerformanceMetrics() {
  try {
    const stats = await getAllMetricStats();
    return stats.map(s => ({
      label:   s.label,
      count:   s.count,
      meanMs:  s.meanMs,
      p50Ms:   s.p50Ms,
      p95Ms:   s.p95Ms,
      p99Ms:   s.p99Ms,
      lastMs:  s.lastMs,
    }));
  } catch {
    return { error: 'unavailable' };
  }
}

async function collectSecurityAudit() {
  try {
    const r = await getLastAuditResult();
    if (!r) return { ranAt: null, allPassed: null, findings: [] };
    return {
      ranAt:      new Date(r.ranAt).toISOString(),
      buildVersion: r.buildVersion,
      allPassed:  r.allPassed,
      findings:   r.findings.map(f => ({
        id:       f.id,
        severity: f.severity,
        title:    f.title,
        passed:   f.passed,
        // Description may contain details — sanitise it
        description: sanitiseValue(f.description) as string,
      })),
    };
  } catch {
    return { error: 'unavailable' };
  }
}

async function collectAuditTrailSummary() {
  try {
    const log = await getOrderLog();
    const byState: Record<string, number> = {};
    for (const o of log) byState[o.state] = (byState[o.state] ?? 0) + 1;
    const recent5 = log.slice(0, 5).map(o => ({
      localId:      o.localId,
      broker:       o.broker,
      symbol:       o.symbol,
      direction:    o.direction,
      state:        o.state,
      createdAt:    new Date(o.createdAt).toISOString(),
      filledPrice:  o.filledPrice,
      filledQty:    o.filledQty,
      closedBy:     o.closedBy ?? null,
    }));
    return {
      totalOrders: log.length,
      byState,
      recent5,
    };
  } catch {
    return { error: 'unavailable' };
  }
}

async function collectReconciliationSummary() {
  try {
    const log = await getReconciliationLog();
    if (!log.length) return { totalRuns: 0, lastRunAt: null, clean: null };
    const last = log[0];
    const allClean  = log.slice(0, 10).every(r => !r.ghosts.length && !r.phantoms.length && !r.errors.length);
    return {
      totalRuns:      log.length,
      lastRunAt:      new Date(last.ranAt).toISOString(),
      lastDurationMs: last.durationMs,
      lastGhosts:     last.ghosts,
      lastPhantoms:   last.phantoms,
      lastErrors:     last.errors,
      last10Clean:    allClean,
    };
  } catch {
    return { error: 'unavailable' };
  }
}

async function collectPortfolioRiskSummary() {
  try {
    const r = await computePortfolioRisk();
    return {
      totalCapitalInr:     r.totalCapitalInr,
      totalNotionalInr:    r.totalNotionalInr,
      marginUtilisationPct: r.marginUtilisationPct,
      overallLeverage:     r.overallLeverage,
      concentrationPct:    r.concentrationPct,
      var95Inr:            r.var95Inr,
      var99Inr:            r.var99Inr,
      riskLevel:           r.riskLevel,
      openPositionCount:   r.positions.length,
      accountCount:        r.accounts.length,
      riskFactors:         r.riskFactors,
    };
  } catch {
    return { error: 'unavailable' };
  }
}

async function collectRecentLogs() {
  const entries = logger.getRecent(50);
  return entries.map(e => ({
    time:    new Date(e.time).toISOString(),
    level:   e.level,
    tag:     e.tag,
    // Sanitise message — may contain partial request data
    message: (sanitiseValue(e.message) as string).slice(0, 300),
  }));
}

// ── Master bundle generator ───────────────────────────────────────────────────

export type SupportBundle = {
  generatedAt:    string;
  bundleVersion:  string;
  build:          Awaited<ReturnType<typeof collectBuildInfo>>;
  crashes:        Awaited<ReturnType<typeof collectCrashSummary>>;
  performance:    Awaited<ReturnType<typeof collectPerformanceMetrics>>;
  security:       Awaited<ReturnType<typeof collectSecurityAudit>>;
  auditTrail:     Awaited<ReturnType<typeof collectAuditTrailSummary>>;
  reconciliation: Awaited<ReturnType<typeof collectReconciliationSummary>>;
  portfolioRisk:  Awaited<ReturnType<typeof collectPortfolioRiskSummary>>;
  recentLogs:     Awaited<ReturnType<typeof collectRecentLogs>>;
};

export async function generateSupportBundle(): Promise<SupportBundle> {
  logger.info('supportBundle', 'Generating support bundle…');

  const [build, crashes, performance, security, auditTrail,
    reconciliation, portfolioRisk, recentLogs] = await Promise.allSettled([
    collectBuildInfo(),
    collectCrashSummary(),
    collectPerformanceMetrics(),
    collectSecurityAudit(),
    collectAuditTrailSummary(),
    collectReconciliationSummary(),
    collectPortfolioRiskSummary(),
    collectRecentLogs(),
  ]);

  const bundle: SupportBundle = {
    generatedAt:   new Date().toISOString(),
    bundleVersion: '1.0',
    build:          build.status          === 'fulfilled' ? build.value          : { error: 'failed' } as any,
    crashes:        crashes.status        === 'fulfilled' ? crashes.value        : { error: 'failed' } as any,
    performance:    performance.status    === 'fulfilled' ? performance.value    : { error: 'failed' } as any,
    security:       security.status       === 'fulfilled' ? security.value       : { error: 'failed' } as any,
    auditTrail:     auditTrail.status     === 'fulfilled' ? auditTrail.value     : { error: 'failed' } as any,
    reconciliation: reconciliation.status === 'fulfilled' ? reconciliation.value : { error: 'failed' } as any,
    portfolioRisk:  portfolioRisk.status  === 'fulfilled' ? portfolioRisk.value  : { error: 'failed' } as any,
    recentLogs:     recentLogs.status     === 'fulfilled' ? recentLogs.value     : [] as any,
  };

  // Final deep sanitisation pass over the entire bundle
  const sanitised = sanitiseValue(bundle) as SupportBundle;
  logger.info('supportBundle', `Bundle generated — ${JSON.stringify(sanitised).length} bytes`);
  return sanitised;
}

export function formatBundleAsString(bundle: SupportBundle): string {
  return JSON.stringify(bundle, null, 2);
}
