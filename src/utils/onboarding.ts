// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING STATE MANAGER  (v1.0.0)
//
// Single source of truth for all onboarding persistence.
// Every AsyncStorage access is wrapped in try/catch.
//
// Keys:
//   onboarding_completed_v1   — boolean: has user completed or skipped
//   onboarding_experience_v1  — string:  selected experience (Screen 2)
//   onboarding_tooltips_v1    — JSON:    Set of dismissed tooltip IDs
// ─────────────────────────────────────────────────────────────────────────────

import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';

const KEY_COMPLETED  = 'onboarding_completed_v1';
const KEY_EXPERIENCE = 'onboarding_experience_v1';
const KEY_TOOLTIPS   = 'onboarding_tooltips_v1';

export type OnboardingExperience =
  | 'learn'
  | 'paper'
  | 'live'
  | 'futures'
  | 'analytics';

// ── Completion state ──────────────────────────────────────────────────────────

export async function isOnboardingComplete(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY_COMPLETED);
    return v === 'true';
  } catch (e: any) {
    logger.warn('onboarding', `isOnboardingComplete read failed: ${e.message}`);
    return false; // fail open — show onboarding rather than skip it
  }
}

export async function markOnboardingComplete(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_COMPLETED, 'true');
    logger.info('onboarding', 'Onboarding marked complete');
  } catch (e: any) {
    logger.warn('onboarding', `markOnboardingComplete failed: ${e.message}`);
  }
}

export async function resetOnboarding(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([KEY_COMPLETED, KEY_EXPERIENCE, KEY_TOOLTIPS]);
    logger.info('onboarding', 'Onboarding reset');
  } catch (e: any) {
    logger.warn('onboarding', `resetOnboarding failed: ${e.message}`);
  }
}

// ── Experience preference ─────────────────────────────────────────────────────

export async function saveExperience(exp: OnboardingExperience): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_EXPERIENCE, exp);
  } catch (e: any) {
    logger.warn('onboarding', `saveExperience failed: ${e.message}`);
  }
}

export async function getExperience(): Promise<OnboardingExperience | null> {
  try {
    const v = await AsyncStorage.getItem(KEY_EXPERIENCE);
    return v as OnboardingExperience | null;
  } catch { return null; }
}

// ── Tooltip dismissed state ────────────────────────────────────────────────────

export async function isTooltipDismissed(id: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEY_TOOLTIPS);
    const set: string[] = raw ? JSON.parse(raw) : [];
    return set.includes(id);
  } catch { return false; }
}

export async function dismissTooltip(id: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY_TOOLTIPS);
    const set: string[] = raw ? JSON.parse(raw) : [];
    if (!set.includes(id)) {
      set.push(id);
      await AsyncStorage.setItem(KEY_TOOLTIPS, JSON.stringify(set));
    }
  } catch (e: any) {
    logger.warn('onboarding', `dismissTooltip failed: ${e.message}`);
  }
}

export async function getDismissedTooltips(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_TOOLTIPS);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export const TOOLTIP_IDS = {
  PREDICTION_CARD:     'tip_prediction_card',
  LIVE_TRADE_TOGGLE:   'tip_live_trade_toggle',
  PORTFOLIO_RISK:      'tip_portfolio_risk',
  TRADING_COACH:       'tip_trading_coach',
  HEALTH_DASHBOARD:    'tip_health_dashboard',
  PERFORMANCE:         'tip_performance_dash',
  AUDIT_TRAIL:         'tip_audit_trail',
  SHADOW_JOURNAL:      'tip_shadow_journal',
  GATE_ANALYTICS:      'tip_gate_analytics',
  FUTURES_LEVERAGE:    'tip_futures_leverage',
} as const;

export type TooltipId = typeof TOOLTIP_IDS[keyof typeof TOOLTIP_IDS];
