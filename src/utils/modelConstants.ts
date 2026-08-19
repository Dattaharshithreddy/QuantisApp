// Shared model constants — avoids circular import between mlSignal.ts and modelRegistry.ts
// v6.0.0: bumped architecture version for context feature addition (116 → 129 features)
// Old saved weights (W1[0].length === 116) are automatically rejected by loadSavedMLP
// and a clean retrain is triggered. This is intentional and correct.
export const ARCHITECTURE_VERSION = 2;  // was 1; bump here triggers retrain of all saved models
export const FEATURE_COUNT = 129;       // 116 base + 8 context + 5 calendar
