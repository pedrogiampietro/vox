import type { VoxClient } from './client.js';
import {
  listFavorites,
  saveFavorite,
  removeFavorite,
  newFavoriteId,
  type Favorite,
  type ServerStatus,
} from './favorites.js';
import { $, text } from './ui/dom.js';
import { closeMenu, openCustomMenu } from './ui/menu.js';

const SERVER_ADDRESS_PLACEHOLDER = 'ex.: v0x.online ou servidor.v0x.online';

export interface BrowserViewOptions {
  client: VoxClient;
  serverList: ServerStatus[];
  connectTo(fav: Favorite): void;
  rerender(): void;
}

export function renderBrowserView(options: BrowserViewOptions): HTMLElement {
  const root = $('div', 'browser');

  const brand = $('div', 'brand');
  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('viewBox', '0 0 100 100');
  mark.classList.add('brand-mark');
  mark.innerHTML = `<defs><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f2b354"/><stop offset="100%" stop-color="#e8a33d"/></linearGradient><filter id="gl"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><path d="M15 18L50 82L85 18" fill="none" stroke="url(#vg)" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><circle cx="84" cy="18" r="9" fill="#5ee08a" filter="url(#gl)"/>`;
  brand.append(mark, text('h1', '', 'v0x'), text('span', 'rule', ''), text('span', 'label', 'servidores'));
  root.append(brand);

  const body = $('div', 'browser-body');

  const favs = listFavorites();
  if (favs.length > 0) {
    const stack = $('div', 'stack');
    for (const fav of favs) {
      stack.append(renderServerCard(fav, options));
    }
    body.append(stack);
  }

  body.append(renderAddForm(options));

  const ident = $('div', 'identity-row');
  const fp = options.client.identity?.fingerprint?.slice(0, 16) ?? '...';
  ident.append(text('span', 'label', 'identidade'), text('span', 'mono', `${fp}…`));
  body.append(ident);

  if (options.serverList.length > 0) {
    const label = text('span', 'label', 'online agora');
    label.style.marginTop = '8px';
    body.append(label);
    const stack = $('div', 'stack');
    for (const s of options.serverList) {
      stack.append(renderLiveCard(s, options));
    }
    body.append(stack);
  }

  root.append(body);
  return root;
}

function renderServerCard(fav: Favorite, options: BrowserViewOptions): HTMLElement {
  const card = $('div', 'server-card');
  card.style.cursor = 'pointer';

  const slot = text('span', 'slot', '•');
  const info = $('div', '');
  const displayName = fav.label || fav.address || 'local';
  info.append(text('div', 'name', displayName));
  const details: string[] = [];
  if (fav.address) details.push(fav.address);
  if (fav.nickname) details.push(fav.nickname);
  info.append(text('div', 'where', details.join(' · ') || 'servidor local'));
  const occ = $('div', 'occupancy');

  const editBtn = $('button', 'ghost');
  editBtn.textContent = '✎';
  editBtn.title = 'editar';
  editBtn.style.cssText = 'padding:4px 8px;font-size:14px;min-width:unset;';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showEditFavoriteMenu(editBtn, fav, options.rerender);
  });

  card.append(slot, info, occ, editBtn);
  card.addEventListener('click', () => options.connectTo(fav));
  return card;
}

function renderLiveCard(s: ServerStatus, options: BrowserViewOptions): HTMLElement {
  const card = $('button', 'server-card');
  const slot = text('span', 'slot', '•');
  const info = $('div', '');
  info.append(text('div', 'name', s.name), text('div', 'where', s.motd || '–'));
  const occ = renderOccupancy(s.clients, s.maxClients);
  card.append(slot, info, occ);

  card.addEventListener('click', () => {
    const fav: Favorite = {
      id: newFavoriteId(),
      label: s.name,
      address: '',
      serverId: s.id,
      nickname: '',
      password: '',
      lastUsed: Date.now(),
    };
    options.connectTo(fav);
  });
  return card;
}

function renderOccupancy(current: number, max: number): HTMLElement {
  const wrap = $('div', 'occupancy');
  const slots = max > 0 ? Math.min(max, 20) : Math.max(current, 1);
  for (let i = 0; i < slots; i++) {
    const bar = $('i');
    if (i < current) bar.classList.add('filled');
    wrap.append(bar);
  }
  if (max > 0) {
    wrap.append(text('span', 'count', `${current}/${max}`));
  } else {
    wrap.append(text('span', 'count', String(current)));
  }
  return wrap;
}

