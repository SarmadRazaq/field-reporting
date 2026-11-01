import type { TextStyle } from 'react-native';

/** FieldOps v4 tokens. Colour means state: see the comments, and never use green for anything but "Sent". */
export const color = {
  bg: '#F5F7FA',
  bg2: '#EEF1F6',
  white: '#FFFFFF',
  line: '#E2E7EF',
  line2: '#CBD3DF',
  ink: '#111827',
  ink7: '#2B3445',
  soft: '#4B5563',
  muted: '#5B6474',
  /** Brand and the next action. Never a status. */
  brand: '#1D4ED8',
  brandHero: '#1E3A8A',
  brand700: '#1E3A8A',
  brand100: '#E8EEFF',
  onHeroSoft: '#C7D2FE',
  /** The server confirmed it. Nothing else is green. */
  green: '#287030',
  green700: '#1B5E20',
  green100: '#E8F5E9',
  /** Busy or warning. */
  amber: '#FFB020',
  amber700: '#8A5A00',
  amber100: '#FFF1D6',
  amberLine: '#F5D9A0',
  /** Refused by the server, or something will be deleted. */
  red700: '#B42318',
  red100: '#FDECEA',
  redLine: '#F3B8B0',
} as const;

export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 } as const;
export const radius = { sm: 8, md: 14, lg: 20, sheet: 24 } as const;
export const size = { touch: 48, button: 56, cell: 14, cellGap: 3, chip: 28 } as const;

/** Android loads each weight as its own file; the family name is the file name. */
const sans = {
  400: 'Geist-Regular',
  500: 'Geist-Medium',
  600: 'Geist-SemiBold',
  700: 'Geist-Bold',
} as const;
const mono = { 400: 'GeistMono-Regular', 600: 'GeistMono-SemiBold' } as const;

export const type = {
  display: { fontFamily: sans[700], fontSize: 44, lineHeight: 48, letterSpacing: -1.2 },
  h1: { fontFamily: sans[700], fontSize: 30, lineHeight: 36, letterSpacing: -0.6 },
  h2: { fontFamily: sans[700], fontSize: 24, lineHeight: 30, letterSpacing: -0.4 },
  heroTitle: { fontFamily: sans[700], fontSize: 20, lineHeight: 26 },
  title: { fontFamily: sans[600], fontSize: 16, lineHeight: 22 },
  body: { fontFamily: sans[400], fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: sans[600], fontSize: 15, lineHeight: 22 },
  input: { fontFamily: sans[400], fontSize: 16, lineHeight: 22 },
  small: { fontFamily: sans[400], fontSize: 14, lineHeight: 20 },
  chip: { fontFamily: sans[500], fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: sans[400], fontSize: 13, lineHeight: 18 },
  tab: { fontFamily: sans[600], fontSize: 12, lineHeight: 16 },
  button: { fontFamily: sans[600], fontSize: 17, lineHeight: 24 },
  buttonSmall: { fontFamily: sans[600], fontSize: 15, lineHeight: 22 },
  figure: { fontFamily: mono[600], fontSize: 56, lineHeight: 60, letterSpacing: -2 },
  figureSmall: { fontFamily: mono[600], fontSize: 26, lineHeight: 32 },
  time: { fontFamily: mono[600], fontSize: 14, lineHeight: 20 },
  meta: { fontFamily: mono[400], fontSize: 12, lineHeight: 16 },
  metaStrong: { fontFamily: mono[600], fontSize: 12, lineHeight: 16 },
} satisfies Record<string, TextStyle>;
