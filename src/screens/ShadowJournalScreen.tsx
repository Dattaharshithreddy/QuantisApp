import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, RefreshControl, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused } from '@react-navigation/native';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { loadShadowTrades, dedupExistingShadowTrades, clearAllShadowTrades, ShadowTrade, GateType } from '../utils/shadowTradeJournal';
import { MarketContextCard } from '../components/MarketContextCard';
import { exportShadowJournal, ExportFormat } from '../utils/journalExport';

// ── Constants ──────────────────────────────────────────────────────────────────
const GATE_LABELS: Record<GateType, string> = {
  CONFIDENCE:         'Confidence',
  REGIME:             'Regime',
  PORTFOLIO_RISK:     'Portfolio Risk',
  POSITION_SIZING:    'Position Sizing',
  DUPLICATE_POSITION: 'Duplicate Position',
  DUPLICATE:          'Duplicate',          // legacy label
  CASH:               'Cash',
  FILTER:             'Strategy Filter',
  OTHER:              'Other',
};
const GATE_COLORS: Record<GateType, string> = {
  CONFIDENCE:         '#F59E0B',
  REGIME:             '#8B5CF6',
  PORTFOLIO_RISK:     '#EF4444',
  POSITION_SIZING:    '#F97316',  // orange
  DUPLICATE_POSITION: '#6B7280',
  DUPLICATE:          '#6B7280',  // legacy
  CASH:               '#EF4444',
  FILTER:             '#3B82F6',
  OTHER:              '#6B7280',
};
const SORT_OPTIONS = [
  { key:'newest',    label:'Newest' },
  { key:'oldest',    label:'Oldest' },
  { key:'best_pnl',  label:'Best P&L' },
  { key:'worst_pnl', label:'Worst P&L' },
  { key:'highest_conf', label:'Highest Conf' },
  { key:'best_rr',   label:'Best R:R' },
  { key:'missed_winner', label:'Biggest Win' },
];

