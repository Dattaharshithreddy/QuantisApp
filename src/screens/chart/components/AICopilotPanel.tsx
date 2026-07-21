// ── AICopilotPanel — AI Copilot card (analysis request + result display) ──────
// Pure presentational. All business logic (runAnalysis, state) stays in ChartScreen.
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { pFmt } from '../../../utils/indicators';
import { AIAnalysis } from '../../../api/claude';
import { Card, SectionLabel, Skeleton } from '../../../components/Common';
import { RADIUS } from '../../../theme/colors';

const TRADE_LABELS: Record<string, { l: string; bg: string }> = {
  LONG:     { l: '▲ LONG',    bg: '#26a69a' }, SHORT:   { l: '▼ SHORT',   bg: '#ef5350' },
  BUY_CE:   { l: '↑ BUY CE',  bg: '#2962ff' }, BUY_PE:  { l: '↓ BUY PE',  bg: '#9c27b0' },
  SELL_CE:  { l: '↑ SELL CE', bg: '#f5a623' }, SELL_PE: { l: '↓ SELL PE', bg: '#fb923c' },
  NO_TRADE: { l: '— NO TRADE',bg: '#4c535e' },
};

type AiState = { status: 'idle'|'loading'|'done'|'error'; data: AIAnalysis | null; err: string | null };
type Props = {
  ai:            AiState;
  assetName:     string;
  symbol:        string;
  anthropicKey:  string;
  loading:       boolean;
  onAnalyze:     () => void;
  onNavigateChat:(sym: string) => void;
  T: any;
};

export function AICopilotPanel({ ai, assetName, symbol, anthropicKey, loading, onAnalyze, onNavigateChat, T }: Props) {
  return (
    <Card theme={T} style={{ marginTop: 18 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <View>
          <Text style={{ color: T.blue, fontWeight: '800', fontSize: 12, letterSpacing: 1 }}>⬡ AI COPILOT</Text>
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>Claude Sonnet · Institutional Grade</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={() => onNavigateChat(symbol)} style={{ backgroundColor: T.purple, paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS.sm }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>💬 Chat</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onAnalyze} disabled={ai.status === 'loading' || loading} style={{ backgroundColor: T.accent, paddingHorizontal: 16, paddingVertical: 8, borderRadius: RADIUS.sm, opacity: ai.status === 'loading' ? 0.6 : 1 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>{ai.status === 'loading' ? 'ANALYZING…' : 'ANALYZE'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {ai.status === 'idle' && (
        <View>
          {!anthropicKey && <View style={{ backgroundColor: T.amber + '15', padding: 10, borderRadius: RADIUS.sm, marginBottom: 10 }}>
            <Text style={{ color: T.amber, fontSize: 11, lineHeight: 16 }}>⚙ Add your Anthropic API key in Settings to use the AI Copilot.</Text>
          </View>}
          <Text style={{ color: T.textDim, fontSize: 12, lineHeight: 20 }}>Tap ANALYZE for institutional-grade AI reasoning on {assetName}.</Text>
        </View>
      )}
      {ai.status === 'loading' && <View style={{ gap: 8, paddingVertical: 4 }}><Skeleton width="92%" height={11} theme={T} /><Skeleton width="78%" height={11} theme={T} /><Skeleton width="85%" height={11} theme={T} /></View>}
      {ai.status === 'error' && <Text style={{ color: T.red, fontSize: 12 }}>⚠ {ai.err}</Text>}
      {ai.status === 'done' && ai.data && (() => {
        const d = ai.data;
        return (
          <View>
            <View style={{ backgroundColor: TRADE_LABELS[d.tradeType]?.bg || T.textDim, padding: 10, borderRadius: RADIUS.sm, alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14, letterSpacing: 1 }}>{TRADE_LABELS[d.tradeType]?.l || d.tradeType}</Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
              <Text style={{ color: T.textDim, fontSize: 10 }}>CONFIDENCE</Text>
              <Text style={{ color: (d.confidence ?? 0) >= 70 ? T.green : T.amber, fontWeight: '800', fontSize: 18 }}>{d.confidence ?? '--'}%</Text>
            </View>
            {d.tradeType !== 'NO_TRADE' && (
              <View style={{ marginBottom: 10 }}>
                {[['ENTRY', d.entry, T.blue],['STOP LOSS', d.stopLoss, T.red],['TARGET 1', d.target1, T.green],['TARGET 2', d.target2, T.green],['R:R', d.riskReward ? `1:${d.riskReward.toFixed(1)}` : '--', T.amber]].map(([l, v, c]: any) => (
                  <View key={l} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: T.border }}>
                    <Text style={{ color: T.textDim, fontSize: 10 }}>{l}</Text>
                    <Text style={{ color: c, fontWeight: '700', fontSize: 12 }}>{typeof v === 'number' ? pFmt(v) : v}</Text>
                  </View>
                ))}
              </View>
            )}
            {[['TECHNICAL SETUP', d.technicalSetup, T.blue],['SMART MONEY', d.smartMoney, T.purple],['MACRO + NEWS', d.macroContext, T.amber],['RISK FACTORS', d.riskFactors, T.red]].map(([title, body, c]: any) => (
              <View key={title} style={{ borderLeftWidth: 2, borderLeftColor: c, paddingLeft: 8, marginBottom: 10 }}>
                <Text style={{ color: c, fontSize: 9, fontWeight: '700', marginBottom: 2 }}>{title}</Text>
                <Text style={{ color: body ? T.textSub : T.textDim, fontSize: 11, lineHeight: 17, fontStyle: body ? 'normal' : 'italic' }}>
                  {body || 'No data returned — try running ANALYZE again.'}
                </Text>
              </View>
            ))}
            <View style={{ backgroundColor: T.accent + '15', padding: 10, borderRadius: RADIUS.sm }}>
              <Text style={{ color: T.accent, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>EXECUTIVE SUMMARY</Text>
              <Text style={{ color: T.text, fontSize: 12, fontStyle: 'italic', lineHeight: 18 }}>{d.executiveSummary}</Text>
            </View>
          </View>
        );
      })()}
    </Card>
  );
}
