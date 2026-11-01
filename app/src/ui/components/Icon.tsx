import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** Stroke icons from the FieldOps design, drawn on a 24×24 grid. */
const ICONS = {
  plus: [<Path key="a" d="M12 5v14M5 12h14" />],
  camera: [<Path key="a" d="M4 8h3l1.5-2h7L17 8h3v11H4z" />, <Circle key="b" cx="12" cy="13" r="3.5" />],
  cameraOff: [<Path key="a" d="M3 3l18 18M4 8h3l1.5-2h7L17 8h3v9M4 8v11h13" />, <Circle key="b" cx="12" cy="13" r="3.5" />],
  gallery: [<Rect key="a" x="3.5" y="4.5" width="17" height="15" rx="2.5" />, <Circle key="b" cx="9" cy="10" r="1.6" />, <Path key="c" d="M20 16l-5-5-8 8.5" />],
  trash: [<Path key="a" d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />],
  phone: [<Rect key="a" x="7" y="2.5" width="10" height="19" rx="2.5" />, <Path key="b" d="M11 18.5h2" />],
  clock: [<Circle key="a" cx="12" cy="12" r="9" />, <Path key="b" d="M12 7.5V12l3 2" />],
  upload: [<Path key="a" d="M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19h14" />],
  check: [<Path key="a" d="M5 12.5l4.5 4.5L19 7" />],
  warning: [<Path key="a" d="M12 4L21 19H3L12 4z" />, <Path key="b" d="M12 10v4M12 16.5v.5" />],
  noSignal: [<Path key="a" d="M3 3l18 18M8.5 14.5a5 5 0 017 0M5 11a10 10 0 014-2.5M15 8.5A10 10 0 0119 11M12 19h.01" />],
  signal: [<Path key="a" d="M8.5 14.5a5 5 0 017 0M5 11a10 10 0 0114 0M2 7.5a15 15 0 0120 0M12 19h.01" />],
  list: [<Path key="a" d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />],
  cloudCheck: [<Path key="a" d="M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0118 9.6 4.2 4.2 0 0117.6 18H7z" />, <Path key="b" d="M9.5 13.6l2 2 3.6-3.6" />],
  sliders: [<Path key="a" d="M4 7h9M17 7h3M4 17h3M11 17h9" />, <Circle key="b" cx="15" cy="7" r="2" />, <Circle key="c" cx="9" cy="17" r="2" />],
  chevronRight: [<Path key="a" d="M9 6l6 6-6 6" />],
  chevronLeft: [<Path key="a" d="M15 6l-6 6 6 6" />],
  close: [<Path key="a" d="M6 6l12 12M18 6L6 18" />],
  refresh: [<Path key="a" d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" />],
  copy: [<Rect key="a" x="8" y="8" width="12" height="12" rx="2" />, <Path key="b" d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" />],
  server: [<Rect key="a" x="4" y="4" width="16" height="7" rx="2" />, <Rect key="b" x="4" y="13" width="16" height="7" rx="2" />, <Path key="c" d="M8 7.5h.01M8 16.5h.01" />],
} as const;

export type IconName = keyof typeof ICONS;

const BOLD: readonly IconName[] = ['check', 'plus'];

export function Icon({ name, size = 20, color }: { name: IconName; size?: number; color: string }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={BOLD.includes(name) ? 2.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </Svg>
  );
}
