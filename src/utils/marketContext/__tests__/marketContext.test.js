const NEUTRAL={vixNorm:0.35,vixSmaRatio:0.5,vixTrend:0.5,vixMomentum:0.5,vixRegime:0.33,adRatio:0.5,adTrend:0.5,breadthThrust:0,fiiFlowNorm:0.5,diiFlowNorm:0.5,netFlowNorm:0.5,fiiBias:0.5,pcrNorm:0.5,pcrTrend:0.5,pcrSentiment:0.5,sectorMomentum:0.5,sectorParticip:0.5,leaderStrength:0.5,sectorBreadth:0.5};
const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
function toFeatures(ctx){
  if(!ctx)return{...NEUTRAL};
  const f={};
  const v=ctx.vix;
  if(v){f.vixNorm=clamp(v.current/40);f.vixSmaRatio=clamp((v.current/(v.sma20||1))/2);f.vixTrend=v.trend==='FALLING'?0:v.trend==='RISING'?1:0.5;f.vixMomentum=clamp(v.momentum*0.5+0.5);f.vixRegime=v.regime==='LOW'?0:v.regime==='NORMAL'?0.33:v.regime==='HIGH'?0.66:1;}
  else Object.assign(f,{vixNorm:NEUTRAL.vixNorm,vixSmaRatio:NEUTRAL.vixSmaRatio,vixTrend:NEUTRAL.vixTrend,vixMomentum:NEUTRAL.vixMomentum,vixRegime:NEUTRAL.vixRegime});
  const b=ctx.breadth;
  if(b){f.adRatio=clamp(b.adRatio);f.adTrend=b.adTrend==='BEARISH'?0:b.adTrend==='BULLISH'?1:0.5;f.breadthThrust=b.breadthThrust?1:0;}
  else Object.assign(f,{adRatio:NEUTRAL.adRatio,adTrend:NEUTRAL.adTrend,breadthThrust:0});
  const fi=ctx.fiidii;
  if(fi){const CAP=5000;f.fiiFlowNorm=clamp(fi.fiiRolling5/CAP*0.5+0.5);f.diiFlowNorm=clamp(fi.diiRolling5/CAP*0.5+0.5);f.netFlowNorm=clamp(fi.netFlow/CAP*0.5+0.5);f.fiiBias=fi.bias==='FII_SELL'?0:fi.bias==='FII_BUY'?1:0.5;}
  else Object.assign(f,{fiiFlowNorm:0.5,diiFlowNorm:0.5,netFlowNorm:0.5,fiiBias:0.5});
  const p=ctx.pcr;
  if(p){const pc=clamp(p.current,0.5,2.0);f.pcrNorm=clamp(1-((pc-0.5)/1.5));f.pcrTrend=p.trend==='FALLING'?0:p.trend==='RISING'?1:0.5;const sm={'EXTREME_BULLISH':1,'BULLISH':0.75,'NEUTRAL':0.5,'BEARISH':0.25,'EXTREME_BEARISH':0};f.pcrSentiment=sm[p.sentiment]??0.5;}
  else Object.assign(f,{pcrNorm:0.5,pcrTrend:0.5,pcrSentiment:0.5});
  const s=ctx.sectors;
  if(s){const rets=[s.bank,s.it,s.pharma,s.auto,s.fmcg,s.metal];const pos=rets.filter(r=>r>0).length;const lr=s.leader!=='NONE'?(s[s.leader.toLowerCase()]??0):0;f.sectorMomentum=clamp(s.momentum/0.02*0.5+0.5);f.sectorParticip=clamp(s.participation);f.leaderStrength=clamp(lr/0.03*0.5+0.5);f.sectorBreadth=clamp(pos/rets.length);}
  else Object.assign(f,{sectorMomentum:0.5,sectorParticip:0.5,leaderStrength:0.5,sectorBreadth:0.5});
  return f;
}

let p=0,f=0;
const check=(l,ok,d='')=>{if(ok){p++;console.log('  ✅',l);}else{f++;console.log('  ❌',l,d);}};
const near=(a,b,eps=0.01)=>Math.abs(a-b)<eps;
const full={vix:{current:25,sma5:22,sma20:18,trend:'RISING',momentum:0.14,regime:'HIGH',fetchedAt:0},breadth:{advances:1200,declines:300,unchanged:50,adRatio:0.8,adTrend:'BULLISH',breadthThrust:true,fetchedAt:0},fiidii:{fiiNetCash:3000,diiNetCash:1500,fiiRolling5:2500,diiRolling5:1200,fiiConsecBuys:3,diiConsecBuys:5,netFlow:4500,bias:'FII_BUY',fetchedAt:0},pcr:{current:0.9,sma5:1.0,trend:'FALLING',sentiment:'BULLISH',isContrarianBull:false,isContrarianBear:false,fetchedAt:0},sectors:{bank:0.01,it:-0.005,pharma:0.008,auto:0.012,fmcg:-0.003,metal:0.015,leader:'METAL',participation:0.67,momentum:0.006,fetchedAt:0},available:['VIX','BREADTH','FII_DII','PCR','SECTORS'],fetchedAt:0};

