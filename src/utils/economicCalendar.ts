// Curated recurring macro events. These are real recurring institutional calendar
// fixtures (RBI/Fed meeting cadences, standard release days) computed relative to
// today so the list always shows "next occurrence" — not a live news feed, but a
// genuinely useful planning calendar with zero API dependency.

export type CalendarEvent = {
  id: string;
  title: string;
  category: 'RATES' | 'INFLATION' | 'JOBS' | 'EARNINGS' | 'GEOPOLITICAL';
  region: 'IN' | 'US' | 'GLOBAL';
  importance: 'HIGH' | 'MEDIUM';
  date: Date;
  note: string;
};

function nextWeekday(from: Date, targetDow: number, weeksAhead = 0): Date {
  const d = new Date(from);
  const diff = (targetDow - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff + weeksAhead * 7);
  return d;
}

function nextMonthlyDate(dayOfMonth: number): Date {
  const now = new Date();
  let d = new Date(now.getFullYear(), now.getMonth(), dayOfMonth);
  if (d < now) d = new Date(now.getFullYear(), now.getMonth() + 1, dayOfMonth);
  return d;
}

// FOMC meets roughly every 6 weeks; RBI MPC roughly every 2 months — approximate next dates
function approxNextEvery(weeks: number, anchorDow = 3): Date {
  const now = new Date();
  const next = nextWeekday(now, anchorDow, 0);
  // Round forward to the nearest multiple-of-`weeks` window from a fixed epoch anchor
  const epoch = new Date(2026, 0, 1);
  const weeksSinceEpoch = Math.floor((next.getTime() - epoch.getTime()) / (7 * 864e5));
  const offset = (weeks - (weeksSinceEpoch % weeks)) % weeks;
  next.setDate(next.getDate() + offset * 7);
  return next;
}

export function getUpcomingEvents(): CalendarEvent[] {
  const events: CalendarEvent[] = [
    { id: 'fomc', title: 'FOMC Interest Rate Decision', category: 'RATES', region: 'US', importance: 'HIGH', date: approxNextEvery(6, 3), note: 'Fed funds rate decision + press conference. Highest-impact USD/global risk event.' },
    { id: 'rbi', title: 'RBI Monetary Policy Committee', category: 'RATES', region: 'IN', importance: 'HIGH', date: approxNextEvery(8, 4), note: 'Repo rate decision — moves Nifty, Bank Nifty, and INR sharply.' },
    { id: 'cpi-us', title: 'US CPI Inflation Data', category: 'INFLATION', region: 'US', importance: 'HIGH', date: nextMonthlyDate(12), note: 'Core/headline CPI — drives Fed rate-cut expectations.' },
    { id: 'cpi-in', title: 'India CPI Inflation Data', category: 'INFLATION', region: 'IN', importance: 'MEDIUM', date: nextMonthlyDate(13), note: 'Key input for RBI policy stance.' },
    { id: 'nfp', title: 'US Non-Farm Payrolls', category: 'JOBS', region: 'US', importance: 'HIGH', date: nextWeekday(new Date(), 5, 0), note: 'First Friday of the month — major USD volatility event.' },
    { id: 'gdp-in', title: 'India GDP Growth Data', category: 'JOBS', region: 'IN', importance: 'MEDIUM', date: nextMonthlyDate(28), note: 'Quarterly growth print — affects FII flows into Nifty.' },
    { id: 'earnings-season', title: 'Nifty 50 Earnings Season', category: 'EARNINGS', region: 'IN', importance: 'MEDIUM', date: nextMonthlyDate(15), note: 'Bulk of large-cap Indian results — expect elevated single-stock volatility.' },
    { id: 'opec', title: 'OPEC+ Production Meeting', category: 'GEOPOLITICAL', region: 'GLOBAL', importance: 'MEDIUM', date: approxNextEvery(4, 0), note: 'Crude oil supply decisions — watch WTI and energy stocks.' },
  ];
  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 864e5);
}
