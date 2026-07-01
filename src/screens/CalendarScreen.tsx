import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, Pill } from '../components/Common';
import { getUpcomingEvents, daysUntil, CalendarEvent } from '../utils/economicCalendar';

const CAT_ICON: Record<CalendarEvent['category'], string> = {
  RATES: '🏦', INFLATION: '📈', JOBS: '👷', EARNINGS: '💼', GEOPOLITICAL: '🌍',
};
const REGION_LABEL: Record<CalendarEvent['region'], string> = { IN: '🇮🇳 India', US: '🇺🇸 US', GLOBAL: '🌐 Global' };

export default function CalendarScreen() {
  const { theme: T } = useTheme();
  const events = getUpcomingEvents();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Economic Calendar</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>Upcoming events that move markets — plan around volatility</Text>

        {events.map(ev => {
          const days = daysUntil(ev.date);
          const isSoon = days <= 3;
          return (
            <Card key={ev.id} theme={T} style={{ marginBottom: 10, borderColor: isSoon ? T.amber + '60' : T.cardBorder }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <Text style={{ fontSize: 16 }}>{CAT_ICON[ev.category]}</Text>
                    <Text style={{ color: T.text, fontWeight: '700', fontSize: 13, flex: 1 }}>{ev.title}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                    <Pill label={REGION_LABEL[ev.region]} color={T.teal} active />
                    <Pill label={ev.importance} color={ev.importance === 'HIGH' ? T.red : T.amber} active />
                  </View>
                  <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 16 }}>{ev.note}</Text>
                </View>
                <View style={{ alignItems: 'center', minWidth: 56 }}>
                  <Text style={{ color: isSoon ? T.amber : T.textDim, fontSize: 20, fontWeight: '800' }}>{days}</Text>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>days</Text>
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4 }}>{ev.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</Text>
                </View>
              </View>
            </Card>
          );
        })}

        <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8, lineHeight: 14, textAlign: 'center' }}>
          Dates are computed estimates based on standard release cadences — always confirm exact times closer to the date via RBI/Fed official calendars.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
