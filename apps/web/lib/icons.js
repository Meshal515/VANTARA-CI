/**
 * أيقونات خطية.
 *
 * ليست تجميلًا: الرموز التعبيرية (🔔 🔒) تُرسم ملوّنة من خط النظام، فيظهر جرس
 * أصفر ساطع وقفل ذهبي في واجهة سوداء وبنفسجية. كما أن شكلها يتغيّر بين
 * أندرويد وiOS والمتصفح، فلا يمكن ضبط تصميم عليها.
 *
 * هذه ترث `currentColor` وسماكتها واحدة، فتبدو من النظام نفسه.
 */

const SVG = 'http://www.w3.org/2000/svg';

const PATHS = {
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  back: ['M5 12h14', 'M12 5l7 7-7 7'],
  bell: ['M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8', 'M13.7 21a2 2 0 0 1-3.4 0'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V21h14V9.5'],
  library: ['M4 4h7v16H4z', 'M13 4h7v16h-7z'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  share: ['M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7', 'M12 16V3', 'M7.5 7.5 12 3l4.5 4.5'],
};

/**
 * @param {keyof typeof PATHS} name
 * @param {number} size
 */
export function icon(name, size = 22) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
