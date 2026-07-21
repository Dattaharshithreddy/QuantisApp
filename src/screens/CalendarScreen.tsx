// ─────────────────────────────────────────────────────────────────────────────
// MARKET INTELLIGENCE CALENDAR  — CalendarScreen.tsx  v2.1.0
//
// Extends the original CalendarScreen. Architecture:
//   • marketIntelligenceCalendar.ts  → data engine (events, filters, scoring,
//                                       watchlist relevance — pure, no React)
//   • This file                      → UI layer only; reads DataContext and
//                                       paper/live portfolios, passes them in
//
// IMPLEMENTED:
//   ✅ Event Categories (India / US / Global / Crypto)
//   ✅ Impact Rating chips (CRITICAL / HIGH / MEDIUM / LOW)
//   ✅ Affected Markets icons
//   ✅ Live Countdown (ticks every minute)
//   ✅ Trading Guidance (educational risk awareness)
//   ✅ Historical Volatility (stored constants only — no fabrication)
//   ✅ Search & Filters (country / impact / asset / category)
//   ✅ Today's Summary card (risk level, affected assets)
//   ✅ Timeline View (Morning / Afternoon / Evening / Night)
//   ✅ Event Detail cards (expandable)
//   ✅ Official Source links
//   ✅ AI Market Impact summary (deterministic, educational)
//   ✅ Calendar Intelligence Score
//   ✅ Offline caching (AsyncStorage)
//   ✅ Notification reminders (1 day / 1 hour / 15 min)
//   ✅ Watchlist Awareness — reads allAssets from DataContext + open paper/live
//       positions; highlights relevant events with a per-event banner and shows
//       a "Your Watchlist" section at the top for quick triage
//
// FUTURE ENHANCEMENTS:
//   🔲 Live official data API (RBI, BLS, ECB) integration
//   🔲 Election event tracker with real dates
//   🔲 Push notification deep-link handler
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  Linking, ActivityIndicator, RefreshControl, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, Pill, SectionLabel } from '../components/Common';
import { RADIUS, SPACING } from '../theme/colors';
import { getPortfolio } from '../utils/paperPortfolio';
import { getLivePortfolio } from '../utils/livePortfolio';
import {
  MarketEvent, EventRegion, ImpactRating, AffectedAsset,
  WatchlistRelevance,
  getMarketEvents, getEventsByFilter, getDailySummary, getCalendarIntelligenceScore,
  formatCountdown, getCountdownUrgency, groupByTimeSlot,
  getAIMarketImpactSummary, saveCachedEvents, loadCachedEvents,
  scheduleEventReminder, cancelEventReminders, hasReminder,
  getWatchlistRelevance, getWatchlistRelevantEvents,
  RiskLevel, TimeSlot, CalendarFilter,
} from '../utils/marketIntelligenceCalendar';

// ── Constants ──────────────────────────────────────────────────────────────────

const REGION_META: Record<EventRegion, { label: string; flag: string }> = {
  IN:     { label: 'India',  flag: '🇮🇳' },
  US:     { label: 'US',     flag: '🇺🇸' },
  GLOBAL: { label: 'Global', flag: '🌍' },
  CRYPTO: { label: 'Crypto', flag: '₿'  },
};

const IMPACT_META: Record<ImpactRating, { label: string; color: (T: any) => string }> = {
  CRITICAL: { label: 'CRITICAL', color: T => T.red    },
  HIGH:     { label: 'HIGH',     color: T => T.orange  },
  MEDIUM:   { label: 'MEDIUM',   color: T => T.amber   },
  LOW:      { label: 'LOW',      color: T => T.textDim },
};

const ASSET_ICON: Record<AffectedAsset, string> = {
  NIFTY:     '📊',
  BANKNIFTY: '🏦',
  USDINR:    '💱',
  GOLD:      '🪙',
  SILVER:    '🥈',
  CRUDE:     '🛢️',
  BTC:       '₿',
  ETH:       '⟠',
  ALTCOINS:  '🔮',
};

const TIMESLOT_META: Record<TimeSlot, { label: string; icon: string; timeRange: string }> = {
  MORNING:   { label: 'Morning',   icon: '🌅', timeRange: '6:00 – 12:00' },
  AFTERNOON: { label: 'Afternoon', icon: '☀️', timeRange: '12:00 – 18:00' },
  EVENING:   { label: 'Evening',   icon: '🌆', timeRange: '18:00 – 21:00' },
  NIGHT:     { label: 'Night',     icon: '🌙', timeRange: '21:00 – 06:00' },
  ALL_DAY:   { label: 'All Day',   icon: '📅', timeRange: 'Full day event' },
};

