// ─────────────────────────────────────────────────────────────────────────────
// DeveloperSupportScreen  (v1.0.0)
//
// Hidden developer screen. Access via: Health Dashboard → long-press title (3s).
// Generates a sanitised support bundle and provides Copy + Share actions.
// Never exposed in MoreMenu — only accessible to developers.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator,
  Clipboard, Share, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { generateSupportBundle, formatBundleAsString, SupportBundle } from '../utils/supportBundle';
import { SPACING } from '../theme/colors';

function SectionHeader({ title, T }: { title: string; T: any }) {
  return (
    <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800',
      letterSpacing: 1, marginTop: 16, marginBottom: 6 }}>
      {title}
    </Text>
  );
}

function StatRow({ label, value, color, T }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between',
      paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: T.border + '30' }}>
      <Text style={{ color: T.textDim, fontSize: 10, flex: 1 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 10, fontWeight: '600',
        flexShrink: 0, maxWidth: '55%', textAlign: 'right' }} numberOfLines={2}>
        {String(value)}
      </Text>
    </View>
  );
}

export default function DeveloperSupportScreen({ navigation }: any) {
  const { theme: T }  = useTheme();
  const [bundle,     setBundle]     = useState<SupportBundle | null>(null);
  const [generating, setGenerating] = useState(false);
  const [bundleStr,  setBundleStr]  = useState<string>('');

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const b   = await generateSupportBundle();
      const str = formatBundleAsString(b);
      setBundle(b);
      setBundleStr(str);
    } catch (e: any) {
      Alert.alert('Error', `Failed to generate bundle: ${e.message}`);
    } finally {
      setGenerating(false);
    }
  }, []);

  const handleCopy = useCallback(() => {
    if (!bundleStr) return;
    Clipboard.setString(bundleStr);
    Alert.alert('Copied', 'Support bundle copied to clipboard.');
  }, [bundleStr]);

  const handleShare = useCallback(async () => {
    if (!bundleStr) return;
    try {
      await Share.share({
        title:   `QUANTIS Support Bundle v${bundle?.build?.buildVersion ?? '?'}`,
        message: bundleStr});
    } catch (e: any) {
      Alert.alert('Share failed', e.message);
    }
  }, [bundleStr, bundle]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 50 }}>

        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 4 }}>
          <Text style={{ color: T.text, fontSize: 20, fontWeight: '800' }}>
            Developer Support
          </Text>
          <View style={{ backgroundColor: T.red + '20', borderRadius: 4,
            paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: T.red }}>
            <Text style={{ color: T.red, fontSize: 8, fontWeight: '800' }}>DEV ONLY</Text>
          </View>
        </View>
        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 20, lineHeight: 15 }}>
          Generates a sanitised diagnostic package. No API keys, tokens, or secrets
          are ever included. Safe to share with the development team.
        </Text>

        {/* Generate button */}
        <TouchableOpacity onPress={handleGenerate} disabled={generating}
          style={{ backgroundColor: T.accent, borderRadius: 8, padding: 14,
            alignItems: 'center', marginBottom: 12,
            opacity: generating ? 0.7 : 1 }}>
          {generating
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
                {bundle ? '↺ Regenerate Support Bundle' : '⬇ Generate Support Bundle'}
              </Text>
          }
        </TouchableOpacity>

        {/* Action buttons */}
        {bundle && (
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
            <TouchableOpacity onPress={handleCopy}
              style={{ flex: 1, backgroundColor: T.bg3, borderRadius: 8, padding: 12,
                alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 11 }}>
                📋 Copy JSON
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleShare}
              style={{ flex: 1, backgroundColor: T.bg3, borderRadius: 8, padding: 12,
                alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 11 }}>
                ↑ Share
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Bundle preview */}
        {bundle && (
          <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
            borderWidth: 1, borderColor: T.border }}>

            <SectionHeader title="BUILD" T={T} />
            <StatRow label="Version"    value={bundle.build?.buildVersion}  T={T} />
            <StatRow label="Date"       value={bundle.build?.buildDate}     T={T} />
            <StatRow label="Platform"   value={`${bundle.build?.platform} ${bundle.build?.platformVersion}`} T={T} />

            <SectionHeader title="CRASHES" T={T} />
            <StatRow label="Total Crashes" value={bundle.crashes?.totalCrashes ?? 0}
              color={(bundle.crashes as any)?.totalCrashes > 0 ? T.red : T.green} T={T} />
            <StatRow label="Last Crash"    value={bundle.crashes?.lastCrashAt ?? 'None'} T={T} />
            <StatRow label="Last Screen"   value={bundle.crashes?.lastCrashScreen ?? '—'} T={T} />

            <SectionHeader title="PERFORMANCE (p95 latency)" T={T} />
            {Array.isArray(bundle.performance) && bundle.performance.map((s: any) => (
              <StatRow key={s.label} label={s.label} T={T}
                value={s.p95Ms ? `${s.p95Ms}ms p95 (${s.count} samples)` : '—'}
                color={s.p95Ms > 2000 ? T.amber : T.text} />
            ))}

            <SectionHeader title="SECURITY AUDIT" T={T} />
            <StatRow label="All Passed"  value={bundle.security?.allPassed ? '✓ Yes' : '✗ No'}
              color={bundle.security?.allPassed ? T.green : T.red} T={T} />
            {(bundle.security as any)?.findings?.filter((f: any) => !f.passed).map((f: any) => (
              <StatRow key={f.id} label={f.title} value="FAILED" color={T.red} T={T} />
            ))}

            <SectionHeader title="ORDER AUDIT TRAIL" T={T} />
            <StatRow label="Total Orders" value={(bundle.auditTrail as any)?.totalOrders ?? 0} T={T} />
            {(bundle.auditTrail as any)?.byState && Object.entries((bundle.auditTrail as any).byState).map(([k, v]: any) => (
              <StatRow key={k} label={k} value={v} T={T} />
            ))}

            <SectionHeader title="RECONCILIATION" T={T} />
            <StatRow label="Total Runs"  value={(bundle.reconciliation as any)?.totalRuns ?? 0} T={T} />
            <StatRow label="Last Run"    value={(bundle.reconciliation as any)?.lastRunAt ?? 'Never'} T={T} />
            <StatRow label="Last 10 Clean" value={(bundle.reconciliation as any)?.last10Clean ? '✓ Yes' : '✗ No'}
              color={(bundle.reconciliation as any)?.last10Clean ? T.green : T.amber} T={T} />

            <SectionHeader title="PORTFOLIO RISK" T={T} />
            <StatRow label="Risk Level"   value={(bundle.portfolioRisk as any)?.riskLevel ?? '—'}
              color={(bundle.portfolioRisk as any)?.riskLevel === 'VERY_HIGH' ? T.red :
                (bundle.portfolioRisk as any)?.riskLevel === 'HIGH' ? T.amber : T.green} T={T} />
            <StatRow label="Open Positions" value={(bundle.portfolioRisk as any)?.openPositionCount ?? 0} T={T} />
            <StatRow label="Leverage"     value={`${((bundle.portfolioRisk as any)?.overallLeverage ?? 0).toFixed(1)}×`} T={T} />

            <SectionHeader title="RECENT LOGS" T={T} />
            {bundle.recentLogs?.slice(0, 8).map((e: any, i: number) => (
              <View key={i} style={{ paddingVertical: 3 }}>
                <Text style={{ color: e.level === 'error' ? T.red : e.level === 'warn' ? T.amber : T.textDim,
                  fontSize: 8, fontFamily: 'monospace' }} numberOfLines={2}>
                  [{e.time?.slice(11, 19)}] [{e.tag}] {e.message}
                </Text>
              </View>
            ))}

            {/* Bundle size */}
            <View style={{ borderTopWidth: 0.5, borderTopColor: T.border,
              marginTop: 14, paddingTop: 10 }}>
              <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center' }}>
                Bundle size: {(bundleStr.length / 1024).toFixed(1)} KB
                {' · '}Generated: {bundle.generatedAt?.slice(11, 19)} UTC
              </Text>
            </View>
          </View>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}
