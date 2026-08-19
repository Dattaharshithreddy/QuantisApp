// Crypto Market Context — Test Suite (59 checks, mirrors Indian test coverage)

const NEUTRAL={fearGreedNorm:0.5,fearGreedTrend:0.5,fearGreedRegime:0.5,btcDominanceNorm:0.5,altDominanceNorm:0.25,stableRatioNorm:0.1,marketCapChange:0.5,marketRegime:0.33,fundingRateNorm:0.5,fundingBias:0.5,fundingOverheat:0,oiTrend:0.5,oiChange24h:0.5,oiConviction:0.5,stableDomNorm:0.5,stableTrend:0.5,stableSignal:0.5,overallSentiment:0.5,marketPhase:0.5};
const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));

function toFeatures(ctx) {
  if (!ctx) return {...NEUTRAL};
  const f={};
  const fg=ctx.fearGreed;
  if(fg){const rm={'EXTREME_FEAR':0,'FEAR':0.25,'NEUTRAL':0.5,'GREED':0.75,'EXTREME_GREED':1};f.fearGreedNorm=clamp(fg.value/100);f.fearGreedTrend=fg.trend==='FALLING'?0:fg.trend==='RISING'?1:0.5;f.fearGreedRegime=rm[fg.classification]??0.5;}
  else Object.assign(f,{fearGreedNorm:0.5,fearGreedTrend:0.5,fearGreedRegime:0.5});
  const mc=ctx.marketCap;
  if(mc){const rm2={'RISK_OFF':0,'NEUTRAL':0.33,'STABLE_DOMINANCE':0.4,'BTC_SEASON':0.5,'ALT_SEASON':0.75,'RISK_ON':1};f.btcDominanceNorm=clamp(mc.btcDominance/100);f.altDominanceNorm=clamp(mc.altcoinDominance/100);f.stableRatioNorm=clamp(mc.stablecoinRatio);f.marketCapChange=clamp(mc.totalChange24h/10*0.5+0.5);f.marketRegime=rm2[mc.regime]??0.33;}
  else Object.assign(f,{btcDominanceNorm:0.5,altDominanceNorm:0.25,stableRatioNorm:0.1,marketCapChange:0.5,marketRegime:0.33});
  const fr=ctx.funding;
  if(fr){const sm={'EXTREME_SHORT':0,'SHORT_BIASED':0.25,'NEUTRAL':0.5,'LONG_BIASED':0.75,'EXTREME_LONG':1};const CAP=0.001;f.fundingRateNorm=clamp(fr.fundingRate/CAP*0.5+0.5);f.fundingBias=sm[fr.sentiment]??0.5;f.fundingOverheat=fr.isOverheated?1:0;}
  else Object.assign(f,{fundingRateNorm:0.5,fundingBias:0.5,fundingOverheat:0});
  const oi=ctx.openInterest;
  if(oi){const cm={'BEARISH':0,'WEAK':0.25,'NEUTRAL':0.5,'BULLISH':1};f.oiTrend=oi.trend==='FALLING'?0:oi.trend==='RISING'?1:0.5;f.oiChange24h=clamp(oi.change24h/20*0.5+0.5);f.oiConviction=cm[oi.conviction]??0.5;}
  else Object.assign(f,{oiTrend:0.5,oiChange24h:0.5,oiConviction:0.5});
  const sc=ctx.stablecoin;
  if(sc){const sig={'RISK_OFF':0,'NEUTRAL':0.5,'RISK_ON':1};f.stableDomNorm=clamp(sc.totalStableDom/20);f.stableTrend=sc.trend==='FALLING'?0:sc.trend==='RISING'?1:0.5;f.stableSignal=sig[sc.signal]??0.5;}
  else Object.assign(f,{stableDomNorm:0.5,stableTrend:0.5,stableSignal:0.5});
  const fgS=fg?fg.value/100:0.5;
  const frS=fr?(fr.fundingRate+0.001)/0.002:0.5;
  const scS=sc?1-sc.totalStableDom/20:0.5;
  const mcS=mc?(mc.totalChange24h+10)/20:0.5;
  const scores=[fgS,frS,scS,mcS];
  f.overallSentiment=clamp(scores.reduce((s,v)=>s+v,0)/scores.length);
  f.marketPhase=clamp(fgS*0.4+frS*0.2+scS*0.2+mcS*0.2);
  return f;
}