const RISK_LEVEL_META: Record<RiskLevel, { label: string; color: (T: any) => string; bg: (T: any) => string }> = {
  LOW_RISK:           { label: 'Low Risk',          color: T => T.green,  bg: T => T.green  + '18' },
  MODERATE_RISK:      { label: 'Moderate Risk',      color: T => T.amber,  bg: T => T.amber  + '18' },
  HIGH_RISK:          { label: 'High Risk',          color: T => T.orange, bg: T => T.orange + '18' },
  EXTREME_VOLATILITY: { label: 'Extreme Volatility', color: T => T.red,   bg: T => T.red    + '18' },
};

const ALL_REGIONS: EventRegion[]   = ['IN', 'US', 'GLOBAL', 'CRYPTO'];
const ALL_IMPACTS: ImpactRating[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// ── ImpactChip ────────────────────────────────────────────────────────────────

function ImpactChip({ impact, theme: T }: { impact: ImpactRating; theme: any }) {
  const meta  = IMPACT_META[impact];
  const color = meta.color(T);
  return (
    <View style={{
      paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.pill,
      backgroundColor: color + '22', borderWidth: 1, borderColor: color + '55',
    }}>
      <Text style={{ color, fontSize: 9, fontWeight: '800', letterSpacing: 0.8 }}>{meta.label}</Text>
    </View>
  );
}

// ── AssetIcon ─────────────────────────────────────────────────────────────────

function AssetIcon({ asset, theme: T }: { asset: AffectedAsset; theme: any }) {
  return (
    <View style={{ alignItems: 'center', marginRight: 8 }}>
      <Text style={{ fontSize: 14 }}>{ASSET_ICON[asset]}</Text>
      <Text style={{ color: T.textDim, fontSize: 7, marginTop: 1, fontWeight: '600' }}>
        {asset === 'BANKNIFTY' ? 'BKNIFTY' : asset}
      </Text>
    </View>
  );
}

// ── CountdownBadge ────────────────────────────────────────────────────────────

function CountdownBadge({ date, theme: T }: { date: Date; theme: any }) {
  const urgency  = getCountdownUrgency(date);
  const color    = urgency === 'CRITICAL' ? T.red : urgency === 'HIGH' ? T.orange : urgency === 'MEDIUM' ? T.amber : T.textDim;
  const countdown = formatCountdown(date);
  return (
    <View style={{
      backgroundColor: color + '18', borderRadius: RADIUS.sm,
      borderWidth: 1, borderColor: color + '40',
      paddingHorizontal: 8, paddingVertical: 4, alignItems: 'center', minWidth: 64,
    }}>
      <Text style={{ color, fontSize: 14, fontWeight: '800' }}>{countdown}</Text>
      <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>
        {date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
      </Text>
    </View>
  );
}

// ── VolatilityStats ───────────────────────────────────────────────────────────

function VolatilityStats({ event, theme: T }: { event: MarketEvent; theme: any }) {
  if (!event.historicalVol) {
    return (
      <Text style={{ color: T.textDim, fontSize: 10, fontStyle: 'italic', marginTop: 4 }}>
        Historical analysis unavailable.
      </Text>
    );
  }
  return (
    <View>
      <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 6, marginTop: 4 }}>
        AVG MOVE ON EVENT DAY
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {event.historicalVol.map(v => (
          <View key={v.asset} style={{
            backgroundColor: T.bg1, borderRadius: RADIUS.sm,
            padding: 8, minWidth: 72, alignItems: 'center',
          }}>
            <Text style={{ fontSize: 14 }}>{ASSET_ICON[v.asset]}</Text>
            <Text style={{ color: T.amber, fontSize: 11, fontWeight: '800', marginTop: 2 }}>
              ±{v.avgMovePct}%
            </Text>
            <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>{v.asset}</Text>
            <Text style={{ color: T.textDim, fontSize: 7 }}>n={v.sampleSize}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── WatchlistBanner ───────────────────────────────────────────────────────────
// Rendered inside EventCard when relevance.isRelevant === true.
// Shows which of the user's watchlist symbols are affected, with a stronger
// highlight when there's an open position at risk.

function WatchlistBanner({ relevance, theme: T }: { relevance: WatchlistRelevance; theme: any }) {
  if (!relevance.isRelevant) return null;

  const color    = relevance.hasOpenPosition ? T.red : T.amber;
  const icon     = relevance.hasOpenPosition ? '🔴' : '⚡';
  const headline = relevance.hasOpenPosition
    ? 'Open position at risk'
    : 'In your watchlist';

  return (
    <View style={{
      marginTop: SPACING.sm,
      backgroundColor: color + '12',
      borderRadius: RADIUS.sm,
      borderWidth: 1,
      borderColor: color + '45',
      padding: SPACING.sm,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <Text style={{ fontSize: 12 }}>{icon}</Text>
        <Text style={{ color, fontSize: 11, fontWeight: '800' }}>{headline}</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {relevance.allMatchedSymbols.map(sym => (
          <View key={sym} style={{
            paddingHorizontal: 8, paddingVertical: 3,
            backgroundColor: color + '20',
            borderRadius: RADIUS.pill,
            borderWidth: 1, borderColor: color + '50',
          }}>
            <Text style={{ color, fontSize: 10, fontWeight: '700' }}>{sym}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── WatchlistSummaryCard ──────────────────────────────────────────────────────
// Top-of-screen card that summarises which upcoming events affect the user's
// portfolio, ranked open-positions first. Only rendered when there's at least
// one relevant event.

function WatchlistSummaryCard({
  events,
  watchlistRelevanceMap,
  onEventPress,
  theme: T,
}: {
  events: MarketEvent[];
  watchlistRelevanceMap: Map<string, WatchlistRelevance>;
  onEventPress: (id: string) => void;
  theme: any;
}) {
  const relevant = events
    .map(e => ({ event: e, relevance: watchlistRelevanceMap.get(e.id) }))
    .filter(x => x.relevance?.isRelevant)
    .sort((a, b) => {
      const aPos = a.relevance!.hasOpenPosition ? 0 : 1;
      const bPos = b.relevance!.hasOpenPosition ? 0 : 1;
      if (aPos !== bPos) return aPos - bPos;
      return a.event.date.getTime() - b.event.date.getTime();
    })
    .slice(0, 4); // top 4 is enough for a summary card

  if (relevant.length === 0) return null;

  const hasOpenRisk = relevant.some(r => r.relevance!.hasOpenPosition);

  return (
    <Card theme={T} style={{
      marginBottom: SPACING.lg,
      borderColor: hasOpenRisk ? T.red + '50' : T.amber + '40',
      borderWidth: 1.5,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: SPACING.sm }}>
        <Text style={{ fontSize: 16 }}>👤</Text>
        <Text style={{ color: T.text, fontWeight: '800', fontSize: 14 }}>Your Watchlist</Text>
        {hasOpenRisk && (
          <View style={{
            paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.pill,
            backgroundColor: T.red + '20', borderWidth: 1, borderColor: T.red + '50',
          }}>
            <Text style={{ color: T.red, fontSize: 9, fontWeight: '800' }}>POSITION AT RISK</Text>
          </View>
        )}
      </View>

      {relevant.map(({ event, relevance }) => {
        const color = relevance!.hasOpenPosition ? T.red : T.amber;
        const posIcon = relevance!.hasOpenPosition ? '🔴' : '⚡';
        return (
          <TouchableOpacity
            key={event.id}
            onPress={() => onEventPress(event.id)}
            style={{
              flexDirection: 'row', alignItems: 'flex-start',
              gap: 8, marginBottom: 10,
              paddingBottom: 10,
              borderBottomWidth: 1, borderBottomColor: T.border,
            }}
          >
            <Text style={{ fontSize: 12, marginTop: 1 }}>{posIcon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.text, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
                {event.title}
              </Text>
              <Text style={{ color: color, fontSize: 10, marginTop: 2 }}>
                {relevance!.summaryLine}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: T.textDim, fontSize: 10 }}>{formatCountdown(event.date)}</Text>
              <ImpactChip impact={event.impact} theme={T} />
            </View>
          </TouchableOpacity>
        );
      })}

      <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2, fontStyle: 'italic' }}>
        Events shown are based on your current watchlist assets and open positions.
        This is educational context only — not financial advice.
      </Text>
    </Card>
  );
}

// ── EventCard ─────────────────────────────────────────────────────────────────

function EventCard({
  event, expanded, onToggle,
  reminderSet, onScheduleReminder, onCancelReminder,
  relevance,
  theme: T,
}: {
  event: MarketEvent;
  expanded: boolean;
  onToggle: () => void;
  reminderSet: boolean;
  onScheduleReminder: (id: string) => void;
  onCancelReminder:   (id: string) => void;
  relevance?: WatchlistRelevance;
  theme: any;
}) {
  const impactColor = IMPACT_META[event.impact].color(T);
  const regionMeta  = REGION_META[event.region];
  const isCritical  = event.impact === 'CRITICAL';

  return (
    <Card
      theme={T}
      style={{
        marginBottom: 10,
        borderColor:  isCritical ? T.red + '50' : event.impact === 'HIGH' ? T.orange + '35' : T.cardBorder,
        borderWidth:  isCritical ? 1.5 : 1,
      }}
    >
      <TouchableOpacity onPress={onToggle} activeOpacity={0.85}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm }}>
          <Text style={{ fontSize: 20, marginTop: 2 }}>{regionMeta.flag}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.text, fontWeight: '700', fontSize: 13, lineHeight: 18 }}>
              {event.title}
            </Text>
            {event.estimatedTime && (
              <Text style={{ color: T.textDim, fontSize: 10, marginTop: 1 }}>
                🕐 {event.estimatedTime}
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <ImpactChip impact={event.impact} theme={T} />
              <View style={{
                paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.pill,
                backgroundColor: T.teal + '18', borderWidth: 1, borderColor: T.teal + '40',
              }}>
                <Text style={{ color: T.teal, fontSize: 9, fontWeight: '700' }}>
                  {regionMeta.flag} {regionMeta.label}
                </Text>
              </View>
            </View>
          </View>
          <CountdownBadge date={event.date} theme={T} />
        </View>

        {/* Affected assets row */}
        <View style={{ flexDirection: 'row', marginTop: SPACING.sm, flexWrap: 'wrap' }}>
          {event.affectedAssets.map(a => <AssetIcon key={a} asset={a} theme={T} />)}
        </View>

        {/* Watchlist awareness banner — only shown when this event matches the user's assets */}
        {relevance && <WatchlistBanner relevance={relevance} theme={T} />}

        {/* Teaser guidance (collapsed only) */}
        {!expanded && (
          <Text
            style={{ color: T.textSub, fontSize: 11, marginTop: SPACING.sm, lineHeight: 15 }}
            numberOfLines={2}
          >
            {event.tradingGuidance[0]}
          </Text>
        )}

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 6 }}>
          <Text style={{ color: T.textDim, fontSize: 10 }}>{expanded ? '▲ Less' : '▼ Details'}</Text>
        </View>
      </TouchableOpacity>

      {/* ── Expanded detail ── */}
      {expanded && (
        <View style={{
          marginTop: SPACING.md, borderTopWidth: 1,
          borderTopColor: T.border, paddingTop: SPACING.md,
        }}>

          <SectionLabel theme={T}>WHAT IS THIS EVENT</SectionLabel>
          <Text style={{ color: T.textSub, fontSize: 12, lineHeight: 18, marginBottom: SPACING.md }}>
            {event.description}
          </Text>

          <SectionLabel theme={T}>WHY IT MATTERS</SectionLabel>
          <Text style={{ color: T.textSub, fontSize: 12, lineHeight: 18, marginBottom: SPACING.md }}>
            {event.whyItMatters}
          </Text>

          <SectionLabel theme={T}>RISK AWARENESS (educational only — not financial advice)</SectionLabel>
          <View style={{ marginBottom: SPACING.md }}>
            {event.tradingGuidance.map((note, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: 6 }}>
                <Text style={{ color: T.amber, fontSize: 12, marginTop: 1 }}>⚠</Text>
                <Text style={{ color: T.textSub, fontSize: 12, lineHeight: 17, flex: 1 }}>{note}</Text>
              </View>
            ))}
          </View>

          <SectionLabel theme={T}>HISTORICAL VOLATILITY</SectionLabel>
          <VolatilityStats event={event} theme={T} />

          {/* AI Market Impact */}
          <View style={{
            marginTop: SPACING.md, backgroundColor: T.blue + '10',
            borderRadius: RADIUS.md, padding: SPACING.md,
            borderWidth: 1, borderColor: T.blue + '25',
          }}>
            <SectionLabel theme={T}>🤖 AI MARKET IMPACT CONTEXT</SectionLabel>
            <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 17 }}>
              {getAIMarketImpactSummary(event)}
            </Text>
          </View>

          {/* Official Source */}
          {event.officialSource && (
            <TouchableOpacity
              style={{ marginTop: SPACING.md, flexDirection: 'row', alignItems: 'center', gap: 6 }}
              onPress={() => Linking.openURL(event.officialSource!.url)}
            >
              <Text style={{ color: T.blue, fontSize: 11, fontWeight: '700' }}>
                🔗 Official Source: {event.officialSource.label}
              </Text>
            </TouchableOpacity>
          )}

          {/* Reminders */}
          <View style={{
            marginTop: SPACING.md, borderTopWidth: 1,
            borderTopColor: T.border, paddingTop: SPACING.md,
          }}>
            <SectionLabel theme={T}>SET REMINDER</SectionLabel>
            {reminderSet ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ color: T.green, fontSize: 11 }}>🔔 Reminder set</Text>
                <TouchableOpacity
                  onPress={() => onCancelReminder(event.id)}
                  style={{
                    paddingHorizontal: 10, paddingVertical: 5,
                    borderRadius: RADIUS.sm, borderWidth: 1, borderColor: T.red + '50',
                  }}
                >
                  <Text style={{ color: T.red, fontSize: 10 }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {(['1 Day Before', '1 Hour Before', '15 Min Before'] as const).map((label, i) => {
                  const offsets = ['DAY_BEFORE', 'HOUR_BEFORE', 'FIFTEEN_BEFORE'] as const;
                  return (
                    <TouchableOpacity
                      key={label}
                      onPress={async () => {
                        await scheduleEventReminder(event, offsets[i]);
                        onScheduleReminder(event.id);
                      }}
                      style={{
                        paddingHorizontal: 10, paddingVertical: 6,
                        borderRadius: RADIUS.sm, backgroundColor: T.bg1,
                        borderWidth: 1, borderColor: T.border2,
                      }}
                    >
                      <Text style={{ color: T.text, fontSize: 10, fontWeight: '600' }}>🔔 {label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>
        </View>
      )}
    </Card>
  );
}

// ── TodaySummaryCard ──────────────────────────────────────────────────────────

function TodaySummaryCard({ theme: T }: { theme: any }) {
  const summary  = getDailySummary();
  const riskMeta = RISK_LEVEL_META[summary.riskLevel];
  const color    = riskMeta.color(T);

  return (
    <Card theme={T} style={{ marginBottom: SPACING.lg, borderColor: color + '40', borderWidth: 1.5 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.sm }}>
        <Text style={{ color: T.text, fontWeight: '800', fontSize: 14 }}>📅 Today's Events</Text>
        <View style={{
          paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.pill,
          backgroundColor: riskMeta.bg(T), borderWidth: 1, borderColor: color + '50',
        }}>
          <Text style={{ color, fontSize: 10, fontWeight: '800' }}>{riskMeta.label.toUpperCase()}</Text>
        </View>
      </View>

      {summary.events.length === 0 ? (
        <Text style={{ color: T.textDim, fontSize: 12 }}>No major events today — normal trading conditions.</Text>
      ) : (
        <>
          {summary.events.slice(0, 3).map(e => (
            <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Text style={{ fontSize: 12 }}>{REGION_META[e.region].flag}</Text>
              <Text style={{ color: T.text, fontSize: 12, flex: 1 }} numberOfLines={1}>{e.title}</Text>
              <ImpactChip impact={e.impact} theme={T} />
            </View>
          ))}
          {summary.events.length > 3 && (
            <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>
              +{summary.events.length - 3} more today
            </Text>
          )}
        </>
      )}

      {summary.topAffectedAssets.length > 0 && (
        <View style={{ marginTop: SPACING.sm, borderTopWidth: 1, borderTopColor: T.border, paddingTop: SPACING.sm }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6 }}>
            MARKETS MOST AFFECTED
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {summary.topAffectedAssets.map(a => (
              <View key={a} style={{
                flexDirection: 'row', alignItems: 'center', gap: 4,
                backgroundColor: T.bg1, borderRadius: RADIUS.sm,
                paddingHorizontal: 8, paddingVertical: 4,
              }}>
                <Text style={{ fontSize: 12 }}>{ASSET_ICON[a]}</Text>
                <Text style={{ color: T.text, fontSize: 10, fontWeight: '600' }}>{a}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {summary.tradingConsiderations.length > 0 && (
        <Text style={{ color: T.amber, fontSize: 10, marginTop: SPACING.sm, lineHeight: 15 }}>
          ⚠ {summary.tradingConsiderations[0]}
        </Text>
      )}
    </Card>
  );
}

// ── IntelligenceBanner ────────────────────────────────────────────────────────

function IntelligenceBanner({ theme: T }: { theme: any }) {
  const score    = getCalendarIntelligenceScore(7);
  const riskMeta = RISK_LEVEL_META[score.riskLevel];
  const color    = riskMeta.color(T);

  return (
    <Card theme={T} style={{ marginBottom: SPACING.lg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>7-Day Intelligence Score</Text>
        <Text style={{ color, fontWeight: '800', fontSize: 22 }}>{score.score}</Text>
      </View>
      <View style={{ backgroundColor: T.bg1, borderRadius: RADIUS.pill, height: 6, overflow: 'hidden', marginBottom: 8 }}>
        <View style={{
          width: `${score.score}%` as any, height: 6,
          backgroundColor: color, borderRadius: RADIUS.pill,
        }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color, fontSize: 11, fontWeight: '700' }}>{riskMeta.label}</Text>
        <Text style={{ color: T.textDim, fontSize: 10 }}>{score.eventCount} events in next 7 days</Text>
      </View>
    </Card>
  );
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

function FilterBar({ filter, onChange, theme: T }: {
  filter: CalendarFilter;
  onChange: (f: CalendarFilter) => void;
  theme: any;
}) {
  const [searchText, setSearchText] = useState(filter.searchQuery ?? '');

  const toggleRegion = (r: EventRegion) => {
    const cur  = filter.regions ?? [];
    const next = cur.includes(r) ? cur.filter(x => x !== r) : [...cur, r];
    onChange({ ...filter, regions: next.length === ALL_REGIONS.length ? [] : next });
  };

  const toggleImpact = (i: ImpactRating) => {
    const cur  = filter.impacts ?? [];
    const next = cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i];
    onChange({ ...filter, impacts: next.length === ALL_IMPACTS.length ? [] : next });
  };

  return (
    <View style={{ marginBottom: SPACING.lg }}>
      {/* Search */}
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: T.bg1, borderRadius: RADIUS.md,
        borderWidth: 1, borderColor: T.border, paddingHorizontal: 12, marginBottom: SPACING.sm,
      }}>
        <Text style={{ color: T.textDim, fontSize: 14, marginRight: 8 }}>🔍</Text>
        <TextInput
          value={searchText}
          onChangeText={t => { setSearchText(t); onChange({ ...filter, searchQuery: t }); }}
          placeholder="Search events, assets, categories…"
          placeholderTextColor={T.textDim}
          style={{ flex: 1, color: T.text, fontSize: 13, paddingVertical: 10 }}
        />
        {searchText.length > 0 && (
          <TouchableOpacity onPress={() => { setSearchText(''); onChange({ ...filter, searchQuery: '' }); }}>
            <Text style={{ color: T.textDim, fontSize: 14 }}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Region chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: SPACING.sm }}>
        {ALL_REGIONS.map(r => {
          const active = !filter.regions?.length || filter.regions.includes(r);
          const meta   = REGION_META[r];
          return (
            <TouchableOpacity
              key={r}
              onPress={() => toggleRegion(r)}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 4,
                paddingHorizontal: 12, paddingVertical: 7, borderRadius: RADIUS.pill,
                marginRight: 8,
                backgroundColor: active ? T.teal + '20' : T.bg1,
                borderWidth: 1, borderColor: active ? T.teal + '60' : T.border,
              }}
            >
              <Text style={{ fontSize: 13 }}>{meta.flag}</Text>
              <Text style={{ color: active ? T.teal : T.textDim, fontSize: 11, fontWeight: '700' }}>
                {meta.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Impact chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {ALL_IMPACTS.map(i => {
          const active = !filter.impacts?.length || filter.impacts.includes(i);
          const color  = IMPACT_META[i].color(T);
          return (
            <TouchableOpacity
              key={i}
              onPress={() => toggleImpact(i)}
              style={{
                paddingHorizontal: 12, paddingVertical: 6, borderRadius: RADIUS.pill, marginRight: 8,
                backgroundColor: active ? color + '20' : T.bg1,
                borderWidth: 1, borderColor: active ? color + '60' : T.border,
              }}
            >
              <Text style={{ color: active ? color : T.textDim, fontSize: 11, fontWeight: '700' }}>{i}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ── TimelineSection ───────────────────────────────────────────────────────────

function TimelineSection({
  slot, events, expandedId, onToggle,
  reminders, onScheduleReminder, onCancelReminder,
  relevanceMap,
  theme: T,
}: {
  slot: TimeSlot;
  events: MarketEvent[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  reminders: Record<string, boolean>;
  onScheduleReminder: (id: string) => void;
  onCancelReminder:   (id: string) => void;
  relevanceMap?: Map<string, WatchlistRelevance>;
  theme: any;
}) {
  if (events.length === 0) return null;
  const meta = TIMESLOT_META[slot];
  return (
    <View style={{ marginBottom: SPACING.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: SPACING.sm }}>
        <Text style={{ fontSize: 16 }}>{meta.icon}</Text>
        <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>{meta.label}</Text>
        <Text style={{ color: T.textDim, fontSize: 10 }}>· {meta.timeRange}</Text>
        <View style={{
          marginLeft: 'auto', backgroundColor: T.bg1, borderRadius: RADIUS.pill,
          paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: T.border,
        }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700' }}>{events.length}</Text>
        </View>
      </View>
      {events.map(e => (
        <EventCard
          key={e.id}
          event={e}
          expanded={expandedId === e.id}
          onToggle={() => onToggle(e.id)}
          reminderSet={reminders[e.id] ?? false}
          onScheduleReminder={onScheduleReminder}
          onCancelReminder={onCancelReminder}
          relevance={relevanceMap?.get(e.id)}
          theme={T}
        />
      ))}
    </View>
  );
}

// ── Main Screen ────────────────────────────────────────────────────────────────

export default function CalendarScreen() {
  const { theme: T }    = useTheme();
  const { allAssets }   = useData(); // live watchlist from DataContext

  const [events, setEvents]         = useState<MarketEvent[]>([]);
  const [filter, setFilter]         = useState<CalendarFilter>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reminders, setReminders]   = useState<Record<string, boolean>>({});
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [viewMode, setViewMode]     = useState<'TIMELINE' | 'LIST'>('TIMELINE');
  const [, setTick]                 = useState(0);

  // Open position symbols (paper + live) — loaded once, refreshed on pull-to-refresh
  const [openPositionSymbols, setOpenPositionSymbols] = useState<Set<string>>(new Set());

  // Precomputed relevance map: eventId → WatchlistRelevance
  // Recomputed when allAssets or openPositionSymbols change
  const [relevanceMap, setRelevanceMap] = useState<Map<string, WatchlistRelevance>>(new Map());

  // Countdown ticker — update every 60 s
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Load open positions from paper + live portfolios.
  // Graceful degradation: failure in either doesn't block the other.
  const loadOpenPositions = useCallback(async (): Promise<Set<string>> => {
    const symbols = new Set<string>();
    try {
      const paper = await getPortfolio();
      paper.openPositions.forEach(p => symbols.add(p.symbol));
    } catch { /* paper portfolio unavailable — continue */ }
    try {
      const live = await getLivePortfolio();
      live.openPositions.forEach(p => symbols.add(p.symbol));
    } catch { /* live portfolio unavailable — continue */ }
    return symbols;
  }, []);

  const loadEvents = useCallback(async () => {
    const cached   = await loadCachedEvents();
    const computed = getMarketEvents();
    const fresh    = computed.length > 0 ? computed : (cached ?? []);
    if (computed.length > 0) saveCachedEvents(computed);

    setEvents(fresh);

    const [states, openSymbols] = await Promise.all([
      Promise.all(fresh.map(async e => [e.id, await hasReminder(e.id)] as const))
        .then(pairs => Object.fromEntries(pairs)),
      loadOpenPositions(),
    ]);

    setReminders(states as Record<string, boolean>);
    setOpenPositionSymbols(openSymbols);
    setLoading(false);
    setRefreshing(false);
  }, [loadOpenPositions]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // Recompute relevance map whenever watchlist or positions change.
  // Pure function call — no async, no side-effects.
  useEffect(() => {
    if (events.length === 0) return;
    const map = new Map<string, WatchlistRelevance>();
    events.forEach(e => {
      map.set(e.id, getWatchlistRelevance(e, allAssets, openPositionSymbols));
    });
    setRelevanceMap(map);
  }, [events, allAssets, openPositionSymbols]);

  const handleToggle           = useCallback((id: string) => setExpandedId(p => p === id ? null : id), []);
  const handleScheduleReminder = useCallback((id: string) => setReminders(p => ({ ...p, [id]: true })), []);
  const handleCancelReminder   = useCallback(async (id: string) => {
    await cancelEventReminders(id);
    setReminders(p => ({ ...p, [id]: false }));
  }, []);

  const filteredEvents = getEventsByFilter(filter);
  const grouped        = groupByTimeSlot(filteredEvents);
  const SLOT_ORDER: TimeSlot[] = ['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'ALL_DAY'];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, paddingBottom: 60 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); loadEvents(); }}
            tintColor={T.teal}
          />
        }
      >
        {/* Screen header */}
        <View style={{ marginBottom: SPACING.sm }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Market Intelligence</Text>
          <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>
            Professional trader calendar — plan around volatility
          </Text>
        </View>

        {/* View mode toggle */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: SPACING.lg }}>
          {(['TIMELINE', 'LIST'] as const).map(mode => (
            <TouchableOpacity
              key={mode}
              onPress={() => setViewMode(mode)}
              style={{
                paddingHorizontal: 16, paddingVertical: 8, borderRadius: RADIUS.pill,
                backgroundColor: viewMode === mode ? T.accent : T.bg1,
                borderWidth: 1, borderColor: viewMode === mode ? T.accent : T.border,
              }}
            >
              <Text style={{ color: viewMode === mode ? '#fff' : T.textDim, fontSize: 11, fontWeight: '700' }}>
                {mode === 'TIMELINE' ? '🕐 Timeline' : '📋 All Events'}
              </Text>
            </TouchableOpacity>
          ))}
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={{ color: T.textDim, fontSize: 10, marginTop: 6 }}>
              {filteredEvents.length} events
            </Text>
          </View>
        </View>

        {/* Summary + Score */}
        <TodaySummaryCard theme={T} />
        <IntelligenceBanner theme={T} />

        {/* Watchlist Awareness — events affecting the user's assets / open positions */}
        <WatchlistSummaryCard
          events={events}
          watchlistRelevanceMap={relevanceMap}
          onEventPress={handleToggle}
          theme={T}
        />

        {/* Filters */}
        <FilterBar filter={filter} onChange={setFilter} theme={T} />

        {/* Event list */}
        {loading ? (
          <ActivityIndicator color={T.teal} size="large" style={{ marginTop: 40 }} />
        ) : filteredEvents.length === 0 ? (
          <Card theme={T} style={{ alignItems: 'center', paddingVertical: 32 }}>
            <Text style={{ fontSize: 32, marginBottom: 8 }}>🔍</Text>
            <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>No events match your filters</Text>
            <TouchableOpacity onPress={() => setFilter({})} style={{ marginTop: 12 }}>
              <Text style={{ color: T.teal, fontSize: 12 }}>Clear all filters</Text>
            </TouchableOpacity>
          </Card>
        ) : viewMode === 'TIMELINE' ? (
          SLOT_ORDER.map(slot => (
            <TimelineSection
              key={slot}
              slot={slot}
              events={grouped[slot]}
              expandedId={expandedId}
              onToggle={handleToggle}
              reminders={reminders}
              onScheduleReminder={handleScheduleReminder}
              onCancelReminder={handleCancelReminder}
              relevanceMap={relevanceMap}
              theme={T}
            />
          ))
        ) : (
          filteredEvents.map(e => (
            <EventCard
              key={e.id}
              event={e}
              expanded={expandedId === e.id}
              onToggle={() => handleToggle(e.id)}
              reminderSet={reminders[e.id] ?? false}
              onScheduleReminder={handleScheduleReminder}
              onCancelReminder={handleCancelReminder}
              relevance={relevanceMap.get(e.id)}
              theme={T}
            />
          ))
        )}

        <Text style={{
          color: T.textDim, fontSize: 9, marginTop: 16, lineHeight: 14, textAlign: 'center',
        }}>
          Event dates are computed estimates based on standard institutional cadences.{'\n'}
          Always confirm exact times via RBI, Federal Reserve, or ECB official calendars.{'\n'}
          This calendar provides educational context only — not financial advice.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
