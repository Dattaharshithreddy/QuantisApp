// Premium design tokens, shared by both themes - radius scale, elevation
// (RN shadow + Android elevation together, since RN has no CSS box-shadow),
// and a type scale. Purely additive: existing per-theme color fields below
// are untouched, so no existing screen's styling changes unless it
// explicitly opts into these new tokens.
export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };
export const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const TYPE = {
  display: { fontSize: 32, fontWeight: '800' as const, letterSpacing: -0.5 },
  h1: { fontSize: 24, fontWeight: '800' as const, letterSpacing: -0.3 },
  h2: { fontSize: 18, fontWeight: '700' as const, letterSpacing: -0.2 },
  body: { fontSize: 14, fontWeight: '500' as const },
  caption: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.3 },
  label: { fontSize: 10, fontWeight: '700' as const, letterSpacing: 1.2 },
};
function elevation(level: 1 | 2 | 3, shadowColor: string) {
  const map = {
    1: { shadowOpacity: 0.10, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
    2: { shadowOpacity: 0.14, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 5 },
    3: { shadowOpacity: 0.20, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 10 },
  };
  return { shadowColor, ...map[level] };
}

export const THEMES = {
  dark: {
    bg0: '#0d0f17', bg1: '#1a1d29', bg2: '#161922', bg3: '#252938',
    border: '#252938', border2: '#363c4e',
    text: '#e8eaf0', textSub: '#8b8fa3', textDim: '#565c70',
    green: '#26d0ab', red: '#ff5d6c', amber: '#ffb547',
    blue: '#3b7dff', purple: '#a855f7', teal: '#14c8d4', orange: '#ff7849',
    accent: '#3b7dff', accentDk: '#2a5fd9',
    accentGradient: ['#3b7dff', '#7c5cff'] as [string, string],
    upBody: '#26d0ab', dnBody: '#ff5d6c',
    volUp: 'rgba(38,208,171,0.35)', volDn: 'rgba(255,93,108,0.35)',
    grid: 'rgba(255,255,255,0.06)',
    ma: ['#3b7dff', '#ffb547', '#a855f7'],
    card: '#161922', cardBorder: '#252938',
    statusBar: 'light',
    shadowColor: '#000000',
    elev1: elevation(1, '#000000'), elev2: elevation(2, '#000000'), elev3: elevation(3, '#000000'),
  },
  light: {
    bg0: '#fafbfd', bg1: '#f2f4f9', bg2: '#ffffff', bg3: '#eaedf4',
    border: '#e6e9f0', border2: '#d6dae5',
    text: '#10131c', textSub: '#6b7184', textDim: '#a8adbd',
    green: '#089981', red: '#f23645', amber: '#ef8c00',
    blue: '#2962ff', purple: '#7b1fa2', teal: '#0097a7', orange: '#ff6b35',
    accent: '#2962ff', accentDk: '#1e53d0',
    accentGradient: ['#2962ff', '#7048e8'] as [string, string],
    upBody: '#089981', dnBody: '#f23645',
    volUp: 'rgba(8,153,129,0.25)', volDn: 'rgba(242,54,69,0.25)',
    grid: 'rgba(0,0,0,0.06)',
    ma: ['#2962ff', '#ff9800', '#9c27b0'],
    card: '#ffffff', cardBorder: '#eceff5',
    statusBar: 'dark',
    shadowColor: '#1a1d29',
    elev1: elevation(1, '#1a1d29'), elev2: elevation(2, '#1a1d29'), elev3: elevation(3, '#1a1d29'),
  },
};

export type Theme = typeof THEMES.dark;
