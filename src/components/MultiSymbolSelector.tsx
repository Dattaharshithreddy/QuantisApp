import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { Asset } from '../api/assets';
import { Theme } from '../theme/colors';
import { Pill } from './Common';

// TASK 9 (Single Master Symbol Source) — this component takes allAssets
// (from useData(), the same source Markets/Chart/Scanner/everything else
// already reads from) as its ONLY symbol source. It never maintains its
// own list. When a symbol is added via "+ Add Symbol" elsewhere in the
// app, allAssets updates and this component sees it on the next render —
// nothing here needs to change for that to work.

const ASSET_CLASSES: { key: Asset['type'] | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'INDEX', label: 'Index' },
  { key: 'STOCK', label: 'Stocks' },
  { key: 'CRYPTO', label: 'Crypto' },
  { key: 'FOREX', label: 'Forex' },
  { key: 'COMMODITY', label: 'Commodities' },
];

export function MultiSymbolSelector({
  allAssets, selected, onChange, theme: T,
}: {
  allAssets: Asset[]; selected: string[]; onChange: (symbols: string[]) => void; theme: Theme;
}) {
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState<Asset['type'] | 'ALL'>('ALL');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allAssets.filter(a =>
      (classFilter === 'ALL' || a.type === classFilter) &&
      (q === '' || a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
    );
  }, [allAssets, search, classFilter]);

  const allFilteredSelected = filtered.length > 0 && filtered.every(a => selected.includes(a.symbol));

  function toggle(symbol: string) {
    onChange(selected.includes(symbol) ? selected.filter(s => s !== symbol) : [...selected, symbol]);
  }

  // Select All / Clear All deliberately operate on the CURRENTLY FILTERED
  // set, not the global symbol list — this is what makes "filter by Crypto,
  // then Select All" mean "select every crypto symbol," matching the
  // explicit "Entire crypto" / "Entire stocks" use case directly, rather
  // than requiring a separate, redundant control for it.
  function selectAllFiltered() {
    const filteredSymbols = new Set(filtered.map(a => a.symbol));
    onChange([...new Set([...selected, ...filteredSymbols])]);
  }
  function clearAllFiltered() {
    const filteredSymbols = new Set(filtered.map(a => a.symbol));
    onChange(selected.filter(s => !filteredSymbols.has(s)));
  }

  return (
    <View>
      <TextInput
        value={search} onChangeText={setSearch} placeholder="Search symbol or name…" placeholderTextColor={T.textDim}
        style={{ backgroundColor: T.bg3, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10, color: T.text, fontSize: 13, marginBottom: 10 }}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {ASSET_CLASSES.map(c => (
            <Pill key={c.key} label={c.label} color={T.blue} active={classFilter === c.key} onPress={() => setClassFilter(c.key)} />
          ))}
        </View>
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
        <TouchableOpacity onPress={allFilteredSelected ? clearAllFiltered : selectAllFiltered} style={{ backgroundColor: T.bg3, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ color: T.blue, fontSize: 11, fontWeight: '700' }}>{allFilteredSelected ? `Clear ${filtered.length} shown` : `Select all ${filtered.length} shown`}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onChange([])} style={{ backgroundColor: T.bg3, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ color: T.red, fontSize: 11, fontWeight: '700' }}>Clear all ({selected.length})</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 10, textAlign: 'right' }}>{selected.length} selected</Text>
        </View>
      </View>

      {filtered.length === 0 ? (
        <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', paddingVertical: 20 }}>No symbols match "{search}".</Text>
      ) : (
        <ScrollView style={{ maxHeight: 280 }}>
          {filtered.map(a => {
            const isSelected = selected.includes(a.symbol);
            return (
              <TouchableOpacity key={a.symbol + a.src} onPress={() => toggle(a.symbol)} style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, marginBottom: 4,
                backgroundColor: isSelected ? T.blue + '18' : 'transparent',
                borderWidth: 1, borderColor: isSelected ? T.blue + '50' : T.border,
              }}>
                <View>
                  <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>{a.symbol}</Text>
                  <Text style={{ color: T.textDim, fontSize: 10 }}>{a.name} · {a.type}</Text>
                </View>
                <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: isSelected ? T.blue : T.border, backgroundColor: isSelected ? T.blue : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {isSelected && <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>✓</Text>}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}
