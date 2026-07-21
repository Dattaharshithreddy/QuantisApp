// ─────────────────────────────────────────────────────────────────────────────
// TradeReadinessCard  (v2.0.0)
//
// Presentational only — no business logic, no engine calls.
// Terminology locked to: Ready / Wait / Avoid / Why / What Should I Do /
// Risk If You Ignore This / Decision Breakdown / Timeframe Status /
// What Changes This / Next Review / Next Trigger
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { RADIUS } from '../../../theme/colors';
import type { TradeReadiness, TradeReadinessState, DecisionFactor, StrategyDisplayContext } from '../../../utils/mtf/tradeReadiness';
import type { Timeframe } from '../../../utils/mtf/mtfTypes';

// ── Visual config ─────────────────────────────────────────────────────────────
const STATE_CFG: Record<TradeReadinessState, { emoji: string; label: string; key: 'green' | 'amber' | 'red' }> = {
  READY: { emoji: '🟢', label: 'READY',  key: 'green' },
  WAIT:  { emoji: '🟡', label: 'WAIT',   key: 'amber' },
  AVOID: { emoji: '🔴', label: 'AVOID',  key: 'red'   },
};

const VERDICT_CFG: Record<DecisionFactor['verdict'], { emoji: string; key: 'green' | 'amber' | 'red' | 'textDim' }> = {
  BUY:     { emoji: '🟢', key: 'green'   },
  SELL:    { emoji: '🔴', key: 'red'     },
  WAIT:    { emoji: '🟡', key: 'amber'   },
  NEUTRAL: { emoji: '⚪', key: 'textDim' },
};

const ROLE_LABEL: Record<string, string> = {
  context:      'Context',
  timing:       'Timing',
  confirmation: 'Confirmation',
  structure:    'Structure',
};

const TF_SHORT: Record<Timeframe, string> = {
  '5m': '5M', '15m': '15M', '30m': '30M', '1h': '1H', '4h': '4H', '1d': '1D',
};

function resolveColor(key: string, T: any): string {
  if (key === 'amber') return T.amber ?? '#F59E0B';
  return T[key] ?? '#888';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, T }: { title: string; T: any }) {
  return (
    <Text style={{
      color: T.textDim, fontSize: 9, fontWeight: '700',
      letterSpacing: 0.6, marginBottom: 6, marginTop: 12,
    }}>
      {title}
    </Text>
  );
}

function Divider({ T }: { T: any }) {
  return <View style={{ height: 1, backgroundColor: T.textDim + '20', marginVertical: 2 }} />;
}

// "Why?" block — colored left border matching state
function WhyBlock({ text, color, T }: { text: string; color: string; T: any }) {
  return (
    <View style={{
      backgroundColor: color + '10',
      borderRadius: RADIUS.sm,
      borderLeftWidth: 3,
      borderLeftColor: color,
      padding: 10,
      marginTop: 4,
    }}>
      <Text style={{ color: T.text, fontSize: 12, lineHeight: 18 }}>{text}</Text>
    </View>
  );
}