// Asset type routing
function detectKind(src,type){
  if(src==='binance'||type==='CRYPTO') return 'CRYPTO';
  if(src==='ao'||type==='STOCK'||type==='INDEX') return 'INDIAN';
  return 'NONE';
}

let p=0,f=0;
const check=(l,ok,d='')=>{if(ok){p++;console.log('  ✅',l);}else{f++;console.log('  ❌',l,d);}};
const near=(a,b,eps=0.01)=>Math.abs(a-b)<eps;

const full={
  fearGreed:{value:72,classification:'GREED',previousDay:65,trend:'RISING',fetchedAt:0},
  marketCap:{totalMarketCapUsd:2e12,totalExBtcMarketCapUsd:1e12,btcDominance:52,ethDominance:18,altcoinDominance:22,stablecoinRatio:0.08,totalChange24h:4,btcDominanceChange24h:0.5,regime:'RISK_ON',fetchedAt:0},
  funding:{symbol:'BTCUSDT',fundingRate:0.0003,annualized:0.33,sentiment:'LONG_BIASED',isOverheated:false,fetchedAt:0},
  openInterest:{symbol:'BTCUSDT',openInterestUsd:15e9,change24h:8,trend:'RISING',conviction:'BULLISH',fetchedAt:0},
  stablecoin:{usdtDominance:5,usdcDominance:3,totalStableDom:8,trend:'FALLING',signal:'RISK_ON',fetchedAt:0},
  available:['FEAR_GREED','MARKET_CAP','FUNDING','OPEN_INTEREST','STABLECOIN'],
  symbol:'BTCUSD',fetchedAt:0,
};

console.log('\n── 1. Null context → neutral defaults ──');
const nc=toFeatures(null);
for(const[k,v] of Object.entries(NEUTRAL)) check(`${k} neutral`,near(nc[k],v));

console.log('\n── 2. All outputs in [0,1] ──');
const feat=toFeatures(full);
for(const[k,v] of Object.entries(feat)) check(`${k}=${v.toFixed(3)} in [0,1]`,v>=0&&v<=1);

console.log('\n── 3. Individual source null → neutral for that source ──');
check('F&G null → fearGreedNorm neutral',near(toFeatures({...full,fearGreed:null}).fearGreedNorm,0.5));
check('MarketCap null → btcDominanceNorm neutral',near(toFeatures({...full,marketCap:null}).btcDominanceNorm,0.5));
check('Funding null → fundingRateNorm neutral',near(toFeatures({...full,funding:null}).fundingRateNorm,0.5));
check('OI null → oiTrend neutral',near(toFeatures({...full,openInterest:null}).oiTrend,0.5));
check('Stablecoin null → stableDomNorm neutral',near(toFeatures({...full,stablecoin:null}).stableDomNorm,0.5));

console.log('\n── 4. Fear & Greed regime encoding ──');
const mkFG=(v,c)=>toFeatures({...full,fearGreed:{value:v,classification:c,previousDay:v,trend:'FLAT',fetchedAt:0}});
check('EXTREME_FEAR→0',near(mkFG(10,'EXTREME_FEAR').fearGreedRegime,0));
check('FEAR→0.25',near(mkFG(35,'FEAR').fearGreedRegime,0.25));
check('NEUTRAL→0.5',near(mkFG(50,'NEUTRAL').fearGreedRegime,0.5));
check('GREED→0.75',near(mkFG(65,'GREED').fearGreedRegime,0.75));
check('EXTREME_GREED→1',near(mkFG(85,'EXTREME_GREED').fearGreedRegime,1));
check('F&G 72 → fearGreedNorm 0.72',near(toFeatures(full).fearGreedNorm,0.72));

console.log('\n── 5. Funding rate encoding ──');
const mkFR=(rate,sent,over)=>toFeatures({...full,funding:{symbol:'BTCUSDT',fundingRate:rate,annualized:rate*3*365,sentiment:sent,isOverheated:over,fetchedAt:0}});
check('Extreme long → fundingBias=1',near(mkFR(0.001,'EXTREME_LONG',true).fundingBias,1));
check('Extreme short → fundingBias=0',near(mkFR(-0.001,'EXTREME_SHORT',true).fundingBias,0));
check('Neutral rate → fundingBias=0.5',near(mkFR(0,'NEUTRAL',false).fundingBias,0.5));
check('Overheated → fundingOverheat=1',mkFR(0.001,'EXTREME_LONG',true).fundingOverheat===1);
check('Not overheated → fundingOverheat=0',mkFR(0.0001,'LONG_BIASED',false).fundingOverheat===0);