// ── Pure helpers ───────────────────────────────────────────────────────────────
const fmtTimestamp = (ms: number) => {
  const diff = Date.now() - ms;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  const d = new Date(ms);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+
    d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false});
};
const fmtDuration = (ms: number) => {
  const s = Math.floor(ms/1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m`;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
};
const fmtPnl = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const fmtCandles = (ticks: number) => { const c=Math.round(ticks/60); return c<=0?'<1':String(c); };

function livePnl(t: ShadowTrade, price: number) {
  const raw = t.direction==='LONG'
    ? (price-t.entryPrice)/t.entryPrice
    : (t.entryPrice-price)/t.entryPrice;
  return parseFloat((raw*100).toFixed(2));
}
function verdictInfo(t: ShadowTrade): {text:string;color:string}|null {
  if (t.outcome==='OPEN') return null;
  if (t.outcome==='TP_HIT') return {text:'✓ Would have been profitable — AI was too cautious', color:'#22C55E'};
  if (t.outcome==='SL_HIT') return {text:'✓ Would have been a loss — AI decision was correct', color:'#6B7280'};
  return {text:'Expired without hitting target or stop', color:'#F59E0B'};
}
function formatGateDetails(t: ShadowTrade) {
  if (!t.gateDetails) return [];
  const rows: {label:string;value:string}[] = [];
  const d = t.gateDetails; const handled = new Set<string>();
  // POSITION_SIZING — show user-friendly sizing breakdown
  if (d.riskAmount!=null)     { rows.push({label:'Risk budget',value:`${d.riskAmount} (${d.riskPerTradePct}% of ${d.accountSize})`}); handled.add('riskAmount'); handled.add('riskPerTradePct'); handled.add('accountSize'); }
  if (d.perUnitRisk!=null)    { rows.push({label:'Stop distance',value:String(d.perUnitRisk)}); handled.add('perUnitRisk'); }
  if (d.currentPrice!=null)   { rows.push({label:'Price at attempt',value:String(d.currentPrice)}); handled.add('currentPrice'); }
  if (d.stopLoss!=null)       { rows.push({label:'Stop-loss level',value:String(d.stopLoss)}); handled.add('stopLoss'); }
  // Other gates
  if (d.required!=null)       { rows.push({label:'Required confidence',value:String(d.required)}); handled.add('required'); }
  if (d.confidence!=null)     { rows.push({label:'Actual confidence',value:String(d.confidence)}); handled.add('confidence'); }
  if (d.signalType)           { rows.push({label:'Blocked signal',value:String(d.signalType)}); handled.add('signalType'); }
  if (d.allowedSignals)       { rows.push({label:'Allowed signals',value:String(d.allowedSignals)}); handled.add('allowedSignals'); }
  if (d.regime)               { rows.push({label:'Market regime',value:String(d.regime)}); handled.add('regime'); }
  Object.entries(d).forEach(([k,v])=>{ if(!handled.has(k)) rows.push({label:k.replace(/_/g,' '),value:String(v)}); });
  return rows;
}

// ── Performance analytics (UI-only, computed from stored fields) ───────────────
function computePerformance(trades: ShadowTrade[]) {
  const closed = trades.filter(t => t.outcome!=='OPEN' && t.pnlPct!=null);
  if (!closed.length) return null;
  const wins   = closed.filter(t => (t.pnlPct??0) > 0);
  const losses = closed.filter(t => (t.pnlPct??0) <= 0);
  const grossWin  = wins.reduce((s,t)=>s+(t.pnlPct??0),0);
  const grossLoss = Math.abs(losses.reduce((s,t)=>s+(t.pnlPct??0),0));
  const netPnl    = closed.reduce((s,t)=>s+(t.pnlPct??0),0);
  const pf        = grossLoss>0 ? grossWin/grossLoss : grossWin>0 ? Infinity : 0;
  const winRate   = closed.length>0 ? wins.length/closed.length*100 : 0;

  // Max drawdown: sort by time, compute running cumulative peak-to-trough
  const sorted = [...closed].sort((a,b)=>a.blockedAt-b.blockedAt);
  let peak = 0, cumPnl = 0, maxDD = 0;
  sorted.forEach(t => {
    cumPnl += (t.pnlPct??0);
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  });

  // Per-gate counterfactual
  const gates = ['CONFIDENCE','REGIME','PORTFOLIO_RISK','POSITION_SIZING','DUPLICATE_POSITION','CASH','FILTER','OTHER','DUPLICATE'] as GateType[];
  const gateContrib = gates.map(g => {
    const g_closed = closed.filter(t=>t.blockGate===g);
    const net = g_closed.reduce((s,t)=>s+(t.pnlPct??0),0);
    const wr  = g_closed.length>0 ? g_closed.filter(t=>(t.pnlPct??0)>0).length/g_closed.length*100 : 0;
    return { gate:g, count:g_closed.length, net, wr };
  }).filter(g=>g.count>0).sort((a,b)=>b.net-a.net);

  // Confidence calibration buckets (10-point bands)
  const confBuckets: Record<string,{wins:number;total:number}> = {};
  closed.forEach(t => {
    const b = `${Math.floor(t.signal.confidence/10)*10}-${Math.floor(t.signal.confidence/10)*10+10}`;
    if (!confBuckets[b]) confBuckets[b] = {wins:0,total:0};
    confBuckets[b].total++;
    if ((t.pnlPct??0)>0) confBuckets[b].wins++;
  });

  // Threshold simulator: show how different confidence thresholds would have performed
  // Only uses CONFIDENCE-gated trades so comparison is apples-to-apples
  const confTrades = closed.filter(t => t.blockGate === 'CONFIDENCE');
  const thresholds = [35, 40, 45, 50, 55, 60].map(thresh => {
    const eligible = confTrades.filter(t => t.signal.confidence >= thresh);
    const tw = eligible.filter(t => (t.pnlPct??0) > 0);
    const tl = eligible.filter(t => (t.pnlPct??0) <= 0);
    const tNet = eligible.reduce((s,t)=>s+(t.pnlPct??0),0);
    const tPF  = Math.abs(tl.reduce((s,t)=>s+(t.pnlPct??0),0)) > 0
      ? tw.reduce((s,t)=>s+(t.pnlPct??0),0) / Math.abs(tl.reduce((s,t)=>s+(t.pnlPct??0),0)) : 0;
    return { thresh, count:eligible.length, wr:eligible.length>0?tw.length/eligible.length*100:0, net:tNet, pf:tPF };
  }).filter(t => t.count > 0);
  return { netPnl, pf, winRate, maxDD, gateContrib, confBuckets, thresholds, closed, tpHit:wins.length, slHit:losses.length };
}

// ── Atoms ──────────────────────────────────────────────────────────────────────
function Pill({label, color}: {label:string; color:string}) {
  return (
    <View style={{backgroundColor:color+'22',borderRadius:4,paddingHorizontal:6,paddingVertical:2}}>
      <Text style={{color,fontSize:9,fontWeight:'700',letterSpacing:0.3}}>{label}</Text>
    </View>
  );
}
function DataCol({label,value,valueColor,T}: {label:string;value:string;valueColor?:string;T:any}) {
  return (
    <View style={{flex:1,minWidth:60}}>
      <Text style={{color:T.textDim,fontSize:9,marginBottom:1}}>{label}</Text>
      <Text style={{color:valueColor??T.text,fontSize:11,fontWeight:'600'}}>{value}</Text>
    </View>
  );
}

// ── Performance Summary Card ───────────────────────────────────────────────────
function PerformanceSummaryCard({trades, T}: {trades:ShadowTrade[]; T:any}) {
  const [open, setOpen] = useState(true);
  const perf = useMemo(()=>computePerformance(trades),[trades]);

  if (!perf) return (
    <View style={{backgroundColor:T.bg2,borderRadius:12,padding:14,marginBottom:12}}>
      <Text style={{color:T.textDim,fontSize:11,textAlign:'center'}}>
        No resolved trades yet — performance data will appear after TP or SL is hit
      </Text>
    </View>
  );

  const netColor = perf.netPnl>=0 ? T.green : T.red;
  const pfColor  = perf.pf>=1 ? T.green : T.red;

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={()=>setOpen(o=>!o)}
      style={{backgroundColor:T.bg2,borderRadius:12,marginBottom:12,overflow:'hidden'}}>
      {/* Headline */}
      <View style={{padding:14,paddingBottom:open?8:14}}>
        <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
          <View>
            <Text style={{color:T.text,fontSize:13,fontWeight:'800'}}>Counterfactual Performance</Text>
            <Text style={{color:T.textDim,fontSize:10,fontStyle:'italic'}}>Simulated · {perf.closed.length} shadow trades · not real results</Text>
          </View>
          <Text style={{color:T.textDim,fontSize:10}}>{open?'▲':'▼'}</Text>
        </View>
        <View style={{flexDirection:'row',gap:8}}>
          <View style={{flex:1,backgroundColor:T.bg3,borderRadius:8,padding:10,alignItems:'center'}}>
            <Text style={{color:T.textDim,fontSize:9,marginBottom:2}}>Net Return</Text>
            <Text style={{color:netColor,fontSize:18,fontWeight:'800'}}>{fmtPnl(perf.netPnl)}</Text>
          </View>
          <View style={{flex:1,backgroundColor:T.bg3,borderRadius:8,padding:10,alignItems:'center'}}>
            <Text style={{color:T.textDim,fontSize:9,marginBottom:2}}>Profit Factor</Text>
            <Text style={{color:pfColor,fontSize:18,fontWeight:'800'}}>{perf.pf===Infinity?'∞':perf.pf.toFixed(2)}</Text>
          </View>
          <View style={{flex:1,backgroundColor:T.bg3,borderRadius:8,padding:10,alignItems:'center'}}>
            <Text style={{color:T.textDim,fontSize:9,marginBottom:2}}>Win Rate</Text>
            <Text style={{color:perf.winRate>=50?T.green:T.red,fontSize:18,fontWeight:'800'}}>{perf.winRate.toFixed(0)}%</Text>
          </View>
          <View style={{flex:1,backgroundColor:T.bg3,borderRadius:8,padding:10,alignItems:'center'}}>
            <Text style={{color:T.textDim,fontSize:9,marginBottom:2}}>Max DD</Text>
            <Text style={{color:T.red,fontSize:18,fontWeight:'800'}}>-{perf.maxDD.toFixed(1)}%</Text>
          </View>
        </View>
        <Text style={{color:T.textDim,fontSize:9,fontStyle:'italic',marginTop:8,paddingTop:8,borderTopWidth:1,borderTopColor:T.bg3}}>
          ⚠ These are simulated outcomes. Trades never opened — results are hypothetical based on price movement after the block.
        </Text>
      </View>

      {open && (
        <View style={{paddingHorizontal:14,paddingBottom:14,gap:10}}>
          {/* Per-gate contribution */}
          <View style={{backgroundColor:T.bg3,borderRadius:8,padding:10}}>
            <Text style={{color:T.textDim,fontSize:9,fontWeight:'700',letterSpacing:0.5,marginBottom:8}}>
              GATE CONTRIBUTION — which gates helped vs hurt?
            </Text>
            {perf.gateContrib.map(g => {
              const col = GATE_COLORS[g.gate]??'#6B7280';
              const netCol = g.net>0 ? T.red : T.green; // net>0 = gate blocked profitable trades = gate hurt you
              const verdict = g.net>0
                ? `↑ cost you ${fmtPnl(g.net)}` // gate blocked winners
                : `↓ saved you ${fmtPnl(Math.abs(g.net))}`; // gate blocked losers
              return (
                <View key={g.gate} style={{flexDirection:'row',alignItems:'center',marginBottom:6,gap:8}}>
                  <View style={{backgroundColor:col+'22',borderRadius:4,paddingHorizontal:6,paddingVertical:2,minWidth:90}}>
                    <Text style={{color:col,fontSize:9,fontWeight:'700'}}>{GATE_LABELS[g.gate]}</Text>
                  </View>
                  <View style={{flex:1,height:4,backgroundColor:T.bg2,borderRadius:2,overflow:'hidden'}}>
                    <View style={{width:`${Math.min(100,Math.abs(g.net)/Math.max(0.01,perf.closed.length)*100)}%`,height:4,backgroundColor:netCol,borderRadius:2}}/>
                  </View>
                  <Text style={{color:netCol,fontSize:10,fontWeight:'700',width:80,textAlign:'right'}}>{verdict}</Text>
                  <Text style={{color:T.textDim,fontSize:9,width:30}}>{g.wr.toFixed(0)}%wr</Text>
                </View>
              );
            })}
            <Text style={{color:T.textDim,fontSize:9,marginTop:4,fontStyle:'italic'}}>
              "cost you" = gate blocked trades that would have been profitable{'\n'}
              "saved you" = gate blocked trades that would have been losses
            </Text>
          </View>

          {/* Confidence calibration */}
          {Object.keys(perf.confBuckets).length > 1 && (
            <View style={{backgroundColor:T.bg3,borderRadius:8,padding:10}}>
              <Text style={{color:T.textDim,fontSize:9,fontWeight:'700',letterSpacing:0.5,marginBottom:8}}>
                CONFIDENCE CALIBRATION — which confidence range actually wins?
              </Text>
              {Object.entries(perf.confBuckets).sort((a,b)=>Number(a[0].split('-')[0])-Number(b[0].split('-')[0])).map(([bucket,{wins,total}])=>{
                const wr = total>0 ? wins/total*100 : 0;
                const col = wr>=55?T.green:wr>=45?T.amber??'#F59E0B':T.red;
                return (
                  <View key={bucket} style={{flexDirection:'row',alignItems:'center',marginBottom:4,gap:8}}>
                    <Text style={{color:T.textDim,fontSize:9,width:48}}>{bucket}%</Text>
                    <View style={{flex:1,height:6,backgroundColor:T.bg2,borderRadius:3,overflow:'hidden'}}>
                      <View style={{width:`${wr}%`,height:6,backgroundColor:col,borderRadius:3}}/>
                    </View>
                    <Text style={{color:col,fontSize:9,fontWeight:'700',width:36}}>{wr.toFixed(0)}% wr</Text>
                    <Text style={{color:T.textDim,fontSize:9,width:24}}>{total}t</Text>
                  </View>
                );
              })}
              <Text style={{color:T.textDim,fontSize:9,marginTop:4,fontStyle:'italic'}}>
                Shows actual win rate of blocked trades by confidence bucket. If 40-50 has high win rate, your threshold may be too strict.
              </Text>
            </View>
          )}
          {/* Threshold simulator */}
          {perf.thresholds.length>1&&(
            <View style={{backgroundColor:T.bg3,borderRadius:8,padding:10}}>
              <Text style={{color:T.textDim,fontSize:9,fontWeight:'700',letterSpacing:0.5,marginBottom:4}}>THRESHOLD SIMULATOR — Confidence Gate</Text>
              <Text style={{color:T.textDim,fontSize:9,fontStyle:'italic',marginBottom:8}}>If confidence minimum were changed, how many shadow trades would qualify and what would the outcome be?</Text>
              {/* Header */}
              <View style={{flexDirection:'row',marginBottom:4}}>
                {['Threshold','Trades','Win Rate','Net P&L','Prof. Factor'].map(h=>(
                  <Text key={h} style={{color:T.textDim,fontSize:8,fontWeight:'700',flex:1,textAlign:'center'}}>{h}</Text>
                ))}
              </View>
              {perf.thresholds.map((r:any)=>{
                const isCurrent = r.thresh===50; // highlight the current threshold
                const wrCol = r.wr>=55?T.green:r.wr>=45?(T.amber??'#F59E0B'):T.red;
                const netCol = r.net>=0?T.green:T.red;
                return (
                  <View key={r.thresh} style={{flexDirection:'row',paddingVertical:5,borderRadius:6,
                    backgroundColor:isCurrent?T.accent+'18':'transparent',
                    borderLeftWidth:isCurrent?2:0,borderLeftColor:T.accent,paddingLeft:isCurrent?4:0,marginBottom:2}}>
                    <Text style={{color:isCurrent?T.accent:T.textDim,fontSize:10,fontWeight:isCurrent?'700':'400',flex:1,textAlign:'center'}}>≥{r.thresh}{isCurrent?' ✓':''}</Text>
                    <Text style={{color:T.text,fontSize:10,flex:1,textAlign:'center'}}>{r.count}</Text>
                    <Text style={{color:wrCol,fontSize:10,fontWeight:'600',flex:1,textAlign:'center'}}>{r.wr.toFixed(0)}%</Text>
                    <Text style={{color:netCol,fontSize:10,fontWeight:'600',flex:1,textAlign:'center'}}>{fmtPnl(r.net)}</Text>
                    <Text style={{color:T.text,fontSize:10,flex:1,textAlign:'center'}}>{r.pf===0?'—':r.pf.toFixed(2)}</Text>
                  </View>
                );
              })}
              <Text style={{color:T.textDim,fontSize:9,fontStyle:'italic',marginTop:6}}>
                ✓ marks the current threshold (50). Lower rows include more trades. Higher rows include fewer but more selective.
              </Text>
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Shadow Card ────────────────────────────────────────────────────────────────
function ShadowCard({t, T, livePrice, navigation}: {t:ShadowTrade; T:any; livePrice?:number; navigation:any}) {
  const [expanded, setExpanded] = useState(false);
  const gColor = GATE_COLORS[t.blockGate]??'#6B7280';
  const isOpen = t.outcome==='OPEN';
  const v = verdictInfo(t);
  const currentPnl = isOpen&&livePrice ? livePnl(t,livePrice) : t.pnlPct??null;
  const pnlColor = (currentPnl??0)>=0 ? T.green : T.red;
  const oc = t.outcome==='TP_HIT'?T.green:t.outcome==='SL_HIT'?T.red:t.outcome==='EXPIRED'?T.textDim:T.accent;
  const gateDetails = formatGateDetails(t);
  const resolvedDuration = t.closedAt ? fmtDuration(t.closedAt-t.blockedAt) : null;

  return (
    <View style={{backgroundColor:T.bg2,borderRadius:12,marginBottom:10,borderLeftWidth:3,borderLeftColor:gColor,overflow:'hidden'}}>
      <TouchableOpacity activeOpacity={0.85} onPress={()=>setExpanded(e=>!e)}>
        <View style={{padding:12,paddingBottom:8}}>
          {/* Header */}
          <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',marginBottom:8}}>
            <View style={{flex:1,gap:4}}>
              <View style={{flexDirection:'row',alignItems:'center',gap:5}}>
                <Text style={{color:T.text,fontSize:14,fontWeight:'800'}}>{t.symbol}</Text>
                <Text style={{color:T.textDim,fontSize:11}}>•</Text>
                <Text style={{color:T.textDim,fontSize:12,fontWeight:'600'}}>{t.timeframe}</Text>
              </View>
              <View style={{flexDirection:'row',flexWrap:'wrap',gap:4}}>
                <Pill label={t.direction} color={t.direction==='LONG'?T.green:T.red}/>
                <Pill label={GATE_LABELS[t.blockGate]+' GATE'} color={gColor}/>
                {t.signal.signalType?<Pill label={t.signal.signalType} color={T.accent}/>:null}
              </View>
            </View>
            <View style={{alignItems:'flex-end',gap:3}}>
              <Text style={{color:oc,fontSize:11,fontWeight:'700'}}>{t.outcome==='TP_HIT'?'✓ TP Hit':t.outcome==='SL_HIT'?'✗ SL Hit':t.outcome==='EXPIRED'?'⏱ Expired':'⟳ Open'}</Text>
              <Text style={{color:T.textDim,fontSize:9}}>{fmtTimestamp(t.blockedAt)}</Text>
              <Text style={{color:T.textDim,fontSize:9}}>{expanded?'▲ less':'▼ details'}</Text>
            </View>
          </View>
          {/* Key metrics */}
          <View style={{flexDirection:'row',flexWrap:'wrap',gap:8,paddingTop:8,borderTopWidth:1,borderTopColor:T.bg3}}>
            <DataCol label="Entry" value={t.entryPrice.toFixed(2)} T={T}/>
            <DataCol label="SL" value={t.stopLoss.toFixed(2)} valueColor={T.red} T={T}/>
            <DataCol label="TP" value={t.takeProfit.toFixed(2)} valueColor={T.green} T={T}/>
            {currentPnl!=null&&<DataCol label={isOpen?'Live P&L':'P&L'} value={fmtPnl(currentPnl)} valueColor={pnlColor} T={T}/>}
            {t.rr!=null&&<DataCol label="R:R" value={`1:${t.rr.toFixed(1)}`} T={T}/>}
            <DataCol label="P(up)" value={`${(t.signal.ensembleProbUp*100).toFixed(0)}%`} T={T}/>
          </View>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={{paddingHorizontal:12,paddingBottom:12,gap:8}}>
          {/* Signal snapshot */}
          <View style={{backgroundColor:T.bg3,borderRadius:8,padding:10}}>
            <Text style={{color:T.textDim,fontSize:9,fontWeight:'700',letterSpacing:0.5,marginBottom:8}}>SIGNAL SNAPSHOT</Text>
            <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
              <DataCol label="Confidence" value={`${t.signal.confidence.toFixed(0)}/100`} T={T}/>
              <DataCol label="P(up)" value={`${(t.signal.ensembleProbUp*100).toFixed(1)}%`} T={T}/>
              <DataCol label="Regime" value={t.signal.regime||'—'} T={T}/>
              {t.signal.signalType?<DataCol label="Signal type" value={t.signal.signalType} T={T}/>:null}
              {t.signal.action?<DataCol label="Action" value={t.signal.action} T={T}/>:null}
            </View>
          </View>
          {/* Gate details */}
          {gateDetails.length>0&&(
            <View style={{backgroundColor:gColor+'12',borderRadius:8,padding:10,borderWidth:1,borderColor:gColor+'33'}}>
              <Text style={{color:gColor,fontSize:9,fontWeight:'700',letterSpacing:0.5,marginBottom:8}}>
                {GATE_LABELS[t.blockGate].toUpperCase()} GATE DETAILS
              </Text>
              <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
                {gateDetails.map(({label,value})=><DataCol key={label} label={label} value={value} T={T}/>)}
              </View>
            </View>
          )}
          {/* Timing */}
          <View style={{backgroundColor:T.bg3,borderRadius:8,padding:10}}>
            <Text style={{color:T.textDim,fontSize:9,fontWeight:'700',letterSpacing:0.5,marginBottom:8}}>TIMING</Text>
            <View style={{flexDirection:'row',flexWrap:'wrap',gap:8}}>
              {isOpen ? (
                <>
                  <DataCol label="Time open" value={fmtDuration(Date.now()-t.blockedAt)} T={T}/>
                  <DataCol label="~Candles" value={fmtCandles(t.ticksElapsed)} T={T}/>
                  {livePrice?<DataCol label="Current price" value={livePrice.toFixed(2)} T={T}/>:null}
                </>
              ) : (
                <>
                  {resolvedDuration&&<DataCol label="Resolved in" value={resolvedDuration} T={T}/>}
                  <DataCol label={t.outcome==='TP_HIT'?'TP after':t.outcome==='SL_HIT'?'SL after':'Closed after'} value={`~${fmtCandles(t.ticksElapsed)} candles`} T={T}/>
                  {t.exitPrice&&<DataCol label="Exit price" value={t.exitPrice.toFixed(2)} T={T}/>}
                </>
              )}
            </View>
          </View>
          {/* Raw reason */}
          <View style={{backgroundColor:T.bg3,borderRadius:8,padding:10}}>
            <Text style={{color:T.textDim,fontSize:9,fontWeight:'700',letterSpacing:0.5,marginBottom:4}}>BLOCK REASON</Text>
            <Text style={{color:T.textDim,fontSize:10,lineHeight:15}}>{t.blockReason}</Text>
          </View>
          {/* Historical market context when this signal was blocked */}
          {(t as any).marketContext && (
            <MarketContextCard snapshot={(t as any).marketContext} T={T} compact />
          )}
          {/* Navigate to chart */}
          <TouchableOpacity
            onPress={()=>navigation.navigate('Chart',{symbol:t.symbol, initialTf:t.timeframe})}
            style={{backgroundColor:T.accent+'22',borderRadius:8,padding:10,alignItems:'center',flexDirection:'row',justifyContent:'center',gap:6}}>
            <Text style={{color:T.accent,fontSize:11,fontWeight:'700'}}>📊 Open {t.symbol} • {t.timeframe} Chart</Text>
          </TouchableOpacity>
        </View>
      )}

      {v&&(
        <View style={{backgroundColor:v.color+'18',paddingHorizontal:12,paddingVertical:7,borderTopWidth:1,borderTopColor:v.color+'22'}}>
          <Text style={{color:v.color,fontSize:10,fontWeight:'700'}}>{v.text}</Text>
        </View>
      )}
    </View>
  );
}

// ── Chip ───────────────────────────────────────────────────────────────────────
function Chip({label, active, color, onPress, count, T}: {label:string;active:boolean;color:string;onPress:()=>void;count?:number;T:any}) {
  return (
    <TouchableOpacity onPress={onPress}
      style={{backgroundColor:active?color:T.bg3,paddingHorizontal:10,paddingVertical:5,borderRadius:16,flexDirection:'row',alignItems:'center',gap:4}}>
      <Text style={{color:active?'#fff':T.textDim,fontSize:10,fontWeight:'600'}}>{label}</Text>
      {count!=null&&count>0&&(
        <View style={{backgroundColor:active?'rgba(255,255,255,0.25)':T.bg2,borderRadius:8,paddingHorizontal:4,paddingVertical:1}}>
          <Text style={{color:active?'#fff':T.textDim,fontSize:8,fontWeight:'700'}}>{count}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────
export default function ShadowJournalScreen({navigation}: any) {
  const {theme:T} = useTheme();
  const {prices} = useData();
  const isFocused = useIsFocused();
  const [trades, setTrades] = useState<ShadowTrade[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [fGate,    setFGate]    = useState<GateType|'ALL'>('ALL');
  const [fOutcome, setFOutcome] = useState<'ALL'|'TP_HIT'|'SL_HIT'|'OPEN'>('ALL');
  const [fDir,     setFDir]     = useState<'ALL'|'LONG'|'SHORT'>('ALL');
  const [fTF,      setFTF]      = useState<string>('ALL');
  const [fSymbol,  setFSymbol]  = useState<string>('ALL');
  const [sortKey,  setSortKey]  = useState('newest');
  const [sortIdx,  setSortIdx]  = useState(0);

  const load = useCallback(async()=>{
    // One-time cleanup of duplicates recorded before the dedup guard (v6.3.36).
    // Idempotent — a no-op once the journal is clean.
    await dedupExistingShadowTrades();
    const all = await loadShadowTrades();
    setTrades(all.sort((a,b)=>b.blockedAt-a.blockedAt));
  },[]);
  useEffect(()=>{load();},[load]);

  const [exporting, setExporting]         = useState(false);
  const [showExportPanel, setShowExportPanel] = useState(false);

  // FIX (root cause of "No trades for current filters" bug):
  // handleExport previously used useCallback with `visible` in its deps array.
  // `visible` was declared AFTER handleExport in the component body. Due to
  // JavaScript const TDZ behavior in Hermes (returns undefined instead of throwing),
  // `visible` was undefined in the deps array → useCallback never detected a change
  // → the callback permanently captured visible=[] from the first render (before
  // trades loaded). Every export attempt saw visible.length===0.
  //
  // Fix: store `visible` in a ref so the callback always reads the current value
  // without depending on the ordering of const declarations in the function body.
  // This is the canonical React pattern for callbacks needing fresh values without
  // being recreated on every render.
  const visibleRef = React.useRef<ShadowTrade[]>([]);

  const clearJournal = useCallback(() => {
    Alert.alert(
      'Clear Shadow Journal',
      'This will permanently delete all shadow trade history and reset Gate Analytics to zero. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear All', style: 'destructive', onPress: async () => {
          await clearAllShadowTrades();
          setTrades([]);
        }},
      ]
    );
  }, []);
  const onRefresh = useCallback(async () => {
    // Guard: don't fire during back-navigation slide. iOS ScrollView overscroll
    // during the slide-out animation is misread as a pull-to-refresh gesture.
    if (!isFocused) return;
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load, isFocused]);

  // Unique values for filter chips
  const symbols    = useMemo(()=>['ALL',...[...new Set(trades.map(t=>t.symbol))].sort()]     ,[trades]);
  const timeframes = useMemo(()=>['ALL',...[...new Set(trades.map(t=>t.timeframe))].sort()]  ,[trades]);
  const gates      = ['ALL','CONFIDENCE','REGIME','PORTFOLIO_RISK','POSITION_SIZING','DUPLICATE_POSITION','CASH','FILTER'] as (GateType|'ALL')[];

  // Apply filters
  const filtered = useMemo(()=>{
    let r = trades;
    if (fGate!=='ALL')    r=r.filter(t=>t.blockGate===fGate);
    if (fOutcome!=='ALL') r=r.filter(t=>t.outcome===fOutcome);
    if (fDir!=='ALL')     r=r.filter(t=>t.direction===fDir);
    if (fTF!=='ALL')      r=r.filter(t=>t.timeframe===fTF);
    if (fSymbol!=='ALL')  r=r.filter(t=>t.symbol===fSymbol);
    return r;
  },[trades,fGate,fOutcome,fDir,fTF,fSymbol]);

  // Apply sort
  const visible = useMemo(()=>{
    const r=[...filtered];
    switch(sortKey){
      case 'newest':       return r.sort((a,b)=>b.blockedAt-a.blockedAt);
      case 'oldest':       return r.sort((a,b)=>a.blockedAt-b.blockedAt);
      case 'best_pnl':     return r.sort((a,b)=>(b.pnlPct??-999)-(a.pnlPct??-999));
      case 'worst_pnl':    return r.sort((a,b)=>(a.pnlPct??999)-(b.pnlPct??999));
      case 'highest_conf': return r.sort((a,b)=>b.signal.confidence-a.signal.confidence);
      case 'best_rr':      return r.sort((a,b)=>(b.rr??0)-(a.rr??0));
      case 'missed_winner':return r.filter(t=>t.outcome==='TP_HIT').sort((a,b)=>(b.pnlPct??0)-(a.pnlPct??0)).concat(r.filter(t=>t.outcome!=='TP_HIT'));
      default:             return r;
    }
  },[filtered,sortKey]);

  // Update ref on every render so handleExport always has fresh visible list
  visibleRef.current = visible;

  // handleExport placed AFTER visible to avoid stale-closure issues.
  // Uses visibleRef to guarantee it always reads the current filtered+sorted list.
  const handleExport = useCallback(async (format: ExportFormat) => {
    const currentVisible = visibleRef.current;
    if (currentVisible.length === 0) {
      Alert.alert('Nothing to export', 'No shadow trades match the current filters.');
      return;
    }
    setExporting(true);
    setShowExportPanel(false);
    try {
      const filters = {
        symbol:    fSymbol  !== 'ALL' ? fSymbol  : undefined,
        gate:      fGate    !== 'ALL' ? fGate    : undefined,
        outcome:   fOutcome !== 'ALL' ? fOutcome : undefined,
        direction: fDir     !== 'ALL' ? fDir     : undefined,
        tf:        fTF      !== 'ALL' ? fTF      : undefined,
      };
      // Uses the shared export engine (expo-print → real PDF, expo-sharing → native share sheet)
      // Identical pipeline to Paper Journal export — no duplicate implementation.
      await exportShadowJournal(currentVisible, format, filters);
    } catch (e: any) {
      Alert.alert('Export failed', e.message ?? 'Unknown error');
    } finally {
      setExporting(false);
    }
  }, [fSymbol, fGate, fOutcome, fDir, fTF]); // visible accessed via ref, not deps

  const cycleSort = () => {
    const next=(sortIdx+1)%SORT_OPTIONS.length;
    setSortIdx(next); setSortKey(SORT_OPTIONS[next].key);
  };

  const hasActiveFilter = fGate!=='ALL'||fOutcome!=='ALL'||fDir!=='ALL'||fTF!=='ALL'||fSymbol!=='ALL';
  const clearFilters = () => { setFGate('ALL');setFOutcome('ALL');setFDir('ALL');setFTF('ALL');setFSymbol('ALL'); };

  const open  = trades.filter(t=>t.outcome==='OPEN').length;
  const tpHit = trades.filter(t=>t.outcome==='TP_HIT').length;
  const slHit = trades.filter(t=>t.outcome==='SL_HIT').length;
  const wr    = (tpHit+slHit)>0 ? Math.round(tpHit/(tpHit+slHit)*100) : null;

  return (
    <SafeAreaView style={{flex:1,backgroundColor:T.bg0}}>
      <ScrollView contentContainerStyle={{padding:16,paddingBottom:48}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent}/>}>

        <Text style={{color:T.text,fontSize:20,fontWeight:'800',marginBottom:2}}>Shadow Journal</Text>
        <Text style={{color:T.textDim,fontSize:11,marginBottom:12,lineHeight:16}}>
          Opportunities the AI blocked — tracked to see if the decision was right
        </Text>

        {/* ── Export panel ──────────────────────────────────────────────── */}
        <View style={{ marginBottom: 14 }}>
          <TouchableOpacity onPress={() => setShowExportPanel(e => !e)}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 10, borderRadius: 10, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border }}>
            <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>
              {exporting ? '⏳ Exporting…' : '⬆️ Export Shadow Journal'}
            </Text>
            <Text style={{ color: T.textDim, fontSize: 10 }}>
              ({visible.length} trade{visible.length !== 1 ? 's' : ''}{hasActiveFilter ? ', filtered' : ''})
            </Text>
          </TouchableOpacity>

          {showExportPanel && !exporting && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity onPress={() => handleExport('CSV')}
                style={{ flex: 1, padding: 12, borderRadius: 10, alignItems: 'center', backgroundColor: T.green + '18', borderWidth: 1, borderColor: T.green + '50' }}>
                <Text style={{ fontSize: 20, marginBottom: 4 }}>📄</Text>
                <Text style={{ color: T.green, fontWeight: '800', fontSize: 12 }}>📊 CSV</Text>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2, textAlign: 'center' }}>Spreadsheet-ready{'\n'}Excel / Google Sheets</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleExport('PDF')}
                style={{ flex: 1, padding: 12, borderRadius: 10, alignItems: 'center', backgroundColor: T.accent + '18', borderWidth: 1, borderColor: T.accent + '50' }}>
                <Text style={{ fontSize: 20, marginBottom: 4 }}>📄</Text>
                <Text style={{ color: T.accent, fontWeight: '800', fontSize: 12 }}>PDF</Text>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2, textAlign: 'center' }}>Real PDF · Native{'\n'}share sheet</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── What is Shadow Journal? help card ─────────────────────────── */}
        <View style={{backgroundColor:T.bg3,borderRadius:10,padding:12,marginBottom:14,
          borderLeftWidth:3,borderLeftColor:T.accent}}>
          <Text style={{color:T.textDim,fontSize:9,fontWeight:'800',letterSpacing:0.8,marginBottom:5}}>
            ℹ️ WHAT IS SHADOW JOURNAL?
          </Text>
          <Text style={{color:T.text,fontSize:11,lineHeight:17,marginBottom:6}}>
            Shadow Journal records trading opportunities that were not executed and why.
          </Text>
          <Text style={{color:T.textDim,fontSize:10,lineHeight:15,marginBottom:4}}>
            Depending on the situation, this may include AI-blocked opportunities, execution failures, or other tracked outcomes. It then tracks what would have happened — whether the trade would have hit its target or its stop-loss.
          </Text>
          <Text style={{color:T.textDim,fontSize:10,lineHeight:15}}>
            Your <Text style={{color:T.accent,fontWeight:'700'}}>AI Trading Coach</Text> uses this history to help you review missed opportunities and improve your decision-making over time.
          </Text>
        </View>

        {/* Stats strip */}
        <View style={{flexDirection:'row',gap:8,marginBottom:14}}>
          {([['Blocked',trades.length,T.text],['Open',open,T.accent],['TP Hit',tpHit,T.green],['SL Hit',slHit,T.red],
             ...(wr!=null?[['Win%',`${wr}%`,wr>=50?T.red:T.green]]:[])
          ] as [string,string|number,string][]).map(([l,v,c])=>(
            <View key={l} style={{flex:1,backgroundColor:T.bg3,borderRadius:8,padding:8,alignItems:'center'}}>
              <Text style={{color:T.textDim,fontSize:9}}>{l}</Text>
              <Text style={{color:c,fontSize:14,fontWeight:'800'}}>{String(v)}</Text>
            </View>
          ))}
        </View>

        {/* Performance summary */}
        <PerformanceSummaryCard trades={trades} T={T}/>

        {/* Filter bar */}
        <View style={{marginBottom:10}}>
          {/* Row 1: Gate */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom:6}}>
            <View style={{flexDirection:'row',gap:6,paddingRight:8}}>
              {gates.map(g=>(
                <Chip key={g} label={g==='ALL'?'All Gates':GATE_LABELS[g as GateType]}
                  active={fGate===g} color={g==='ALL'?T.accent:GATE_COLORS[g as GateType]}
                  count={g==='ALL'?undefined:trades.filter(t=>t.blockGate===g).length}
                  onPress={()=>setFGate(fGate===g?'ALL':g)} T={T}/>
              ))}
            </View>
          </ScrollView>
          {/* Row 2: Outcome + Direction + Sort */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{marginBottom:6}}>
            <View style={{flexDirection:'row',gap:6,paddingRight:8}}>
              {(['ALL','TP_HIT','SL_HIT','OPEN'] as const).map(o=>(
                <Chip key={o} label={o==='ALL'?'All Outcomes':o==='TP_HIT'?'TP Hit':o==='SL_HIT'?'SL Hit':'Open'}
                  active={fOutcome===o} color={o==='TP_HIT'?T.green:o==='SL_HIT'?T.red:o==='OPEN'?T.accent:T.textDim}
                  onPress={()=>setFOutcome(fOutcome===o?'ALL':o)} T={T}/>
              ))}
              <View style={{width:1,backgroundColor:T.bg3,marginHorizontal:2}}/>
              {(['ALL','LONG','SHORT'] as const).map(d=>(
                <Chip key={d} label={d==='ALL'?'Both':d}
                  active={fDir===d} color={d==='LONG'?T.green:d==='SHORT'?T.red:T.accent}
                  onPress={()=>setFDir(fDir===d?'ALL':d)} T={T}/>
              ))}
              <View style={{width:1,backgroundColor:T.bg3,marginHorizontal:2}}/>
              <TouchableOpacity onPress={cycleSort}
                style={{backgroundColor:T.accent,paddingHorizontal:10,paddingVertical:5,borderRadius:16,flexDirection:'row',gap:4,alignItems:'center'}}>
                <Text style={{color:'#fff',fontSize:10,fontWeight:'600'}}>↕ {SORT_OPTIONS[sortIdx].label}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
          {/* Row 3: Timeframe + Symbol (only if multiple values) */}
          {(timeframes.length>2||symbols.length>2)&&(
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={{flexDirection:'row',gap:6,paddingRight:8}}>
                {timeframes.slice(0,8).map(tf=>(
                  <Chip key={tf} label={tf==='ALL'?'All TF':tf}
                    active={fTF===tf} color={T.accent}
                    onPress={()=>setFTF(fTF===tf?'ALL':tf)} T={T}/>
                ))}
                {symbols.slice(0,6).map(s=>(
                  <Chip key={s} label={s==='ALL'?'All Symbols':s}
                    active={fSymbol===s} color='#06B6D4'
                    onPress={()=>setFSymbol(fSymbol===s?'ALL':s)} T={T}/>
                ))}
              </View>
            </ScrollView>
          )}
          {/* Clear filters */}
          {hasActiveFilter&&(
            <TouchableOpacity onPress={clearFilters} style={{marginTop:6,alignSelf:'flex-start'}}>
              <Text style={{color:T.red,fontSize:10,fontWeight:'600'}}>✕ Clear all filters</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Clear journal button */}
        <TouchableOpacity
          onPress={clearJournal}
          style={{ marginTop: 6, marginBottom: 4, alignSelf: 'flex-start',
            backgroundColor: T.red + '18', borderRadius: 6,
            paddingHorizontal: 10, paddingVertical: 5,
            borderWidth: 1, borderColor: T.red + '44' }}>
          <Text style={{ color: T.red, fontSize: 10, fontWeight: '700' }}>🗑 Clear Journal</Text>
        </TouchableOpacity>

        {/* Results count */}
        {hasActiveFilter&&(
          <Text style={{color:T.textDim,fontSize:10,marginBottom:8}}>
            Showing {visible.length} of {trades.length} trades
          </Text>
        )}

        {/* Empty state */}
        {visible.length===0&&(
          <View style={{alignItems:'center',paddingTop:60,paddingHorizontal:32}}>
            <Text style={{fontSize:36,marginBottom:12}}>🔍</Text>
            <Text style={{color:T.text,fontSize:15,fontWeight:'700',marginBottom:6,textAlign:'center'}}>
              {trades.length===0 ? 'No blocked trades yet' : 'No trades match your filters'}
            </Text>
            <Text style={{color:T.textDim,fontSize:12,lineHeight:18,textAlign:'center'}}>
              {trades.length===0
                ? 'When the AI blocks a trade due to market conditions, signal quality, or risk limits, it will appear here and be tracked to see what would have happened.'
                : 'Try clearing some filters to see more entries.'}
            </Text>
          </View>
        )}

        {/* Cards */}
        {visible.map(t=>(
          <ShadowCard key={t.id} t={t} T={T}
            livePrice={(prices as any)[t.symbol]?.price}
            navigation={navigation}/>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
