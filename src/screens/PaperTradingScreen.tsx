import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, MetricBox, Skeleton } from '../components/Common';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BottomSheet } from '../components/BottomSheet';
import { useToast } from '../components/Toast';
import { pFmt } from '../utils/indicators';
import { trainAndPredict, MLPrediction } from '../utils/mlSignal';
import { getPortfolio, resetPortfolio, setMode, computePortfolioValue, consumeMigrationFlag, PaperPortfolioState, PaperPosition } from '../utils/paperPortfolio';
import { calculatePnL, calculatePnLPct } from '../utils/pnlCalculator';
import { formatTradeQualityScore } from '../utils/tradeQuality';
import { attemptOpenPosition, closePosition, closePositionPartial, moveStopLoss, moveTakeProfit, applyBreakEvenStop, applyTrailingStop, monitorOpenPositions } from '../utils/paperTradingEngine';
import { getTodayPnL, DailyPnL } from '../utils/riskManager';
import { RADIUS, SPACING } from '../theme/colors';

export default function PaperTradingScreen({ navigation, route }: any) {
  const { theme: T } = useTheme();
  const showToast = useToast();
  const { allAssets, prices } = useData();
  const [portfolio, setPortfolioState] = useState<PaperPortfolioState | null>(null);

  const [todayPnL, setTodayPnL] = useState<DailyPnL | null>(null);
  const [pendingSignal, setPendingSignal] = useState<{ symbol: string; prediction: MLPrediction } | null>(null);
  const [managingPosition, setManagingPosition] = useState<PaperPosition | null>(null);
  const [openResultMsg, setOpenResultMsg] = useState<{ title: string; reason: string } | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // Shown once after automatic migration from v0 (old SHORT accounting) to v1.
  // Dismissed by the user and never shown again (migration only runs once).
  const [showMigrationBanner, setShowMigrationBanner] = useState(false);
  const [partialPct, setPartialPct] = useState('50');
  const [newSlInput, setNewSlInput] = useState('');
  const [newTpInput, setNewTpInput] = useState('');

  // FIX (freeze): deps must be [] — the previous [portfolio] dependency made
  // load() → setPortfolioState(new object) → load recreated → useEffect([load])
  // re-fires → infinite loop that froze the screen.
  // FIX (banner): consumeMigrationFlag() is a one-shot set only in the session
  // where the migration actually ran, so the banner appears exactly once ever —
  // not on every screen mount.
  const load = useCallback(async () => {
    const loaded = await getPortfolio();
    if (consumeMigrationFlag()) setShowMigrationBanner(true);
    setPortfolioState(loaded);
    setTodayPnL(await getTodayPnL());
  }, []);
  useEffect(() => { load(); }, [load]);

  // A BUY signal arrives here as a route param from ChartScreen (see the
  // "🧪 Paper Trade" button added there) — this screen never generates its
  // own signals, it only ever acts on the exact same trainAndPredict result
  // already shown on the Chart screen.
  useEffect(() => {
    const incoming = route?.params?.pendingSignal;
    if (incoming) setPendingSignal(incoming);
  }, [route?.params?.pendingSignal]);

  // Live monitoring: every price tick, check open positions against SL/TP —
  // reuses monitorOpenPositions, which itself reuses the verified close/P&L math.
  //
  // FIX: prices ticks multiple times/second on volatile symbols, but each
  // pass here was firing monitorOpenPositions() -> getPortfolio() then
  // .then(load) -> ANOTHER getPortfolio() + getTodayPnL(), with no
  // cancellation. Ticks queued up async chains faster than they resolved,
  // so whichever stale call finished last would win and overwrite the UI
  // with an older snapshot — the exact "PnL not up to date / not ticking"
  // symptom. A ref-based in-flight guard coalesces bursts of ticks into a
  // single pass; any ticks that arrive while one is running are dropped
  // (the next tick a few hundred ms later will pick up the latest prices).
  const monitorInFlightRef = useRef(false);
  useEffect(() => {
    const livePrices: Record<string, number> = {};
    Object.entries(prices).forEach(([sym, p]) => { livePrices[sym] = p.price; });
    if (!Object.keys(livePrices).length) return;
    if (monitorInFlightRef.current) return;
    monitorInFlightRef.current = true;
    monitorOpenPositions(livePrices)
      .then(load)
      .finally(() => { monitorInFlightRef.current = false; });
  }, [prices, load]);

  async function handleManualConfirm(accept: boolean) {
    if (!pendingSignal) return;
    if (accept) {
      const currentPrice = prices[pendingSignal.symbol]?.price ?? pendingSignal.prediction.suggestedEntry;
      const asset = allAssets.find(a => a.symbol === pendingSignal.symbol);
      const candles = route?.params?.candles || [];
      // FIX (confidence gate): use the live multi-engine confidence attached by
      // PredictionCard, so the gate uses the same number shown in the header —
      // not the stale prediction.confidence fallback.
      const liveConf = (pendingSignal.prediction as any)._liveOverallConfidence as number | undefined;
      const result = await attemptOpenPosition(pendingSignal.symbol, route?.params?.timeframe || '15m', pendingSignal.prediction, currentPrice, candles, asset?.type || 'CRYPTO', liveConf);
      setOpenResultMsg({ title: result.opened ? 'Trade Opened' : 'Not Opened', reason: result.reason });
      load();
    }
    setPendingSignal(null);
  }

  async function toggleMode() {
    if (!portfolio) return;
    const next = portfolio.mode === 'AUTO' ? 'MANUAL' : 'AUTO';
    setPortfolioState(await setMode(next));
  }

  async function handleResetPortfolio() {
    setShowResetConfirm(true);
  }

  if (!portfolio) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
        <View style={{ padding: SPACING.lg }}>
          <Skeleton width={160} height={22} theme={T} style={{ marginBottom: 18 }} />
          <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.lg, marginBottom: 14 }}>
            <Skeleton width={90} height={10} theme={T} style={{ marginBottom: 10 }} />
            <Skeleton width={180} height={28} theme={T} style={{ marginBottom: 8 }} />
            <Skeleton width={120} height={12} theme={T} />
          </View>
          <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, borderWidth: 1, borderColor: T.cardBorder, padding: SPACING.lg }}>
            <Skeleton width={140} height={14} theme={T} style={{ marginBottom: 8 }} />
            <Skeleton width="80%" height={11} theme={T} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  const livePrices: Record<string, number> = {};
  Object.entries(prices).forEach(([sym, p]) => { livePrices[sym] = p.price; });
  const { portfolioValue, unrealizedPnL } = computePortfolioValue(portfolio, livePrices);
  const totalReturn = ((portfolioValue - portfolio.startingCapital) / portfolio.startingCapital) * 100;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Paper Trading</Text>
          <TouchableOpacity onPress={() => navigation.navigate('PaperJournal')}>
            <Text style={{ color: T.accent, fontSize: 12, fontWeight: '700' }}>Journal & Analytics →</Text>
          </TouchableOpacity>
        </View>

        {/* Portfolio Summary */}
        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>TOTAL EQUITY</SectionLabel>
          <Text style={{ color: totalReturn >= 0 ? T.green : T.red, fontSize: 30, fontWeight: '800', letterSpacing: -0.4 }}>{pFmt(portfolioValue)}</Text>
          <Text style={{ color: totalReturn >= 0 ? T.green : T.red, fontSize: 13, fontWeight: '700', marginTop: 2, marginBottom: 14 }}>{totalReturn >= 0 ? '▲ +' : '▼ '}{totalReturn.toFixed(2)}% total return</Text>
          {showMigrationBanner && (
            <View style={{ backgroundColor: T.accent + '15', borderWidth: 1, borderColor: T.accent + '50', borderRadius: 6, padding: 10, marginBottom: 10 }}>
              <Text style={{ color: T.accent, fontSize: 11, fontWeight: '700', marginBottom: 3 }}>ℹ Balance recalculated</Text>
              <Text style={{ color: T.textSub, fontSize: 10, lineHeight: 15 }}>
                Your portfolio balance was automatically corrected from a previous accounting issue that affected SHORT trade cash flows. Trade history and P&L are unchanged.
              </Text>
              <TouchableOpacity onPress={() => setShowMigrationBanner(false)} style={{ marginTop: 6, alignSelf: 'flex-start' }}>
                <Text style={{ color: T.accent, fontSize: 10, fontWeight: '700' }}>Dismiss</Text>
              </TouchableOpacity>
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            <MetricBox label="CASH BALANCE" value={pFmt(portfolio.cashBalance)} theme={T} />
            <MetricBox label="UNREALIZED P&L" value={pFmt(unrealizedPnL)} valueColor={unrealizedPnL >= 0 ? T.green : T.red} bg={unrealizedPnL >= 0 ? T.green + '10' : T.red + '10'} theme={T} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            <MetricBox label="REALIZED P&L" value={pFmt(portfolio.realizedPnL)} valueColor={portfolio.realizedPnL >= 0 ? T.green : T.red} bg={portfolio.realizedPnL >= 0 ? T.green + '10' : T.red + '10'} theme={T} />
            <MetricBox label="TODAY'S P&L" value={todayPnL ? pFmt(todayPnL.realizedPnL) : '—'} valueColor={todayPnL && todayPnL.realizedPnL >= 0 ? T.green : todayPnL ? T.red : T.text} bg={todayPnL && todayPnL.realizedPnL >= 0 ? T.green + '10' : todayPnL && todayPnL.realizedPnL < 0 ? T.red + '10' : T.bg3} theme={T} sub={todayPnL ? `${todayPnL.tradesCount} trade${todayPnL.tradesCount === 1 ? '' : 's'} today` : undefined} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <MetricBox label="STARTING CAPITAL" value={pFmt(portfolio.startingCapital)} theme={T} />
          </View>
          <TouchableOpacity onPress={handleResetPortfolio} activeOpacity={0.7} style={{ marginTop: 14, alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}>
            <Text style={{ color: T.textDim, fontSize: 11, fontWeight: '600' }}>↻ Reset portfolio</Text>
          </TouchableOpacity>
        </Card>

        {/* Phase 3 — Execution mode */}
        <Card theme={T} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>Execution Mode</Text>
              <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>
                {portfolio.mode === 'AUTO' ? 'AI signals open/close trades automatically' : 'You confirm every trade before it opens'}
              </Text>
            </View>
            <TouchableOpacity onPress={toggleMode} style={{ backgroundColor: portfolio.mode === 'AUTO' ? T.green : T.bg3, paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADIUS.sm }}>
              <Text style={{ color: portfolio.mode === 'AUTO' ? '#fff' : T.textSub, fontWeight: '700', fontSize: 11 }}>{portfolio.mode}</Text>
            </TouchableOpacity>
          </View>
        </Card>

        {/* Open Positions */}
        <SectionLabel theme={T}>OPEN POSITIONS ({portfolio.openPositions.length})</SectionLabel>
        {portfolio.openPositions.length === 0 && (
          <View style={{ alignItems: 'center', paddingVertical: SPACING.xxl, paddingHorizontal: SPACING.xl, marginBottom: 14 }}>
            <Text style={{ fontSize: 32, marginBottom: 10 }}>📭</Text>
            <Text style={{ color: T.text, fontSize: 13, fontWeight: '700', marginBottom: 4 }}>No Open Positions</Text>
            <Text style={{ color: T.textDim, fontSize: 11, textAlign: 'center', lineHeight: 16 }}>Run TRAIN & PREDICT on the Chart screen for a BUY/SELL signal, then come back here to trade it.</Text>
          </View>
        )}
        {portfolio.openPositions.map(p => {
          const cur = livePrices[p.symbol] ?? p.entryPrice;
          const pnl = calculatePnL({ entryPrice: p.entryPrice, exitPrice: cur, qty: p.qty, direction: p.direction });
          const pnlPct = calculatePnLPct(pnl, p.entryPrice, p.qty);
          const isLong = p.direction === 'LONG';
          const dirColor = isLong ? T.green : T.red;
          const ageMin = Math.floor((Date.now() - p.entryTime) / 60000);
          const ageLabel = ageMin < 60 ? `${ageMin}m` : ageMin < 1440 ? `${Math.floor(ageMin / 60)}h ${ageMin % 60}m` : `${Math.floor(ageMin / 1440)}d`;
          return (
            <TouchableOpacity key={p.id} onPress={() => setManagingPosition(p)} activeOpacity={0.85} style={{ marginBottom: 10 }}>
              <Card theme={T}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: dirColor + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 4 }}>
                      <Text style={{ color: dirColor, fontSize: 10, fontWeight: '800' }}>{isLong ? '▲' : '▼'} {p.direction}</Text>
                    </View>
                    <Text style={{ color: T.text, fontWeight: '800', fontSize: 15 }}>{p.symbol}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: pnl >= 0 ? T.green : T.red, fontWeight: '800', fontSize: 16 }}>{pnl >= 0 ? '+' : ''}{pFmt(pnl)}</Text>
                    <Text style={{ color: pnl >= 0 ? T.green : T.red, fontSize: 10, fontWeight: '700' }}>{pnl >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</Text>
                  </View>
                </View>

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                  <View>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>ENTRY</Text>
                    <Text style={{ color: T.text, fontSize: 11, fontWeight: '700', marginTop: 1 }}>{pFmt(p.entryPrice)}</Text>
                  </View>
                  <View>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>CURRENT</Text>
                    <Text style={{ color: T.text, fontSize: 11, fontWeight: '700', marginTop: 1 }}>{pFmt(cur)}</Text>
                  </View>
                  <View>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>QTY</Text>
                    <Text style={{ color: T.text, fontSize: 11, fontWeight: '700', marginTop: 1 }}>{p.qty.toFixed(2)}</Text>
                  </View>
                  <View>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>AGE</Text>
                    <Text style={{ color: T.text, fontSize: 11, fontWeight: '700', marginTop: 1 }}>{ageLabel}</Text>
                  </View>
                </View>

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderTopColor: T.border }}>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>SL <Text style={{ color: T.red, fontWeight: '700' }}>{pFmt(p.stopLoss)}</Text> · TP <Text style={{ color: T.green, fontWeight: '700' }}>{pFmt(p.takeProfit)}</Text></Text>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>{p.timeframe} · v{p.modelVersion} · {p.predictionHorizon}-bar</Text>
                </View>
                {p.tradeQuality && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                    <View style={{ backgroundColor: T.accent + '15', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text style={{ color: T.accent, fontSize: 9, fontWeight: '800' }}>{formatTradeQualityScore(p.tradeQuality.score)}/100 {p.tradeQuality.stars}</Text>
                    </View>
                    <View style={{ backgroundColor: (p.tradeQuality.riskBadge === 'Low' ? T.green : p.tradeQuality.riskBadge === 'Medium' ? T.amber : T.red) + '15', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
                      <Text style={{ color: p.tradeQuality.riskBadge === 'Low' ? T.green : p.tradeQuality.riskBadge === 'Medium' ? T.amber : T.red, fontSize: 9, fontWeight: '800' }}>{p.tradeQuality.riskBadge} Risk</Text>
                    </View>
                    <Text style={{ color: T.textDim, fontSize: 9 }}>Grade {p.tradeQuality.grade} · Entry conf {p.aiConfidence.toFixed(0)}</Text>
                  </View>
                )}
                {/* FIX (Audit items #2/#3): display all peak metrics from live position fields.
                    These update on every tick via monitorOpenPositions — no stale values. */}
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 6 }}>
                  Peak profit: <Text style={{ color: T.green, fontWeight: '700' }}>{pFmt(p.maxUnrealizedProfit)}</Text>
                  {'  '}Max drawdown: <Text style={{ color: T.red, fontWeight: '700' }}>{pFmt(p.maxUnrealizedDrawdown)}</Text>
                  {(p as any).maxProfitWithdrawn != null && (p as any).maxProfitWithdrawn > 0
                    ? <Text style={{ color: T.amber }}>{'  '}Max given back: <Text style={{ fontWeight: '700' }}>{pFmt((p as any).maxProfitWithdrawn)}</Text></Text>
                    : null}
                </Text>

                <View style={{ marginTop: 12, backgroundColor: T.accent + '12', borderRadius: RADIUS.sm, paddingVertical: 11, alignItems: 'center', minHeight: 40, justifyContent: 'center' }}>
                  <Text style={{ color: T.accent, fontSize: 12, fontWeight: '700' }}>Manage Position</Text>
                </View>
              </Card>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Phase 3 — Manual confirmation dialog */}
      <ConfirmDialog
        visible={!!pendingSignal}
        title="Execute Paper Trade?"
        message={pendingSignal ? `BUY ${pendingSignal.symbol} — ${(pendingSignal.prediction.ensembleProbUp * 100).toFixed(1)}% P(up), confidence ${pendingSignal.prediction.confidence.toFixed(0)}/100` : undefined}
        theme={T}
        onRequestClose={() => handleManualConfirm(false)}
        actions={[
          { label: 'NO', onPress: () => handleManualConfirm(false) },
          { label: 'YES', primary: true, onPress: () => handleManualConfirm(true) },
        ]}
      />

      {/* Phase 4 — Position management */}
      <BottomSheet visible={!!managingPosition} onClose={() => setManagingPosition(null)} title={managingPosition?.symbol} theme={T}>
        {managingPosition && (
          <View>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
              <TextInput value={partialPct} onChangeText={setPartialPct} keyboardType="numeric" style={{ flex: 1, backgroundColor: T.bg0, borderRadius: RADIUS.sm, padding: 10, color: T.text }} placeholder="% to close" placeholderTextColor={T.textDim} />
              <TouchableOpacity onPress={async () => {
                const cur = livePrices[managingPosition.symbol] ?? managingPosition.entryPrice;
                await closePositionPartial(managingPosition.id, (parseFloat(partialPct) || 50) / 100, cur);
                setManagingPosition(null); load();
              }} style={{ backgroundColor: T.amber, paddingHorizontal: 14, borderRadius: RADIUS.sm, justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>Partial Close</Text>
              </TouchableOpacity>
            </View>
            <ActionButton label="Full Close (Manual Exit)" color={T.red} T={T} onPress={async () => {
              const cur = livePrices[managingPosition.symbol] ?? managingPosition.entryPrice;
              await closePosition(managingPosition.id, cur, 'MANUAL_EXIT'); setManagingPosition(null); load();
            }} />
            <ActionButton label="Apply Break-Even Stop" color={T.blue} T={T} onPress={async () => {
              const cur = livePrices[managingPosition.symbol] ?? managingPosition.entryPrice;
              const moved = await applyBreakEvenStop(managingPosition.id, cur);
              showToast(moved ? 'Stop moved to entry price.' : "Price hasn't moved far enough in your favor yet.", moved ? 'success' : 'default');
              setManagingPosition(null); load();
            }} />
            <ActionButton label="Tighten Trailing Stop (1x ATR-ish)" color={T.purple} T={T} onPress={async () => {
              const cur = livePrices[managingPosition.symbol] ?? managingPosition.entryPrice;
              const distance = Math.abs(managingPosition.entryPrice - managingPosition.stopLoss);
              await applyTrailingStop(managingPosition.id, cur, distance);
              setManagingPosition(null); load();
            }} />

            {/* FIX (audit): moveStopLoss/moveTakeProfit existed in the
                engine since Phase 4 of Paper Trading but were never
                wired to any button here — Position Management was
                incomplete, not just carrying a stray unused import. */}
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              <TextInput value={newSlInput} onChangeText={setNewSlInput} keyboardType="numeric" style={{ flex: 1, backgroundColor: T.bg0, borderRadius: RADIUS.sm, padding: 10, color: T.text }} placeholder={`New SL (current: ${managingPosition.stopLoss.toFixed(2)})`} placeholderTextColor={T.textDim} />
              <TouchableOpacity onPress={async () => {
                const val = parseFloat(newSlInput);
                if (!val || val <= 0) { showToast('Enter a valid stop-loss price.', 'error'); return; }
                await moveStopLoss(managingPosition.id, val);
                setNewSlInput(''); setManagingPosition(null); load();
              }} style={{ backgroundColor: T.red, paddingHorizontal: 14, borderRadius: RADIUS.sm, justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>Move SL</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              <TextInput value={newTpInput} onChangeText={setNewTpInput} keyboardType="numeric" style={{ flex: 1, backgroundColor: T.bg0, borderRadius: RADIUS.sm, padding: 10, color: T.text }} placeholder={`New TP (current: ${managingPosition.takeProfit.toFixed(2)})`} placeholderTextColor={T.textDim} />
              <TouchableOpacity onPress={async () => {
                const val = parseFloat(newTpInput);
                if (!val || val <= 0) { showToast('Enter a valid take-profit price.', 'error'); return; }
                await moveTakeProfit(managingPosition.id, val);
                setNewTpInput(''); setManagingPosition(null); load();
              }} style={{ backgroundColor: T.green, paddingHorizontal: 14, borderRadius: RADIUS.sm, justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>Move TP</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => setManagingPosition(null)} style={{ marginTop: 10, alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 12 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
      </BottomSheet>

      <ConfirmDialog
        visible={!!openResultMsg}
        title={openResultMsg?.title || ''}
        message={openResultMsg?.reason}
        theme={T}
        onRequestClose={() => setOpenResultMsg(null)}
        actions={[{ label: 'OK', primary: true, onPress: () => setOpenResultMsg(null) }]}
      />
      <ConfirmDialog
        visible={showResetConfirm}
        title="Reset Paper Portfolio?"
        message="This clears all open positions and resets cash balance. Trade history is kept."
        theme={T}
        onRequestClose={() => setShowResetConfirm(false)}
        actions={[
          { label: 'Cancel', onPress: () => setShowResetConfirm(false) },
          { label: 'Reset', destructive: true, onPress: async () => { setPortfolioState(await resetPortfolio(100000)); setShowResetConfirm(false); } },
        ]}
      />
    </SafeAreaView>
  );
}

function ActionButton({ label, color, onPress, T }: any) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.75} style={{ backgroundColor: color + '15', borderWidth: 1, borderColor: color + '40', paddingVertical: 13, paddingHorizontal: 12, borderRadius: RADIUS.sm, marginBottom: 8, alignItems: 'center', minHeight: 44 }}>
      <Text style={{ color, fontWeight: '700', fontSize: 12 }}>{label}</Text>
    </TouchableOpacity>
  );
}