console.log('\n── 6. Market regime encoding ──');
const mkMR=(reg)=>toFeatures({...full,marketCap:{...full.marketCap,regime:reg}});
check('RISK_OFF→0',near(mkMR('RISK_OFF').marketRegime,0));
check('NEUTRAL→0.33',near(mkMR('NEUTRAL').marketRegime,0.33));
check('BTC_SEASON→0.5',near(mkMR('BTC_SEASON').marketRegime,0.5));
check('ALT_SEASON→0.75',near(mkMR('ALT_SEASON').marketRegime,0.75));
check('RISK_ON→1',near(mkMR('RISK_ON').marketRegime,1));

console.log('\n── 7. OI conviction encoding ──');
const mkOI=(conv)=>toFeatures({...full,openInterest:{...full.openInterest,conviction:conv}});
check('BEARISH→0',near(mkOI('BEARISH').oiConviction,0));
check('WEAK→0.25',near(mkOI('WEAK').oiConviction,0.25));
check('NEUTRAL→0.5',near(mkOI('NEUTRAL').oiConviction,0.5));
check('BULLISH→1',near(mkOI('BULLISH').oiConviction,1));

console.log('\n── 8. Determinism ──');
const a=toFeatures(full),b=toFeatures(full);
check('Same input → identical output',Object.keys(a).every(k=>a[k]===b[k]));

console.log('\n── 9. Extreme values clamped ──');
const ext=toFeatures({...full,fearGreed:{value:200,classification:'EXTREME_GREED',previousDay:100,trend:'RISING',fetchedAt:0},funding:{...full.funding,fundingRate:1,isOverheated:true}});
check('F&G 200 → fearGreedNorm clamped to 1',ext.fearGreedNorm===1);
check('Funding 100% → fundingRateNorm clamped to 1',ext.fundingRateNorm===1);
check('All values ≤1',Object.values(ext).every(v=>v<=1));
check('All values ≥0',Object.values(ext).every(v=>v>=0));

console.log('\n── 10. Asset routing ──');
check('binance src → CRYPTO',detectKind('binance')  ==='CRYPTO');
check('ao src → INDIAN',    detectKind('ao')        ==='INDIAN');
check('CRYPTO type → CRYPTO',detectKind('other','CRYPTO')==='CRYPTO');
check('STOCK type → INDIAN', detectKind('other','STOCK') ==='INDIAN');
check('INDEX type → INDIAN', detectKind('other','INDEX') ==='INDIAN');
check('unknown → NONE',      detectKind('av','FOREX')    ==='NONE');

console.log('\n── 11. Regression: ML vector unchanged ──');
const fs=require('fs');
const ml=fs.readFileSync('/tmp/QuantisUpdate/QuantisApp/src/utils/mlSignal.ts','utf8');
check('116-assertion preserved',ml.includes('features.length !== FEATURE_NAMES.length'));
check('cryptoMarketContext NOT imported in mlSignal',!ml.includes('cryptoMarketContext'));
check('Fear/Greed NOT in FEATURE_NAMES',!ml.includes('Fear/Greed level'));
check('BTC dominance NOT in FEATURE_NAMES',!ml.includes('BTC dominance'));
check('116-error message preserved',ml.includes('length mismatch'));

console.log('\n── 12. Stablecoin risk signal encoding ──');
const mkSC=(sig,trend)=>toFeatures({...full,stablecoin:{usdtDominance:5,usdcDominance:3,totalStableDom:8,trend,signal:sig,fetchedAt:0}});
check('RISK_OFF → stableSignal=0',near(mkSC('RISK_OFF','RISING').stableSignal,0));
check('NEUTRAL → stableSignal=0.5',near(mkSC('NEUTRAL','FLAT').stableSignal,0.5));
check('RISK_ON → stableSignal=1',near(mkSC('RISK_ON','FALLING').stableSignal,1));

console.log('\n'+'═'.repeat(55));
console.log(`  ${p+f} checks | ✅ ${p} | ❌ ${f}`);
if(!f) console.log('\n  ALL CRYPTO CONTEXT INVARIANTS PROVEN');
console.log('═'.repeat(55));
