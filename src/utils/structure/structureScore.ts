// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURE SCORE
// Converts a StructureSnapshot into a flat StructureScores object —
// exactly 19 normalized values appended to the ML feature vector.
//
// Feature ordering is DETERMINISTIC and must never change after v4.7.0.
// ─────────────────────────────────────────────────────────────────────────────
import { StructureSnapshot, StructureScores } from './structureTypes';
import { trendToFeatures } from './trendAnalyzer';

export function snapshotToScores(snap: StructureSnapshot): StructureScores {
  const trend = trendToFeatures(snap.trend);

  // Internal trend: derived from internalHighLabel and internalLowLabel
  const intBullish = (snap.internalHighLabel === 'HH' ? 1 : 0) +
                     (snap.internalLowLabel  === 'HL' ? 1 : 0);
  const intBearish = (snap.internalHighLabel === 'LH' ? 1 : 0) +
                     (snap.internalLowLabel  === 'LL' ? 1 : 0);
  const internalTrend = (intBullish - intBearish) / 2; // -1 to +1

  // External trend: signed trend strength
  const externalTrend = trend.strength; // already -1..+1

  return {
    hhScore:           snap.hhScore,           // 0..1 (0 if no HH at bar i)
    hlScore:           snap.hlScore,           // 0..1
    lhScore:           snap.lhScore,           // 0..1
    llScore:           snap.llScore,           // 0..1
    trendStrength:     trend.strength,         // -1..+1
    trendConfidence:   trend.confidence,       // 0..1
    trendPersistence:  trend.persistence,      // 0..1
    trendAcceleration: trend.acceleration,     // -1..+1
    bosDetected:       snap.latestBOS    ? 1 : 0, // 0 or 1
    bosStrength:       snap.latestBOS    ? snap.latestBOS.breakStrength   : 0,
    bosConfidence:     snap.latestBOS    ? snap.latestBOS.confidence      : 0,
    chochDetected:     snap.latestCHoCH  ? 1 : 0,
    chochStrength:     snap.latestCHoCH  ? snap.latestCHoCH.breakStrength : 0,
    chochConfidence:   snap.latestCHoCH  ? snap.latestCHoCH.confidence    : 0,
    swingStrength:     snap.hhScore + snap.hlScore + snap.lhScore + snap.llScore > 0
                         ? Math.max(snap.hhScore, snap.hlScore, snap.lhScore, snap.llScore)
                         : 0,
    structureQuality:  snap.structureQuality,  // 0..1
    internalTrend,                             // -1..+1
    externalTrend,                             // -1..+1
    structureAge:      Math.min(1, snap.structureAge / 200), // 0..1 normalized
  };
}

// Flat array in the EXACT ORDER that will be appended to FEATURE_NAMES
// Features 47–65 (19 features)
export function scoresToArray(s: StructureScores): number[] {
  return [
    s.hhScore,            // 47
    s.hlScore,            // 48
    s.lhScore,            // 49
    s.llScore,            // 50
    s.trendStrength,      // 51
    s.trendConfidence,    // 52
    s.trendPersistence,   // 53
    s.trendAcceleration,  // 54
    s.bosDetected,        // 55
    s.bosStrength,        // 56
    s.bosConfidence,      // 57
    s.chochDetected,      // 58
    s.chochStrength,      // 59
    s.chochConfidence,    // 60
    s.swingStrength,      // 61
    s.structureQuality,   // 62
    s.internalTrend,      // 63
    s.externalTrend,      // 64
    s.structureAge,       // 65
  ];
}

export const STRUCTURE_FEATURE_NAMES = [
  'MS HH score',          // 47
  'MS HL score',          // 48
  'MS LH score',          // 49
  'MS LL score',          // 50
  'MS trend strength',    // 51
  'MS trend confidence',  // 52
  'MS trend persistence', // 53
  'MS trend accel',       // 54
  'MS BOS detected',      // 55
  'MS BOS strength',      // 56
  'MS BOS confidence',    // 57
  'MS CHoCH detected',    // 58
  'MS CHoCH strength',    // 59
  'MS CHoCH confidence',  // 60
  'MS swing strength',    // 61
  'MS structure quality', // 62
  'MS internal trend',    // 63
  'MS external trend',    // 64
  'MS structure age',     // 65
] as const;