// "What Should I Do?" numbered checklist
function ActionChecklist({ items, T }: { items: string[]; T: any }) {
  return (
    <View style={{ gap: 5 }}>
      {items.map((item, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
          <View style={{
            width: 18, height: 18, borderRadius: 9,
            backgroundColor: T.blue + '22',
            alignItems: 'center', justifyContent: 'center',
            marginTop: 1,
          }}>
            <Text style={{ color: T.blue, fontSize: 9, fontWeight: '800' }}>{i + 1}</Text>
          </View>
          <Text style={{ color: T.text, fontSize: 12, lineHeight: 18, flex: 1 }}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

// "Risk if you ignore this" — subtle warning box
function RiskBlock({ text, T }: { text: string; T: any }) {
  return (
    <View style={{
      backgroundColor: (T.red ?? '#EF4444') + '0D',
      borderRadius: RADIUS.sm,
      borderLeftWidth: 2,
      borderLeftColor: (T.red ?? '#EF4444') + '60',
      padding: 10,
    }}>
      <Text style={{ color: T.textSub ?? T.textDim, fontSize: 11, lineHeight: 16 }}>{text}</Text>
    </View>
  );
}

// Decision Breakdown — 2-column grid, role shown as subtitle
function DecisionBreakdown({ factors, T }: { factors: DecisionFactor[]; T: any }) {
  if (!factors.length) return null;
  // Pair into rows of 2
  const rows: DecisionFactor[][] = [];
  for (let i = 0; i < factors.length; i += 2) {
    rows.push(factors.slice(i, i + 2));
  }
  return (
    <View style={{ gap: 6 }}>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row', gap: 6 }}>
          {row.map((f, fi) => {
            const vcfg = VERDICT_CFG[f.verdict];
            const col  = resolveColor(vcfg.key, T);
            return (
              <View key={fi} style={{
                flex: 1,
                backgroundColor: T.bg3,
                borderRadius: RADIUS.sm,
                padding: 8,
                borderWidth: 1,
                borderColor: col + '30',
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                  <Text style={{ fontSize: 10 }}>{vcfg.emoji}</Text>
                  <Text style={{ color: col, fontSize: 10, fontWeight: '700', flexShrink: 1 }}>{f.verdict}</Text>
                </View>
                <Text style={{ color: T.text, fontSize: 10, fontWeight: '600', marginBottom: 1 }}>{f.engine}</Text>
                <Text style={{ color: T.textDim, fontSize: 8 }}>
                  {ROLE_LABEL[f.role] ?? f.role} · {f.detail}
                </Text>
              </View>
            );
          })}
          {/* If odd number of factors, pad the last row */}
          {row.length === 1 && <View style={{ flex: 1 }} />}
        </View>
      ))}
    </View>
  );
}

// Timeframe Status strip — horizontal, blocking TF highlighted
function TFStrip({ entries, T }: { entries: TradeReadiness['tfStrip']; T: any }) {
  if (!entries.length) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 5, flexWrap: 'wrap' }}>
      {entries.map(({ tf, direction, isCurrent, isBlocking }) => {
        const col = direction === 'BULLISH' ? T.green
                  : direction === 'BEARISH' ? (T.red ?? '#EF4444')
                  : (T.amber ?? '#F59E0B');
        const arrow = direction === 'BULLISH' ? '▲' : direction === 'BEARISH' ? '▼' : '→';
        return (
          <View key={tf} style={{
            backgroundColor: isBlocking ? col + '22' : col + '10',
            borderRadius: RADIUS.sm,
            paddingHorizontal: 9,
            paddingVertical: 6,
            borderWidth: isBlocking ? 1.5 : 1,
            borderColor: isBlocking ? col : col + '40',
            alignItems: 'center',
            minWidth: 46,
          }}>
            <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700' }}>
              {TF_SHORT[tf]}{isCurrent ? ' ●' : ''}
            </Text>
            <Text style={{ color: col, fontSize: 12, fontWeight: '800', marginTop: 1 }}>{arrow}</Text>
            {isBlocking && (
              <Text style={{ color: col, fontSize: 7, fontWeight: '700', marginTop: 1 }}>BLOCKING</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

// Next Trigger — future notification hook, visually distinct
function NextTriggerBlock({ text, T }: { text: string; T: any }) {
  return (
    <View style={{
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: T.blue + '0D',
      borderRadius: RADIUS.sm,
      borderWidth: 1,
      borderColor: T.blue + '30',
      padding: 10,
    }}>
      <Text style={{ fontSize: 14, marginTop: 1 }}>🔔</Text>
      <View style={{ flex: 1 }}>
        <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.4, marginBottom: 2 }}>
          NEXT TRIGGER
        </Text>
        <Text style={{ color: T.text, fontSize: 11, lineHeight: 16 }}>{text}</Text>
      </View>
    </View>
  );
}

// Strategy context block — display-only, shown when a strategy is active
// No decision logic. Reads only: strategyName, icon, preferredTimeframes,
// holdingLabel, watchFor, notes.
function StrategyContextBlock({ ctx, T }: { ctx: StrategyDisplayContext; T: any }) {
  return (
    <View style={{
      backgroundColor: T.bg3,
      borderRadius: 8,
      padding: 10,
      borderWidth: 1,
      borderColor: T.textDim + '30',
      gap: 6,
    }}>
      {/* Strategy identity */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <Text style={{ fontSize: 14 }}>{ctx.strategyIcon}</Text>
        <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>
          {ctx.strategyName} Strategy
        </Text>
        <View style={{
          backgroundColor: T.blue + '22', borderRadius: 4,
          paddingHorizontal: 6, paddingVertical: 2, marginLeft: 'auto',
        }}>
          <Text style={{ color: T.blue, fontSize: 8, fontWeight: '700' }}>
            h={ctx.predictionHorizon}
          </Text>
        </View>
      </View>

      {/* Preferred timeframes */}
      {ctx.preferredTimeframes.length > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', width: 52 }}>
            TIMEFRAME
          </Text>
          <Text style={{ color: T.text, fontSize: 11 }}>
            {ctx.preferredTimeframes.join(' · ')}
          </Text>
        </View>
      )}

      {/* Expected holding period */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', width: 52 }}>
          HOLD
        </Text>
        <Text style={{ color: T.text, fontSize: 11 }}>{ctx.holdingLabel}</Text>
      </View>

      {/* What to watch for */}
      {ctx.watchFor.length > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', width: 52, marginTop: 1 }}>
            WATCH
          </Text>
          <Text style={{ color: T.text, fontSize: 11, flex: 1, lineHeight: 16 }}>
            {ctx.watchFor}
          </Text>
        </View>
      )}

      {/* Optional notes */}
      {ctx.notes.length > 0 && (
        <Text style={{ color: T.textDim, fontSize: 10, fontStyle: 'italic', lineHeight: 14, marginTop: 2 }}>
          {ctx.notes}
        </Text>
      )}
    </View>
  );
}

// DEV debug row — hidden in production
function DevRow({ mtfScore, chochAlignment, htfBias, T }: {
  mtfScore: number; chochAlignment: number; htfBias: number; T: any;
}) {
  if (!__DEV__) return null;
  return (
    <View style={{ marginTop: 10, padding: 6, backgroundColor: T.bg0, borderRadius: 4, borderWidth: 1, borderColor: T.textDim + '30' }}>
      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', marginBottom: 2 }}>DEV — raw MTF (remove before production)</Text>
      <Text style={{ color: T.textDim, fontSize: 8 }}>
        Overall: {(mtfScore * 100).toFixed(0)}% · CHoCH: {chochAlignment.toFixed(2)} · HTF bias: {htfBias > 0 ? '▲' : htfBias < 0 ? '▼' : '—'}
      </Text>
    </View>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
type Props = {
  readiness:       TradeReadiness;
  mtfScore?:       number;
  chochAlignment?: number;
  htfBias?:        number;
  T: any;
};

export function TradeReadinessCard({
  readiness, mtfScore = 0, chochAlignment = 0, htfBias = 0, T,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  // ── Unavailable fallback ──────────────────────────────────────────────────
  if (readiness.unavailable) {
    return (
      <View style={{
        marginBottom: 14, backgroundColor: T.bg3,
        borderRadius: RADIUS.md, padding: 12,
        borderWidth: 1, borderColor: T.textDim + '22',
      }}>
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 }}>
          TRADE READINESS
        </Text>
        <Text style={{ color: T.textSub ?? T.textDim, fontSize: 12 }}>
          Trade Readiness unavailable. Waiting for market data.
        </Text>
      </View>
    );
  }

  const cfg   = STATE_CFG[readiness.state];
  const color = resolveColor(cfg.key, T);

  return (
    <View style={{
      marginBottom: 14, borderRadius: RADIUS.md,
      borderWidth: 1, borderColor: color + '40', overflow: 'hidden',
    }}>

      {/* ── Collapsed row ──────────────────────────────────────────────── */}
      <TouchableOpacity
        onPress={() => setExpanded(e => !e)}
        activeOpacity={0.75}
        style={{
          flexDirection: 'row', alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 12, paddingVertical: 11,
          backgroundColor: color + '12',
        }}
      >
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 }}>
          TRADE READINESS
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: color, fontSize: 13, fontWeight: '800' }}>
            {cfg.emoji} {cfg.label}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 11 }}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {/* ── Expanded detail ─────────────────────────────────────────────── */}
      {expanded && (
        <View style={{ padding: 12, backgroundColor: T.bg1 }}>

          {/* WHY? */}
          <SectionHeader title="WHY?" T={T} />
          <WhyBlock text={readiness.whyText} color={color} T={T} />

          <Divider T={T} />

          {/* WHAT SHOULD I DO? */}
          <SectionHeader title="WHAT SHOULD I DO?" T={T} />
          <ActionChecklist items={readiness.actionChecklist} T={T} />

          <Divider T={T} />

          {/* RISK IF YOU IGNORE THIS */}
          <SectionHeader title="RISK IF YOU IGNORE THIS" T={T} />
          <RiskBlock text={readiness.riskStatement} T={T} />

          <Divider T={T} />

          {/* DECISION BREAKDOWN */}
          {readiness.decisionFactors.length > 0 && (
            <>
              <SectionHeader title="DECISION BREAKDOWN" T={T} />
              <DecisionBreakdown factors={readiness.decisionFactors} T={T} />
              {readiness.state !== 'READY' && readiness.conflictNote.length > 0 && (
                <Text style={{ color: T.textDim, fontSize: 10, marginTop: 6, fontStyle: 'italic', lineHeight: 14 }}>
                  {readiness.conflictNote}
                </Text>
              )}
              <Divider T={T} />
            </>
          )}

          {/* TIMEFRAME STATUS */}
          {readiness.tfStrip.length > 0 && (
            <>
              <SectionHeader title="TIMEFRAME STATUS" T={T} />
              <TFStrip entries={readiness.tfStrip} T={T} />
              <Divider T={T} />
            </>
          )}

          {/* Strategy blockers — grouped by type when multiple exist */}
          {(() => {
            const allBlockers: { source: string; reason: string; severity: string }[] =
              (readiness as any).strategyBlockers ?? [];

            // Group map — pure UI categorisation, no new logic
            const GROUPS: { label: string; sources: string[] }[] = [
              { label: 'MARKET CONDITIONS',      sources: ['REGIME', 'MTF'] },
              { label: 'SIGNAL QUALITY',          sources: ['CONFIDENCE'] },
              { label: 'STRATEGY REQUIREMENTS',   sources: ['BOS', 'PATTERN', 'SMC'] },
            ];

            if (allBlockers.length === 0) {
              // No strategy blockers — show the engine-derived primary blocker as-is
              return (
                <>
                  <SectionHeader title="PRIMARY BLOCKER" T={T} />
                  <Text style={{ color: T.text, fontSize: 12, lineHeight: 17, marginBottom: 10 }}>
                    {readiness.primaryBlocker}
                  </Text>
                </>
              );
            }

            // Build groups that have at least one blocker
            const activeGroups = GROUPS
              .map(g => ({ ...g, items: allBlockers.filter(b => g.sources.includes(b.source)) }))
              .filter(g => g.items.length > 0);

            return (
              <View style={{ marginBottom: 10 }}>
                <SectionHeader title="BLOCKERS" T={T} />
                {activeGroups.map((group, gi) => (
                  <View key={gi} style={{ marginBottom: 8 }}>
                    {/* Group label */}
                    <Text style={{
                      color: T.textDim, fontSize: 8, fontWeight: '700',
                      letterSpacing: 0.6, marginBottom: 4,
                    }}>
                      {group.label}
                    </Text>
                    {/* Blocker rows */}
                    {group.items.map((b, bi) => {
                      const isPrimary = gi === 0 && bi === 0 && allBlockers[0] === b;
                      const dotCol = b.severity === 'AVOID'
                        ? (T.red ?? '#EF4444')
                        : (T.amber ?? '#F59E0B');
                      return (
                        <View key={bi} style={{
                          flexDirection: 'row', gap: 6, marginBottom: 3,
                          paddingLeft: 4,
                        }}>
                          <Text style={{ color: dotCol, fontSize: 10, marginTop: 2 }}>
                            {b.severity === 'AVOID' ? '✕' : '•'}
                          </Text>
                          <Text style={{
                            color: isPrimary ? T.text : (T.textSub ?? T.textDim),
                            fontSize: isPrimary ? 12 : 11,
                            fontWeight: isPrimary ? '600' : '400',
                            lineHeight: 16, flex: 1,
                          }}>
                            {b.reason}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                ))}
              </View>
            );
          })()}

          <SectionHeader title="WHAT CHANGES THIS" T={T} />
          <Text style={{ color: T.text, fontSize: 12, lineHeight: 17, marginBottom: 10 }}>
            {readiness.flipCondition}
          </Text>

          <SectionHeader title="NEXT REVIEW" T={T} />
          <Text style={{ color: T.text, fontSize: 12, marginBottom: 10 }}>
            Reassess {readiness.nextReviewLabel}.
          </Text>

          {/* STRATEGY CONTEXT — display only, shown when a strategy is active */}
          {readiness.strategyContext && (
            <>
              <SectionHeader title="STRATEGY CONTEXT" T={T} />
              <StrategyContextBlock ctx={readiness.strategyContext} T={T} />
              <Divider T={T} />
            </>
          )}

          {/* NEXT TRIGGER */}
          <NextTriggerBlock text={readiness.nextTrigger} T={T} />

          {/* DEV debug */}
          <DevRow mtfScore={mtfScore} chochAlignment={chochAlignment} htfBias={htfBias} T={T} />
        </View>
      )}
    </View>
  );
}
