#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// QUANTIS — Unified Test Runner  (v1.0.0)
//
// Runs every test suite and produces a single pass/fail summary.
// Two categories:
//   • Node tests  — plain JS, run directly with node (no dependencies)
//   • Jest tests  — use describe/it/expect, run via npx jest
//
// Usage:
//   node src/utils/__tests__/runAllTests.js
//
// Requirements:
//   Jest must be available (npm install --save-dev jest@29 in a temp dir,
//   or install globally: npm install -g jest)
//
// Exit code: 0 if all pass, 1 if any fail.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT  = path.resolve(__dirname, '../../..');
const TESTS = __dirname;

// ── Colour helpers ────────────────────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

// ── Test suite registry ───────────────────────────────────────────────────────

const NODE_TESTS = [
  {
    file:  'liveTrading.test.js',
    label: 'Live Trading (idempotency, lifecycle, reconciliation, kill switch, snapshots)',
    pass:  /(\d+) passed, 0 failed/,
    count: /(\d+) passed/,
  },
  {
    file:  'tradingCoach.test.js',
    label: 'Trading Coach (insights, grades, calibration, impact ranking)',
    pass:  /(\d+) passed, 0 failed/,
    count: /(\d+) passed/,
  },
  {
    file:  'candleCache.test.js',
    label: 'Candle Cache (TTL, merge, gap detection, pagination)',
    pass:  /ALL CACHE INVARIANTS PROVEN/,
    count: /(\d+) passed/,
  },
  {
    file:  'onboarding.test.js',
    label: 'Onboarding (first launch, completion, skip, restart, experience, tooltips)',
    pass:  /(29) passed, 0 failed/,
    count: /(29) passed/,
  },
  {
    file:  'supportBundle.test.js',
    label: 'Support Bundle (sanitisation, structure, secret redaction, edge cases)',
    pass:  /(26) passed, 0 failed/,
    count: /(26) passed/,
  },
  {
    file:  'portfolioRiskManager.test.js',
    label: 'Portfolio Risk Manager (VaR, leverage, concentration, multi-account, classification)',
    pass:  /(29) passed, 0 failed/,
    count: /(29) passed/,
  },
  {
    file:  'bnFutures.test.js',
    label: 'Binance Futures (leverage, margin, liquidation, P&L, RoE, funding)',
    pass:  /(36) passed, 0 failed/,
    count: /(36) passed/,
  },
  {
    file:  'futures.test.js',
    label: 'Futures (lot sizes, expiry, margin, P&L, MTM settlement, portfolio)',
    pass:  /(\d+) passed, 0 failed/,
    count: /(\d+) passed/,
  },
];

const JEST_TESTS = [
  {
    pattern: 'regimeEvaluation',
    label:   'Regime Evaluation (11 labels, attribution, FittedEnsemble accessor)',
  },
  {
    pattern: 'strategyAndContextAnalytics',
    label:   'Strategy & Context Analytics (bucket computation, strategy scoring)',
  },
  {
    pattern: 'marketContextIntegration',
    label:   'Market Context Integration (snapshot, sentiment, ML isolation)',
  },
];

// ── Runners ───────────────────────────────────────────────────────────────────

function runNodeTest(suite) {
  const filePath = path.join(TESTS, suite.file);
  if (!fs.existsSync(filePath)) {
    return { label: suite.label, passed: false, reason: 'File not found', count: 0 };
  }

  const result = spawnSync('node', [filePath], { encoding: 'utf8', cwd: ROOT });
  const output = result.stdout + result.stderr;
  const passed = suite.pass.test(output) && result.status === 0;
  const countMatch = output.match(suite.count);
  const count = countMatch ? Number(countMatch[1]) : 0;

  return {
    label:  suite.label,
    passed,
    count,
    reason: passed ? null : output.split('\n').filter(l => l.includes('✗') || l.includes('Error')).slice(0,3).join('\n'),
  };
}

