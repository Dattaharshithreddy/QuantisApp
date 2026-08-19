import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef<any>();

/**
 * Navigate to a screen inside the MoreTab stack.
 *
 * The challenge: calling navigate('MoreTab', { screen }) while the user is
 * on a different tab works fine — React Navigation switches the tab AND
 * activates the target screen in one call. But calling navigate('MoreTab')
 * first and then navigate('MoreTab', { screen }) in a setTimeout is fragile:
 * the delay is arbitrary and fails on slow or fast devices.
 *
 * Correct approach:
 *   - If already on the target screen: do nothing.
 *   - If already on MoreTab (different screen): navigate directly to the screen.
 *   - If on a different tab: switch to MoreTab first, then listen for the
 *     navigation state change and push the screen once — no fixed delay.
 */
function navigateToMoreScreen(screenName: string) {
  if (!navigationRef.isReady()) return;

  const current = navigationRef.getCurrentRoute();
  if (current?.name === screenName) return;

  const rootState = navigationRef.getRootState();
  const moreTabRoute = rootState?.routes?.find((r: any) => r.name === 'MoreTab');
  const moreTabIndex = rootState?.routes?.indexOf(moreTabRoute);
  const alreadyOnMoreTab = moreTabRoute != null && rootState?.index === moreTabIndex;

  if (alreadyOnMoreTab) {
    // Already on MoreTab — push directly, no tab switch needed.
    navigationRef.navigate('MoreTab', { screen: screenName } as never);
  } else {
    // Switch to MoreTab. Fire once on the next state change (tab switch committed),
    // then push the screen. Unsubscribe immediately so it doesn't fire again.
    const unsubscribe = navigationRef.addListener('state', () => {
      unsubscribe();
      if (navigationRef.isReady()) {
        navigationRef.navigate('MoreTab', { screen: screenName } as never);
      }
    });
    navigationRef.navigate('MoreTab' as never);
  }
}

export function navigateToProductionEval() {
  navigateToMoreScreen('ProductionEval');
}

export function navigateToScanner() {
  if (!navigationRef.isReady()) return;
  const current = navigationRef.getCurrentRoute();
  if (current?.name === 'ScannerDashboard') return;
  // ScannerDashboard is in RootStack directly, not in MoreTab stack.
  navigationRef.navigate('ScannerDashboard' as never);
}

export function navigateToPaperTrading() {
  if (!navigationRef.isReady()) return;
  const current = navigationRef.getCurrentRoute();
  if (current?.name === 'PaperTrading') return;
  // PaperTrading is a modal in RootStack — single navigate call is sufficient.
  navigationRef.navigate('PaperTrading' as never);
}

export function navigateToShadowJournal() {
  navigateToMoreScreen('ShadowJournal');
}

export function navigateToLivePositions() {
  navigateToMoreScreen('LivePositions');
}
