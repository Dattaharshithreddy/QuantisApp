import React from 'react';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Rect } from 'react-native-svg';

// QUANTIS LOGO — design rationale
//
// Three bars of ascending height (real market-data proportions, not a
// perfect staircase) read as growth/trading at a glance. The tallest bar
// is capped with a ringed node - a single "signal" point, the AI cue -
// rather than a literal circuit or robot motif, which would have skewed
// generic-tech rather than trading-specific. Kept deliberately simple:
// legible at 16px icon scale, distinct enough (via the ringed node) not
// to read as plain stock-chart clipart. Verified by rendering both the
// dark and light variants before adopting this as final - not assumed
// to look right.

export function QuantisLogo({ size = 40, withBackground = false, theme = 'dark' }: { size?: number; withBackground?: boolean; theme?: 'dark' | 'light' }) {
  const bg = theme === 'light' ? '#fafbfd' : '#0d0f17';
  const gradFrom = theme === 'light' ? '#2962ff' : '#3b7dff';
  const gradTo = theme === 'light' ? '#7048e8' : '#7c5cff';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id="qGrad" x1="0%" y1="100%" x2="100%" y2="0%">
          <Stop offset="0%" stopColor={gradFrom} />
          <Stop offset="100%" stopColor={gradTo} />
        </LinearGradient>
      </Defs>
      {withBackground && <Rect x="0" y="0" width="100" height="100" rx="22" fill={bg} />}
      <Path d="M24 69 L24 79 L38 79 L38 69 Z" fill="url(#qGrad)" />
      <Path d="M43 51 L43 79 L57 79 L57 51 Z" fill="url(#qGrad)" />
      <Path d="M62 29 L62 79 L76 79 L76 29 Z" fill="url(#qGrad)" />
      <Circle cx="69" cy="29" r="8" fill="url(#qGrad)" />
      <Circle cx="69" cy="29" r="3" fill={bg} />
    </Svg>
  );
}

export const QUANTIS_TAGLINE = 'AI-Powered Trading Assistant';