function runJestTests(suites) {
  // Find jest binary
  const jestPaths = [
    path.join(ROOT, 'node_modules/.bin/jest'),
    '/tmp/jest_runner/node_modules/.bin/jest',
  ];
  let jestBin = jestPaths.find(p => fs.existsSync(p));

  if (!jestBin) {
    // Try global
    try { execSync('jest --version', { stdio: 'ignore' }); jestBin = 'jest'; } catch {}
  }
  if (!jestBin) {
    return suites.map(s => ({
      label: s.label, passed: false, count: 0,
      reason: 'Jest not found. Run: npm install --save-dev jest@29 in /tmp/jest_runner',
    }));
  }

  const patterns = suites.map(s => s.pattern).join('|');
  const result = spawnSync(
    jestBin,
    [`--testPathPattern=(${patterns})`, '--rootDir', TESTS, '--testEnvironment=node', '--no-coverage', '--silent'],
    { encoding: 'utf8', cwd: ROOT }
  );

  const output = result.stdout + result.stderr;
  const suitePass = /Test Suites: (\d+) passed, 0 failed/.test(output);
  const totalMatch = output.match(/Tests:\s+(\d+) passed/);
  const totalCount = totalMatch ? Number(totalMatch[1]) : 0;

  return suites.map((s, i) => {
    const passLine = new RegExp(`PASS.*${s.pattern}`).test(output);
    return {
      label:  s.label,
      passed: passLine,
      count:  passLine ? Math.floor(totalCount / suites.length) : 0, // approximate
      reason: passLine ? null : `FAIL: ${s.pattern}`,
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log(`\n${B('QUANTIS — Complete Test Suite')}`);
  console.log(D(`Running ${NODE_TESTS.length + JEST_TESTS.length} test suites…\n`));

  const results = [];

  // Node tests
  console.log(B('── Node Tests (no dependencies) ──'));
  for (const suite of NODE_TESTS) {
    process.stdout.write(`  Running ${suite.label}… `);
    const r = runNodeTest(suite);
    results.push(r);
    if (r.passed) {
      console.log(G(`✓`) + D(` ${r.count} tests`));
    } else {
      console.log(R('✗'));
      if (r.reason) r.reason.split('\n').slice(0,2).forEach(l => console.log(R(`    ${l}`)));
    }
  }

  // Jest tests
  console.log(`\n${B('── Jest Tests ──')}`);
  process.stdout.write(`  Running all Jest suites… `);
  const jestResults = runJestTests(JEST_TESTS);
  jestResults.forEach(r => results.push(r));
  const jestPassed = jestResults.filter(r => r.passed).length;
  if (jestPassed === JEST_TESTS.length) {
    console.log(G(`✓`) + D(` ${jestResults.reduce((s,r) => s + r.count, 0)}+ tests`));
    jestResults.forEach(r => console.log(D(`    ✓ ${r.label}`)));
  } else {
    console.log(R(`✗ ${JEST_TESTS.length - jestPassed} suite(s) failed`));
    jestResults.filter(r => !r.passed).forEach(r => {
      console.log(R(`    ✗ ${r.label}`));
      if (r.reason) console.log(R(`      ${r.reason}`));
    });
  }

  // Summary
  const totalPassed = results.filter(r => r.passed).length;
  const totalFailed = results.filter(r => !r.passed).length;
  const totalTests  = results.reduce((s,r) => s + r.count, 0);

  console.log(`\n${'─'.repeat(62)}`);
  console.log(B(`  Test Suites: ${totalPassed}/${results.length} passed`));
  console.log(B(`  Individual:  ${totalTests}+ tests`));

  if (totalFailed === 0) {
    console.log(G(`\n  ✓ ALL SUITES PASSED\n`));
    process.exit(0);
  } else {
    console.log(R(`\n  ✗ ${totalFailed} SUITE(S) FAILED\n`));
    results.filter(r => !r.passed).forEach(r => console.log(R(`    • ${r.label}`)));
    console.log();
    process.exit(1);
  }
}

main();
