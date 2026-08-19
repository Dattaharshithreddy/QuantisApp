import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { logger } from './logger';

// Named watchlists for the SCANNER specifically — deliberately NOT a
// replacement for the existing single customWatchlist (watchlist.ts), which
// DataContext already depends on for the app's main asset list and stays
// completely untouched. A named watchlist here is just a list of
// `symbol|src` KEYS referencing assets that already exist in allAssets
// (built-in + custom) — never duplicate Asset data, never a second source
// of truth for what an asset actually is.

export type NamedWatchlist = { name: string; symbolKeys: string[] }; // symbolKeys: "BTCUSD|binance" etc.

const KEY = 'namedWatchlists';
const ACTIVE_KEY = 'activeWatchlistName';
const DEFAULT_NAME = 'All Tracked Assets'; // the implicit watchlist = everything in allAssets, needs no entry of its own

export async function getNamedWatchlists(): Promise<NamedWatchlist[]> {
  try {
    const raw = await KVStore.get(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e: any) {
    logger.error('multiWatchlist', `Failed to load: ${e.message}`);
    return [];
  }
}

export async function saveNamedWatchlist(list: NamedWatchlist): Promise<NamedWatchlist[]> {
  const lists = await getNamedWatchlists();
  const idx = lists.findIndex(l => l.name === list.name);
  if (idx >= 0) lists[idx] = list; else lists.push(list);
  await KVStore.set(KEY, JSON.stringify(lists));
  return lists;
}

export async function deleteNamedWatchlist(name: string): Promise<NamedWatchlist[]> {
  const lists = (await getNamedWatchlists()).filter(l => l.name !== name);
  await KVStore.set(KEY, JSON.stringify(lists));
  const active = await getActiveWatchlistName();
  if (active === name) await setActiveWatchlistName(DEFAULT_NAME);
  return lists;
}

export async function getActiveWatchlistName(): Promise<string> {
  const raw = await KVStore.get(ACTIVE_KEY);
  return raw || DEFAULT_NAME;
}

export async function setActiveWatchlistName(name: string): Promise<void> {
  await KVStore.set(ACTIVE_KEY, name);
}

export { DEFAULT_NAME as DEFAULT_WATCHLIST_NAME };

// Resolves the active watchlist's symbol keys against the asset list the
// caller already has (allAssets from DataContext) — this is what makes
// "Default" mean "everything" with zero special-casing: when the active
// watchlist is DEFAULT_NAME, every asset qualifies; otherwise only the ones
// whose key was explicitly added to that named list.
export function resolveWatchlistAssets<T extends { symbol: string; src: string }>(
  allAssets: T[], activeName: string, namedLists: NamedWatchlist[]
): T[] {
  if (activeName === DEFAULT_NAME) return allAssets;
  const list = namedLists.find(l => l.name === activeName);
  if (!list) return allAssets; // named list was deleted or not found — fail open to "everything" rather than silently scanning nothing
  const keySet = new Set(list.symbolKeys);
  return allAssets.filter(a => keySet.has(`${a.symbol}|${a.src}`));
}
