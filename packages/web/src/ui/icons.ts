const NS = 'http://www.w3.org/2000/svg';

function svg(viewBox: string, html: string, cls = ''): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  if (cls) el.classList.add(cls);
  el.innerHTML = html;
  return el;
}

export function iconHome(): SVGSVGElement {
  return svg('0 0 24 24', '<path d="M3 12L12 3l9 9"/><path d="M5 10v9a1 1 0 001 1h4v-5h4v5h4a1 1 0 001-1v-9"/>');
}

export function iconSettings(): SVGSVGElement {
  return svg('0 0 24 24', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>');
}

export function iconMic(): SVGSVGElement {
  return svg('0 0 24 24', '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0"/><path d="M12 17v4"/><path d="M8 21h8"/>');
}

export function iconMicOff(): SVGSVGElement {
  return svg('0 0 24 24', '<path d="M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 10"/><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 005.12 2.12"/><path d="M19 10a7 7 0 01-.33 2"/><path d="M12 17v4"/><path d="M8 21h8"/>');
}

export function iconVolume(): SVGSVGElement {
  return svg('0 0 24 24', '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/>');
}

export function iconVolumeOff(): SVGSVGElement {
  return svg('0 0 24 24', '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>');
}

export function iconBell(): SVGSVGElement {
  return svg('0 0 24 24', '<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>');
}

export function iconBellOff(): SVGSVGElement {
  return svg('0 0 24 24', '<path d="M13.73 21a2 2 0 01-3.46 0"/><path d="M18.63 13A17.9 17.9 0 0118 8"/><path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 00-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>');
}

export function iconChannel(): SVGSVGElement {
  return svg('0 0 24 24', '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>', 'icon-channel');
}

export function iconLock(): SVGSVGElement {
  return svg('0 0 24 24', '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>');
}

export function iconBrandMark(): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', '0 0 100 100');
  el.classList.add('rail-brand');
  el.innerHTML = '<defs><linearGradient id="rv" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f2b354"/><stop offset="100%" stop-color="#e8a33d"/></linearGradient><filter id="rg"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><path d="M15 18L50 82L85 18" fill="none" stroke="url(#rv)" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><circle cx="84" cy="18" r="9" fill="#5ee08a" filter="url(#rg)"/>';
  return el;
}
