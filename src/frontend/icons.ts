/**
 * The eight icons the Vela design uses, as inline SVG.
 *
 * The design canvas pulls these from the Lucide CDN at runtime
 * (`<script src="https://unpkg.com/lucide@latest">`). They are inlined here
 * instead so the Frontend keeps its no-dependency, no-network-at-load
 * posture: the app is served entirely by its own Express process, and a CDN
 * that is unreachable would otherwise leave every action button blank.
 *
 * Each path set is drawn on Lucide's 24x24 grid; stroke width, caps, joins,
 * and `fill: none` come from the `.icon` rule in `public/styles.css`, so an
 * icon inherits `currentColor` from whatever control contains it.
 */

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** The `d` attribute of every `<path>` making up each icon. */
const ICON_PATHS = {
  plus: ['M5 12h14', 'M12 5v14'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  'refresh-cw': [
    'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
    'M21 3v5h-5',
    'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
    'M8 16H3v5',
  ],
  pencil: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ],
  'trash-2': [
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ],
  'arrow-left-right': ['M8 3 4 7l4 4', 'M4 7h16', 'm16 21 4-4-4-4', 'M20 17H4'],
  search: ['M21 21l-4.34-4.34', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z'],
} as const;

/** The name of every icon {@link createIcon} can build. */
export type IconName = keyof typeof ICON_PATHS;

/**
 * Builds one icon as an `<svg>` element, sized `size` x `size` and hidden from
 * assistive technology — every control that uses an icon carries its own text
 * or `aria-label`, so announcing the glyph as well would be redundant.
 */
export function createIcon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const definition of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', definition);
    svg.appendChild(path);
  }

  return svg;
}
