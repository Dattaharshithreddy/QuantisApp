export async function fetchForexRates(): Promise<Record<string, number>> {
  const r = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!r.ok) throw new Error('Forex error');
  const json = await r.json();
  return json.rates;
}

export function fxPrice(fxKey: string, fxInv: boolean, base: number, rates: Record<string, number> | null): number {
  const rate = rates?.[fxKey];
  if (!rate) return base;
  return fxInv ? rate : 1 / rate;
}
