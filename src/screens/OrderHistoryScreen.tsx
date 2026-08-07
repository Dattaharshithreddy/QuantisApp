// OrderHistoryScreen — every real order placed, with status and P&L
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../context/ThemeContext';
import { SPACING } from '../theme/colors';

export type OrderRecord = {
  orderId:       string;
  broker:        'ANGEL_ONE' | 'BINANCE';
  symbol:        string;
  direction:     'LONG' | 'SHORT';
  qty:           number;
  filledPrice:   number;
  totalValue:    number;
  fees:          number;
  status:        'FILLED' | 'CANCELLED' | 'REJECTED';
  placedAt:      number;
  filledAt?:     number;
  pnl?:          number;   // populated when position is closed
  closePrice?:   number;
};

const KEY = 'liveOrderHistory_v1';
const MAX = 500;

export async function appendOrderRecord(record: OrderRecord): Promise<void> {
  try {
    const raw  = await AsyncStorage.getItem(KEY);
    const list: OrderRecord[] = raw ? JSON.parse(raw) : [];
    list.unshift(record);
    if (list.length > MAX) list.splice(MAX);
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* non-fatal */ }
}

export async function getOrderHistory(): Promise<OrderRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function OrderCard({ order, T }: { order: OrderRecord; T: any }) {
  const isLong  = order.direction === 'LONG';
  const date    = new Date(order.placedAt);
  const dateStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;

  return (
    <View style={{ backgroundColor: T.card, borderRadius: 8, padding: 12, marginBottom: 8,
      borderWidth: 1, borderColor: T.border, borderLeftWidth: 3,
      borderLeftColor: order.status === 'FILLED' ? (isLong ? T.green : T.red) : T.textDim }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>{order.symbol}</Text>
        <View style={{ backgroundColor: order.status === 'FILLED' ? T.green + '20' : T.textDim + '20',
          borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
          <Text style={{ color: order.status === 'FILLED' ? T.green : T.textDim, fontSize: 8, fontWeight: '700' }}>
            {order.status}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: isLong ? T.green : T.red, fontSize: 10, fontWeight: '600' }}>
          {isLong ? '▲ BUY' : '▼ SELL'} · {order.qty} units @ {order.filledPrice.toFixed(2)}
        </Text>
        {order.pnl != null && (
          <Text style={{ color: order.pnl >= 0 ? T.green : T.red, fontSize: 10, fontWeight: '700' }}>
            {order.pnl >= 0 ? '+' : ''}{order.pnl.toFixed(2)}
          </Text>
        )}
      </View>
      <Text style={{ color: T.textDim, fontSize: 8, marginTop: 4 }}>
        {order.broker} · {dateStr} · ID: {order.orderId}
      </Text>
    </View>
  );
}

export default function OrderHistoryScreen() {
  const { theme: T } = useTheme();
  const [orders,  setOrders]  = useState<OrderRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const o = await getOrderHistory();
    setOrders(o);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalPnL   = orders.filter(o => o.pnl != null).reduce((s,o) => s + (o.pnl ?? 0), 0);
  const filledCount = orders.filter(o => o.status === 'FILLED').length;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}
>

        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 16 }}>Order History</Text>

        {orders.length > 0 && (
          <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
            borderWidth: 1, borderColor: T.border, marginBottom: 16, flexDirection: 'row', justifyContent: 'space-around' }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9 }}>TOTAL ORDERS</Text>
              <Text style={{ color: T.text, fontSize: 18, fontWeight: '800' }}>{orders.length}</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9 }}>FILLED</Text>
              <Text style={{ color: T.green, fontSize: 18, fontWeight: '800' }}>{filledCount}</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9 }}>REALISED P&L</Text>
              <Text style={{ color: totalPnL >= 0 ? T.green : T.red, fontSize: 18, fontWeight: '800' }}>
                {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(2)}
              </Text>
            </View>
          </View>
        )}

        {!loading && orders.length === 0 && (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <Text style={{ color: T.textDim, fontSize: 14 }}>No order history yet</Text>
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 4 }}>
              Real orders placed in LIVE mode appear here.
            </Text>
          </View>
        )}

        {orders.map(o => <OrderCard key={o.orderId + o.placedAt} order={o} T={T} />)}
      </ScrollView>
    </SafeAreaView>
  );
}