console.log('\n── 1. Null context → neutral defaults ──');
const nc=toFeatures(null);
for(const[k,v] of Object.entries(NEUTRAL)) check(`${k} neutral`,near(nc[k],v));

console.log('\n── 2. All outputs in [0,1] ──');
const feat=toFeatures(full);
for(const[k,v] of Object.entries(feat)) check(`${k}=${v.toFixed(3)} in [0,1]`,v>=0&&v<=1);

console.log('\n── 3. Individual source null → neutral for that source ──');
check('VIX null → vixNorm neutral', near(toFeatures({...full,vix:null}).vixNorm,NEUTRAL.vixNorm));
check('Breadth null → adRatio neutral', near(toFeatures({...full,breadth:null}).adRatio,NEUTRAL.adRatio));
check('FII null → fiiFlowNorm neutral', near(toFeatures({...full,fiidii:null}).fiiFlowNorm,0.5));
check('PCR null → pcrNorm neutral', near(toFeatures({...full,pcr:null}).pcrNorm,0.5));
check('Sectors null → sectorMomentum neutral', near(toFeatures({...full,sectors:null}).sectorMomentum,0.5));

console.log('\n── 4. VIX regime encoding ──');
const mkVix=(cur,reg)=>toFeatures({...full,vix:{current:cur,sma5:15,sma20:15,trend:'FLAT',momentum:0,regime:reg,fetchedAt:0}});
check('LOW→0',near(mkVix(10,'LOW').vixRegime,0));
check('NORMAL→0.33',near(mkVix(15,'NORMAL').vixRegime,0.33));
check('HIGH→0.66',near(mkVix(25,'HIGH').vixRegime,0.66));
check('EXTREME→1',near(mkVix(35,'EXTREME').vixRegime,1));

console.log('\n── 5. PCR contrarian encoding ──');
const mkPCR=(cur,sent)=>toFeatures({...full,pcr:{current:cur,sma5:1,trend:'FLAT',sentiment:sent,isContrarianBull:cur>1.3,isContrarianBear:cur<0.7,fetchedAt:0}});
check('PCR 0.7 → high pcrNorm',mkPCR(0.7,'NEUTRAL').pcrNorm>0.7);
check('PCR 1.5 → low pcrNorm',mkPCR(1.5,'BEARISH').pcrNorm<0.4);
check('EXTREME_BULLISH → 1',near(mkPCR(0.6,'EXTREME_BULLISH').pcrSentiment,1));
check('EXTREME_BEARISH → 0',near(mkPCR(1.4,'EXTREME_BEARISH').pcrSentiment,0));

console.log('\n── 6. Determinism ──');
const a=toFeatures(full),b=toFeatures(full);
check('Same input → identical output',Object.keys(a).every(k=>a[k]===b[k]));

console.log('\n── 7. Extreme values clamped ──');
const ext=toFeatures({...full,vix:{current:100,sma5:5,sma20:5,trend:'RISING',momentum:5,regime:'EXTREME',fetchedAt:0},fiidii:{...full.fiidii,fiiRolling5:50000,diiRolling5:-50000,netFlow:100000}});
check('VIX 100 → clamped to 1',ext.vixNorm===1);
check('FII 50000 → ≤1',ext.fiiFlowNorm<=1);
check('DII -50000 → ≥0',ext.diiFlowNorm>=0);

console.log('\n── 8. Regression: ML vector unchanged ──');
const fs=require('fs');
const ml=fs.readFileSync('/tmp/QuantisUpdate/QuantisApp/src/utils/mlSignal.ts','utf8');
check('116-assertion preserved in mlSignal',ml.includes('features.length !== FEATURE_NAMES.length'));
check('marketContext NOT imported in mlSignal',!ml.includes('marketContext'));
check('VIX level NOT in FEATURE_NAMES',!ml.includes('VIX level'));
check('116-feature error message preserved',ml.includes('length mismatch'));

console.log('\n'+'═'.repeat(55));
console.log(`  ${p+f} checks | ✅ ${p} | ❌ ${f}`);
if(!f) console.log('\n  ALL MARKET CONTEXT INVARIANTS PROVEN');
console.log('═'.repeat(55));
