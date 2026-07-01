export type TradingSession = 'ASIA' | 'LONDON' | 'NEW_YORK' | 'OVERLAP' | 'CLOSED';

// Session windows in UTC hours — standard approximate FX/global market hours.
export function getTradingSession(date: Date): TradingSession {
  const h = date.getUTCHours();
  const asia = h >= 0 && h < 9;
  const london = h >= 7 && h < 16;
  const ny = h >= 12 && h < 21;
  if (london && ny) return 'OVERLAP';
  if (asia) return 'ASIA';
  if (london) return 'LONDON';
  if (ny) return 'NEW_YORK';
  return 'CLOSED';
}

export function timeFeaturesAt(time: number) {
  const d = new Date(time);
  return {
    hourOfDay: d.getUTCHours(),
    dayOfWeek: d.getUTCDay(), // 0 = Sunday
    month: d.getUTCMonth() + 1,
    isWeekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
    session: getTradingSession(d),
  };
}