function renderAddForm(options: BrowserViewOptions): HTMLElement {
  const wrap = $('div', 'stack');
  const btn = $('button', 'ghost');
  btn.textContent = '+ adicionar servidor';
  let open = false;
  let form: HTMLElement | null = null;

  btn.addEventListener('click', () => {
    if (open && form) {
      form.remove();
      open = false;
      return;
    }
    form = $('div', 'form-grid');

    const lblAddr = $('label', 'field');
    lblAddr.append(text('span', 'label', 'endereco do servidor'));
    const inpAddr = $('input') as HTMLInputElement;
    inpAddr.placeholder = SERVER_ADDRESS_PLACEHOLDER;
    inpAddr.setAttribute('autocomplete', 'url');
    lblAddr.classList.add('wide');
    lblAddr.append(inpAddr);

    const lblNick = $('label', 'field');
    lblNick.append(text('span', 'label', 'seu apelido'));
    const inpNick = $('input') as HTMLInputElement;
    inpNick.placeholder = 'eu';
    lblNick.append(inpNick);

    const lblPass = $('label', 'field');
    lblPass.append(text('span', 'label', 'senha (opcional)'));
    const inpPass = $('input') as HTMLInputElement;
    inpPass.type = 'password';
    inpPass.placeholder = 'se houver';
    lblPass.append(inpPass);

    const submit = $('button', 'primary wide');
    submit.textContent = 'entrar no servidor';
    submit.addEventListener('click', () => {
      const address = resolveAddress(inpAddr.value);
      if (!address) {
        inpAddr.focus();
        return;
      }
      const fav: Favorite = {
        id: newFavoriteId(),
        label: address,
        address,
        serverId: 0,
        nickname: inpNick.value.trim() || 'eu',
        password: inpPass.value,
        lastUsed: Date.now(),
      };
      saveFavorite(fav);
      options.connectTo(fav);
    });

    form.append(lblAddr, lblNick, lblPass, submit);
    wrap.append(form);
    open = true;
  });

  wrap.append(btn);
  return wrap;
}

function showEditFavoriteMenu(anchor: HTMLElement, fav: Favorite, rerender: () => void): void {
  closeMenu();
  const menu = $('div', 'menu');
  menu.style.minWidth = '280px';

  const head = $('div', 'head');
  head.append(text('div', 'nick', 'editar servidor'));
  menu.append(head);

  const form = $('div', '');
  form.style.cssText = 'padding:6px 8px 8px;display:grid;gap:6px;';

  function field(label: string, value: string, placeholder: string, type = 'text'): HTMLInputElement {
    const lbl = $('label', 'field');
    lbl.append(text('span', 'label', label));
    const inp = $('input') as HTMLInputElement;
    inp.value = value;
    inp.placeholder = placeholder;
    inp.type = type;
    lbl.append(inp);
    form.append(lbl);
    return inp;
  }

  const inpAddr = field('endereco do servidor', fav.address, SERVER_ADDRESS_PLACEHOLDER);
  const inpNick = field('seu apelido', fav.nickname, 'eu');
  const inpPass = field('senha', fav.password, '', 'password');

  const btnRow = $('div', '');
  btnRow.style.cssText = 'display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-top:8px;';

  const saveBtn = $('button', 'primary');
  saveBtn.textContent = 'salvar';
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fav.address = resolveAddress(inpAddr.value);
    fav.label = fav.address || 'servidor';
    fav.nickname = inpNick.value.trim() || 'eu';
    fav.password = inpPass.value;
    fav.lastUsed = Date.now();
    saveFavorite(fav);
    closeMenu();
    rerender();
  });

  const delBtn = $('button', 'danger');
  delBtn.textContent = 'remover';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeFavorite(fav.id);
    closeMenu();
    rerender();
  });

  const cancelBtn = $('button', 'ghost');
  cancelBtn.textContent = 'cancelar';
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
  });

  btnRow.append(saveBtn, delBtn, cancelBtn);
  form.append(btnRow);
  menu.append(form);

  openCustomMenu(anchor, menu);
}

function resolveAddress(value: string): string {
  const address = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!address || address === 'localhost' || /^\d+(?:\.\d+){3}(?::\d+)?$/.test(address)) return address;
  if (/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(address)) return `${address}.v0x.online`;
  return address;
}
