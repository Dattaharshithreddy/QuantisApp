import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from 'services/storage';
import { Asset, ASSETS } from '../api/assets';

const KEY = 'customWatchlist';

export async function getCustomAssets(): Promise<Asset[]> {
  const raw = await KVStore.get(KEY);
  try { return raw ? JSON.parse(raw) : []; } catch (e: any) { console.warn("[watchlist] Corrupt watchlist data in AsyncStorage — returning empty list.", e?.message); return []; }
}

export async function addCustomAsset(asset: Asset): Promise<Asset[]> {
  const list = await getCustomAssets();
  if (list.some(a => a.symbol === asset.symbol && a.src === asset.src)) return list; // already added as a custom asset
  if (ASSETS.some(a => a.symbol === asset.symbol && a.src === asset.src)) return list; // already exists as a built-in - adding it again would create a duplicate row
  const updated = [...list, { ...asset, custom: true }];
  await KVStore.set(KEY, JSON.stringify(updated));
  return updated;
}

export async function removeCustomAsset(symbol: string, src: string): Promise<Asset[]> {
  const list = await getCustomAssets();
  const updated = list.filter(a => !(a.symbol === symbol && a.src === src));
  await KVStore.set(KEY, JSON.stringify(updated));
  return updated;
}

// ─────────────────────────────────────────────────
// HIDING BUILT-IN ASSETS
// ─────────────────────────────────────────────────
// Built-in assets (the original ~28 in ASSETS) can't be "deleted" since
// they're hardcoded in code, not stored data — but the user should still be
// able to remove them from view. This stores a hidden-list separately so
// allAssets can filter them out, same end result as deleting.
const HIDDEN_KEY = 'hiddenBuiltinAssets';

export async function getHiddenBuiltins(): Promise<string[]> {
  const raw = await KVStore.get(HIDDEN_KEY);
  try { return raw ? JSON.parse(raw) : []; } catch (e: any) { console.warn("[watchlist] Corrupt watchlist data in AsyncStorage — returning empty list.", e?.message); return []; }
}

export async function hideBuiltinAsset(symbol: string, src: string): Promise<string[]> {
  const list = await getHiddenBuiltins();
  const key = symbol + '|' + src;
  if (list.includes(key)) return list;
  const updated = [...list, key];
  await KVStore.set(HIDDEN_KEY, JSON.stringify(updated));
  return updated;
}

export async function restoreAllBuiltins(): Promise<string[]> {
  await KVStore.set(HIDDEN_KEY, JSON.stringify([]));
  return [];
}
