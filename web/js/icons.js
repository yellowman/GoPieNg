// Inline SVG icons: 16x16 viewBox, 1.5px stroke, currentColor (DESIGN_LANGUAGE.md §7.3)
const NS = 'http://www.w3.org/2000/svg'

const PATHS = {
  browse: 'M2.5 2.5h4v3h-4z M9.5 6h4v3h-4z M9.5 11h4v3h-4z M4.5 5.5v7h5 M4.5 7.5h5',
  activity: 'M1.5 8h3l2-5 3 10 2-5h3',
  users: 'M6 7.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5z M1.5 13.5c.6-2.3 2.3-3.5 4.5-3.5s3.9 1.2 4.5 3.5 M10.5 2.7a2.5 2.5 0 0 1 0 4.6 M12 10.3c1.2.5 2 1.6 2.5 3.2',
  user: 'M8 7.5a3 3 0 1 0 0-6a3 3 0 1 0 0 6z M2.5 14.5c.8-2.8 2.8-4.5 5.5-4.5s4.7 1.7 5.5 4.5',
  'chevron-left': 'M10 3.5 5.5 8l4.5 4.5',
  'chevron-right': 'M6 3.5 10.5 8 6 12.5',
  'chevron-up': 'M3.5 10 8 5.5l4.5 4.5',
  'chevron-down': 'M3.5 6 8 10.5 12.5 6',
  settings: 'M2 4.5h7 M12 4.5h2 M2 11.5h2 M7 11.5h7 M10.5 3v3 M5.5 10v3',
  list: 'M5.5 4h8 M5.5 8h8 M5.5 12h8 M2.5 4h.01 M2.5 8h.01 M2.5 12h.01',
  grid: 'M2.5 2.5h4.5v4.5h-4.5z M9 2.5h4.5v4.5h-4.5z M2.5 9h4.5v4.5h-4.5z M9 9h4.5v4.5h-4.5z',
  close: 'M4 4l8 8 M12 4l-8 8',
  moon: 'M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z',
  sun: 'M8 10.5a2.5 2.5 0 1 0 0-5a2.5 2.5 0 1 0 0 5z M8 1.5v1.5 M8 13v1.5 M1.5 8h1.5 M13 8h1.5 M3.4 3.4l1 1 M11.6 11.6l1 1 M3.4 12.6l1-1 M11.6 4.4l1-1',
  'sign-out': 'M6.5 2.5h-3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3 M10.5 11l3-3-3-3 M13.5 8h-7.5',
  menu: 'M2.5 4h11 M2.5 8h11 M2.5 12h11'
}

export function icon(name, size = 16){
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('class', 'icon icon-' + name)
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', PATHS[name] || '')
  svg.appendChild(path)
  return svg
}

// Replace <span data-icon="name"> placeholders (used in index.html)
export function hydrateIcons(root = document){
  for (const ph of root.querySelectorAll('[data-icon]')) {
    ph.replaceWith(icon(ph.dataset.icon, Number(ph.dataset.size) || 16))
  }
}
