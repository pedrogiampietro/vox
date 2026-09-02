import { $ } from './dom.js';

let contextMenu: HTMLElement | null = null;
let contextMenuCleanup: (() => void) | null = null;

export function closeMenu(): void {
  if (contextMenu) {
    contextMenu.remove();
    contextMenu = null;
  }
  if (contextMenuCleanup) {
    contextMenuCleanup();
    contextMenuCleanup = null;
  }
  document.removeEventListener('click', onGlobalClick);
  document.removeEventListener('contextmenu', onGlobalContext);
}

export function openMenu(anchor: HTMLElement, items: HTMLElement[]): void {
  const menu = $('div', 'menu');
  menu.append(...items);
  openPositionedMenu(anchor, menu);
  document.addEventListener('click', onGlobalClick);
  document.addEventListener('contextmenu', onGlobalContext);
}

export function openCustomMenu(anchor: HTMLElement, menu: HTMLElement): void {
  openPositionedMenu(anchor, menu);

  function onOutsideClick(e: Event): void {
    if (menu.contains(e.target as Node)) return;
    closeMenu();
  }

  contextMenuCleanup = () => {
    document.removeEventListener('click', onOutsideClick);
    document.removeEventListener('contextmenu', onOutsideClick);
  };

  requestAnimationFrame(() => {
    document.addEventListener('click', onOutsideClick);
    document.addEventListener('contextmenu', onOutsideClick);
  });
}

function openPositionedMenu(anchor: HTMLElement, menu: HTMLElement): void {
  closeMenu();
  menu.style.visibility = 'hidden';
  document.body.append(menu);
  contextMenu = menu;

  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  const pad = 8;

  let top = rect.bottom + 4;
  let left = rect.left;
  if (left + mw + pad > window.innerWidth) left = window.innerWidth - mw - pad;
  if (left < pad) left = pad;
  if (top + mh + pad > window.innerHeight) top = rect.top - mh - 4;
  if (top < pad) top = pad;

  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  menu.style.visibility = '';
}

function onGlobalClick(): void {
  closeMenu();
}

function onGlobalContext(e: Event): void {
  e.preventDefault();
  closeMenu();
}
