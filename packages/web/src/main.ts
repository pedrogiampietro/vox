/**
 * Entry point do cliente Vox.
 *
 * Monta a interface inteira com DOM imperativa: sem framework, sem virtual DOM,
 * sem build step para template. Cada secao da tela e uma funcao que devolve um
 * HTMLElement - o render loop chama todas e troca o conteudo do #app de uma vez.
 *
 * A unica animacao continua da tela e o medidor VU (barra de segments movendo
 * por audio). Tudo o mais e Stateless entre renders: texto, classes, nada de
 * criar e destruir nos no ciclo principal.
 */

import { VoxClient } from './client.js';
import type { MicSettings } from './audio/microphone.js';
import {
  ChannelFlags,
  ClientFlags,
  Group,
  GROUP_NAMES,
  NO_CHANNEL,
  ChatScope,
} from '@vox/protocol';
import type { ChannelInfo, ClientInfo } from '@vox/protocol';
import {
  listFavorites,
  saveFavorite,
  removeFavorite,
  newFavoriteId,
  probe,
  type Favorite,
  type ServerStatus,
} from './favorites.js';

// ------------------------------------------------------------------- state --

let client: VoxClient;
let view: 'browser' | 'shell' = 'browser';
let contextMenu: HTMLElement | null = null;
let contextMenuCleanup: (() => void) | null = null;
let serverList: ServerStatus[] = [];
let settingsOpen = false;

let selectedChannelId = 0;

// ---- drag-to-move state ----
let dragClientId = 0;
let dragGhost: HTMLElement | null = null;
let dragStartY = 0;
let dragActive = false;
let inputDevices: MediaDeviceInfo[] = [];
let outputDevices: MediaDeviceInfo[] = [];

// ---- mic test (module-level state, sobrevive rebuilds do DOM) --
let micTestStream: MediaStream | null = null;
let micTestCtx: AudioContext | null = null;

function stopMicTest(): void {
  if (micTestStream) {
    for (const t of micTestStream.getTracks()) t.stop();
    micTestStream = null;
  }
  if (micTestCtx) {
    micTestCtx.close().catch(() => {});
    micTestCtx = null;
  }
}

async function startMicTest(): Promise<boolean> {
  stopMicTest();
  try {
    micTestCtx = new AudioContext({ sampleRate: 48_000 });
    micTestStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = micTestCtx.createMediaStreamSource(micTestStream);
    const gain = micTestCtx.createGain();
    gain.gain.value = 1;
    src.connect(gain);
    gain.connect(micTestCtx.destination);
    return true;
  } catch {
    stopMicTest();
    return false;
  }
}

// ---------------------------------------------------------------- helpers --

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
};

function text(tag: string, cls: string, content: string): HTMLElement {
  const el = $(tag as any, cls);
  el.textContent = content;
  return el;
}

function timeHHMM(stamp: number): string {
  const d = new Date(stamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- render --

function render(): void {
  const app = document.getElementById('app')!;
  if (view === 'browser') {
    app.replaceChildren(renderBrowser());
  } else {
    app.replaceChildren(renderShell());
  }
}

function renderAll(): void {
  render();
  if (settingsOpen) openSettings();
  else closeSettings();
}

function openSettings(): void {
  closeSettings();
  const overlay = renderSettings();
  document.body.append(overlay);
}

function closeSettings(): void {
  const existing = document.querySelector('.settings-overlay');
  if (existing) existing.remove();
  stopMicTest();
}

// ================================================================ browser ==

function renderBrowser(): HTMLElement {
  const root = $('div', 'browser');

  // brand
  const brand = $('div', 'brand');
  brand.append(text('h1', '', 'vox'), text('span', 'rule', ''), text('span', 'label', 'servidores'));
  root.append(brand);

  const body = $('div', 'browser-body');

  // favorites
  const favs = listFavorites();
  if (favs.length > 0) {
    const stack = $('div', 'stack');
    for (const fav of favs) {
      stack.append(renderServerCard(fav));
    }
    body.append(stack);
  }

  // add server form
  body.append(renderAddForm());

  // identity row
  const ident = $('div', 'identity-row');
  const fp = client.identity?.fingerprint?.slice(0, 16) ?? '...';
  ident.append(text('span', 'label', 'identidade'), text('span', 'mono', `${fp}…`));
  body.append(ident);

  // live server list
  if (serverList.length > 0) {
    const label = text('span', 'label', 'online agora');
    label.style.marginTop = '8px';
    body.append(label);
    const stack = $('div', 'stack');
    for (const s of serverList) {
      stack.append(renderLiveCard(s));
    }
    body.append(stack);
  }

  root.append(body);
  return root;
}

function renderServerCard(fav: Favorite): HTMLElement {
  const card = $('div', 'server-card');
  card.style.cursor = 'pointer';

  const slot = text('span', 'slot', fav.serverId ? String(fav.serverId) : '–');
  const info = $('div', '');
  const displayName = fav.label || fav.address || 'local';
  info.append(text('div', 'name', displayName));
  const details: string[] = [];
  if (fav.address) details.push(fav.address);
  if (fav.nickname) details.push(fav.nickname);
  if (fav.serverId) details.push(`vsrv #${fav.serverId}`);
  info.append(text('div', 'where', details.join(' · ') || 'servidor local'));
  const occ = $('div', 'occupancy');

  const editBtn = $('button', 'ghost');
  editBtn.textContent = '✎';
  editBtn.title = 'editar';
  editBtn.style.cssText = 'padding:4px 8px;font-size:14px;min-width:unset;';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showEditFavoriteMenu(editBtn, fav);
  });

  card.append(slot, info, occ, editBtn);
  card.addEventListener('click', () => connectTo(fav));
  return card;
}

function renderLiveCard(s: ServerStatus): HTMLElement {
  const card = $('button', 'server-card');
  const slot = text('span', 'slot', String(s.id));
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
    connectTo(fav);
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

function renderAddForm(): HTMLElement {
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

    const lblName = $('label', 'field');
    lblName.append(text('span', 'label', 'nome do servidor'));
    const inpName = $('input') as HTMLInputElement;
    inpName.placeholder = 'ex: servidor da galera';
    lblName.append(inpName);

    const lblAddr = $('label', 'field');
    lblAddr.append(text('span', 'label', 'endereco (IP ou dominio)'));
    const inpAddr = $('input') as HTMLInputElement;
    inpAddr.placeholder = '127.0.0.1';
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
    inpPass.placeholder = 'senha do servidor ou admin';
    lblPass.append(inpPass);

    const lblSid = $('label', 'field');
    lblSid.append(text('span', 'label', 'servidor virtual (0 = primeiro)'));
    const inpSid = $('input') as HTMLInputElement;
    inpSid.type = 'number';
    inpSid.value = '0';
    lblSid.append(inpSid);

    const submit = $('button', 'primary wide');
    submit.textContent = 'salvar e conectar';
    submit.addEventListener('click', () => {
      const fav: Favorite = {
        id: newFavoriteId(),
        label: inpName.value.trim() || inpAddr.value || 'local',
        address: inpAddr.value.trim(),
        serverId: Number(inpSid.value) || 0,
        nickname: inpNick.value.trim() || 'eu',
        password: inpPass.value,
        lastUsed: Date.now(),
      };
      saveFavorite(fav);
      connectTo(fav);
    });

    form.append(lblName, lblAddr, lblNick, lblPass, lblSid, submit);
    wrap.append(form);
    open = true;
  });

  wrap.append(btn);
  return wrap;
}

function showEditFavoriteMenu(anchor: HTMLElement, fav: Favorite): void {
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

  const inpLabel = field('apelido do servidor', fav.label, 'meu servidor');
  const inpAddr = field('endereco (IP ou dominio)', fav.address, '127.0.0.1');
  const inpNick = field('seu apelido', fav.nickname, 'eu');
  const inpPass = field('senha', fav.password, '', 'password');
  const inpSid = field('servidor virtual (0 = primeiro)', String(fav.serverId), '0', 'number');

  const btnRow = $('div', '');
  btnRow.style.cssText = 'display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-top:8px;';

  const saveBtn = $('button', 'primary');
  saveBtn.textContent = 'salvar';
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fav.label = inpLabel.value.trim() || fav.address || 'local';
    fav.address = inpAddr.value.trim();
    fav.nickname = inpNick.value.trim() || 'eu';
    fav.password = inpPass.value;
    fav.serverId = Number(inpSid.value) || 0;
    fav.lastUsed = Date.now();
    saveFavorite(fav);
    closeMenu();
    render();
  });

  const delBtn = $('button', 'danger');
  delBtn.textContent = 'remover';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeFavorite(fav.id);
    closeMenu();
    render();
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

// ================================================================ shell ==

function renderShell(): HTMLElement {
  const root = $('div', 'shell');
  root.append(renderRail(), renderRooms(), renderTalk(), renderConsole());
  return root;
}

// ------------------------------------------------------------------- rail --

function renderRail(): HTMLElement {
  const rail = $('div', 'rail');

  const home = $('button');
  home.textContent = '⌂';
  home.title = 'servidores';
  home.addEventListener('click', () => {
    client.disconnect();
    view = 'browser';
    render();
  });
  rail.append(home);

  const settingsBtn = $('button');
  settingsBtn.textContent = '⚙';
  settingsBtn.title = 'configurações';
  settingsBtn.addEventListener('click', () => {
    settingsOpen = true;
    openSettings();
  });
  rail.append(settingsBtn);

  rail.append($('div', 'spacer'));

  const me = client.self;
  if (me) {
    const nick = text('button', '', me.nickname.charAt(0).toUpperCase());
    nick.title = me.nickname;
    nick.style.fontWeight = '700';
    rail.append(nick);
  }

  return rail;
}

// ------------------------------------------------------------------ rooms --

function renderRooms(): HTMLElement {
  const pane = $('div', 'rooms');

  // header
  const hdr = $('div', '');
  hdr.style.cssText = 'padding:11px 14px;border-bottom:1px solid var(--line);';
  hdr.append(text('div', 'name', client.serverName || 'vox'), text('span', 'label', `v${client.serverId || 1}`));
  pane.append(hdr);

  // tree
  const tree = $('div', 'tree');
  renderChannelTree(tree, NO_CHANNEL, 0);

  tree.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.room') || target.closest('.peer')) return;
    e.preventDefault();
    e.stopPropagation();
    showTreeMenu(e);
  });

  pane.append(tree);

  // footer
  const foot = $('div', '');
  foot.style.cssText = 'border-top:1px solid var(--line);padding:8px 10px;display:flex;gap:8px;';

  const addBtn = $('button', 'ghost');
  addBtn.textContent = '+ canal';
  addBtn.addEventListener('click', () => promptCreateChannel());
  foot.append(addBtn);

  const disconnectBtn = $('button', 'ghost danger');
  disconnectBtn.textContent = 'sair';
  disconnectBtn.addEventListener('click', () => {
    client.disconnect();
    view = 'browser';
    render();
  });
  foot.append(disconnectBtn);

  pane.append(foot);
  return pane;
}

function renderChannelTree(parent: HTMLElement, parentId: number, depth: number): void {
  const children = client.childrenOf(parentId);
  for (const ch of children) {
    const members = client.membersOf(ch.id);
    const locked = (ch.flags & ChannelFlags.Password) !== 0;
    const full = ch.maxClients > 0 && members.length >= ch.maxClients;

    const row = $('div', 'room');
    if (ch.id === client.self?.channelId) row.classList.add('here');
    if (ch.id === selectedChannelId) row.classList.add('selected');
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const idx = text('span', 'idx', locked ? '🔒' : '#');
    const info = $('div', 'room-info');
    info.append(text('span', 'name', ch.name));
    if (ch.topic) info.append(text('span', 'topic', ch.topic));
    const cap =
      ch.maxClients > 0 ? text('span', 'cap', `${members.length}/${ch.maxClients}`) : text('span', 'cap', String(members.length));
    row.append(idx, info, cap);

    row.dataset.channelId = String(ch.id);

    row.addEventListener('click', () => {
      selectedChannelId = ch.id;
      render();
    });
    row.addEventListener('dblclick', () => {
      if (ch.id !== client.self?.channelId) client.join(ch.id);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showChannelMenu(e, ch);
    });

    parent.append(row);

    // members inside channel
    for (const m of members) {
      parent.append(renderPeer(m));
    }

    // sub-channels
    renderChannelTree(parent, ch.id, depth + 1);
  }
}

function renderPeer(c: ClientInfo): HTMLElement {
  const row = $('div', 'peer');
  if (c.id === client.selfId) row.classList.add('me');

  const talking = client.isTalking(c.id);
  const muted = (c.flags & ClientFlags.MutedMic) !== 0;
  const away = (c.flags & ClientFlags.Away) !== 0;
  const noInput = (c.flags & ClientFlags.NoInput) !== 0;
  if (!talking && (muted || away || noInput)) row.classList.add('quiet');

  // VU meter
  const vu = $('div', 'vu');
  vu.dataset.vu = String(c.id);
  vu.append($('i'), $('i'), $('i'), $('i'));

  const nick = text('span', 'nick', c.nickname);
  if (c.id === client.selfId) {
    nick.style.cursor = 'text';
    nick.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = $('input') as HTMLInputElement;
      input.type = 'text';
      input.value = c.nickname;
      input.style.cssText = 'width:100%;font:inherit;padding:1px 4px;border:1px solid var(--amber-dim);background:var(--ink-900);color:var(--text);border-radius:var(--r);';
      const apply = () => {
        const val = input.value.trim();
        if (val && val !== c.nickname) client.setNickname(val);
        nick.textContent = val || c.nickname;
      };
      input.addEventListener('blur', apply, { once: true });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') { input.value = c.nickname; input.blur(); }
      });
      nick.replaceChildren(input);
      input.focus();
      input.select();
    });
  }
  if (c.group >= Group.Owner) nick.style.color = 'var(--amber)';
  row.append(vu, nick);

  // rank badge
  if (c.group > Group.Guest) {
    const icons: Record<number, string> = { [Group.Moderator]: '⚔', [Group.Admin]: '★', [Group.Owner]: '♛' };
    const badge = text('span', 'rank', icons[c.group] || GROUP_NAMES[c.group].charAt(0).toUpperCase());
    badge.title = GROUP_NAMES[c.group];
    if (c.group === Group.Owner) badge.style.color = 'var(--amber)';
    else if (c.group === Group.Admin) badge.style.color = '#e0a040';
    else badge.style.color = 'var(--text-dim)';
    row.append(badge);
  }

  // flags
  if (muted) row.append(text('span', 'flag', '🔇'));
  if (away) row.append(text('span', 'flag', 'Away'));
  if (noInput) row.append(text('span', 'flag', '⚠'));

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showUserMenu(row, c);
  });

  if (client.canMove(c)) {
    row.classList.add('movable');
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (c.id === client.selfId && (target.classList.contains('nick') || target.closest('.nick'))) return;
      e.preventDefault();
      dragClientId = c.id;
      dragStartY = e.clientY;
      dragActive = false;
      row.setPointerCapture(e.pointerId);
    });
    row.addEventListener('pointermove', (e) => {
      if (!dragClientId || dragClientId !== c.id) return;
      if (!dragActive && Math.abs(e.clientY - dragStartY) < 6) return;
      if (!dragActive) {
        dragActive = true;
        row.classList.add('dragging');
        dragGhost = $('div', 'drag-ghost');
        dragGhost.textContent = c.nickname;
        document.body.append(dragGhost);
      }
      dragGhost!.style.left = `${e.clientX + 12}px`;
      dragGhost!.style.top = `${e.clientY - 14}px`;
      updateDropHighlight(e.clientX, e.clientY);
    });
    row.addEventListener('pointerup', (e) => {
      if (!dragClientId || dragClientId !== c.id) return;
      row.releasePointerCapture(e.pointerId);
      row.classList.remove('dragging');
      if (dragActive) {
        if (dragGhost) { dragGhost.style.display = 'none'; }
        const target = getDropChannel(e.clientX, e.clientY);
        if (target !== null) {
          if (c.id === client.selfId) client.join(target);
          else client.moveUser(c.id, target);
        }
        clearDropHighlight();
      }
      if (dragGhost) { dragGhost.remove(); dragGhost = null; }
      dragClientId = 0;
      dragActive = false;
    });
    row.addEventListener('lostpointercapture', () => {
      if (dragClientId === c.id) {
        row.classList.remove('dragging');
        clearDropHighlight();
        if (dragGhost) { dragGhost.remove(); dragGhost = null; }
        dragClientId = 0;
        dragActive = false;
      }
    });
  }

  return row;
}

// ------------------------------------------------------------------- talk --

function renderTalk(): HTMLElement {
  const pane = $('div', 'talk');

  // header
  const hdr = $('header');
  const serverLabel = text('span', 'name', client.serverName || 'vox');
  serverLabel.style.cssText = 'font-weight:650;font-size:15px;';
  const motd = text('span', 'motd', client.motd || '');
  if (client.notice?.kind === 'error') motd.classList.add('warn');
  const stat = $('span', 'stat');
  const transport = text('span', 'via', client.connection.voiceTransport === 'quic' ? 'QUIC' : 'WS');
  stat.append(
    text('span', '', `RTT`),
    text('b', '', `${client.connection.rtt}ms`),
    text('span', '', '·'),
    transport,
  );
  hdr.append(serverLabel, motd, stat);
  pane.append(hdr);

  // channel info panel
  const selCh = selectedChannelId ? client.channels.get(selectedChannelId) : null;
  if (selCh) {
    pane.append(renderChannelInfoPanel(selCh));
  }

  // chat log
  const log = $('div', 'log');
  for (const line of client.chat) {
    const row = $('div', 'line');
    if (line.senderId === 0) row.classList.add('system');
    row.append(
      text('time', '', timeHHMM(line.stamp)),
      (() => {
        const body = $('span', 'body');
        if (line.senderId !== 0) {
          body.append(text('span', 'who', line.senderName));
        }
        body.append(document.createTextNode(line.text));
        return body;
      })(),
    );
    log.append(row);
  }
  // auto scroll
  requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
  pane.append(log);

  // composer
  const composer = $('div', 'composer');
  const input = $('input') as HTMLInputElement;
  input.placeholder = 'mensagem…';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      client.say(input.value.trim());
      input.value = '';
    }
  });
  composer.append(input);
  pane.append(composer);

  return pane;
}

function renderChannelInfoPanel(ch: ChannelInfo): HTMLElement {
  const panel = $('div', 'channel-info');
  const members = client.membersOf(ch.id);
  const isHere = ch.id === client.self?.channelId;

  // top row: name + join button
  const top = $('div', 'channel-info-header');
  const locked = (ch.flags & ChannelFlags.Password) !== 0;
  const icon = text('span', 'channel-icon', locked ? '🔒' : '#');
  const nm = text('span', 'channel-name', ch.name);
  top.append(icon, nm);

  if (!isHere) {
    const joinBtn = $('button', 'primary');
    joinBtn.textContent = 'entrar';
    joinBtn.style.cssText = 'padding:4px 14px;font-size:12px;';
    joinBtn.addEventListener('click', () => client.join(ch.id));
    top.append(joinBtn);
  } else {
    const badge = text('span', 'label', 'conectado');
    badge.style.color = 'var(--signal)';
    top.append(badge);
  }

  const dismiss = $('button', 'ghost');
  dismiss.textContent = '✕';
  dismiss.style.cssText = 'padding:2px 6px;font-size:12px;min-width:unset;margin-left:auto;';
  dismiss.addEventListener('click', () => { selectedChannelId = 0; render(); });
  top.append(dismiss);

  panel.append(top);

  // description / topic
  if (ch.topic) {
    const desc = $('div', 'channel-desc');
    desc.textContent = ch.topic;
    panel.append(desc);
  }

  // stats row
  const stats = $('div', 'channel-stats');

  const memberStat = $('div', 'stat-item');
  memberStat.append(
    text('span', 'stat-value', String(members.length)),
    text('span', 'stat-label', ch.maxClients > 0 ? `/ ${ch.maxClients} conectados` : 'conectados'),
  );
  stats.append(memberStat);

  const flags: string[] = [];
  if (ch.flags & ChannelFlags.Permanent) flags.push('Permanente');
  if (ch.flags & ChannelFlags.Default) flags.push('Padrao');
  if (locked) flags.push('Senha');
  if (flags.length > 0) {
    const flagStat = $('div', 'stat-item');
    flagStat.append(text('span', 'stat-label', flags.join(' · ')));
    stats.append(flagStat);
  }

  panel.append(stats);

  // member list
  if (members.length > 0) {
    const list = $('div', 'channel-members');
    list.append(text('span', 'label', 'membros'));
    const grid = $('div', 'member-grid');
    for (const m of members) {
      const item = $('div', 'member-item');
      const muted = (m.flags & ClientFlags.MutedMic) !== 0;
      const away = (m.flags & ClientFlags.Away) !== 0;

      const statusDot = $('span', 'member-dot');
      if (away) statusDot.classList.add('away');
      else if (muted) statusDot.classList.add('muted');
      else statusDot.classList.add('online');

      const mNick = text('span', '', m.nickname);
      if (m.group >= Group.Owner) mNick.style.color = 'var(--amber)';
      item.append(statusDot, mNick);

      if (m.group > Group.Guest) {
        const icons: Record<number, string> = { [Group.Moderator]: '⚔', [Group.Admin]: '★', [Group.Owner]: '♛' };
        const badge = text('span', 'rank', icons[m.group] || '');
        badge.style.fontSize = '8px';
        item.append(badge);
      }
      grid.append(item);
    }
    list.append(grid);
    panel.append(list);
  }

  return panel;
}

// ----------------------------------------------------------------- console --

// ------------------------------------------------------- drag-to-move helpers --

function getDropChannel(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const room = (el as HTMLElement).closest('.room') as HTMLElement | null;
  if (room?.dataset.channelId) return Number(room.dataset.channelId);
  return null;
}

function updateDropHighlight(x: number, y: number): void {
  clearDropHighlight();
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const room = (el as HTMLElement).closest('.room') as HTMLElement | null;
  if (room) room.classList.add('drop-target');
}

function clearDropHighlight(): void {
  document.querySelectorAll('.room.drop-target').forEach((el) => el.classList.remove('drop-target'));
}

// ----------------------------------------------------------------- console --

function renderConsole(): HTMLElement {
  const bar = $('div', 'console');

  // mic toggle
  const micBtn = $('button');
  const micMuted = (client.flags & ClientFlags.MutedMic) !== 0;
  micBtn.textContent = micMuted ? '🔇' : '🎙️';
  micBtn.title = micMuted ? 'ligar microfone' : 'desligar microfone';
  micBtn.addEventListener('click', () => client.toggleMic());
  bar.append(micBtn);

  // mic meter
  const meter = $('div', 'meter');
  meter.dataset.meter = 'mic';
  const meterFill = $('i');
  const threshold = $('u');
  const threshPct = Math.min(100, Math.round(client.mic.threshold * 4 * 100));
  threshold.style.left = `${threshPct}%`;
  meter.append(meterFill, threshold);
  bar.append(meter);

  // divider
  bar.append($('div', 'divider'));

  // speaker toggle
  const spkBtn = $('button');
  const spkMuted = (client.flags & ClientFlags.MutedSpeakers) !== 0;
  spkBtn.textContent = spkMuted ? '🔇' : '🔊';
  spkBtn.title = spkMuted ? 'ligar som' : 'desligar som';
  spkBtn.addEventListener('click', () => client.toggleSpeakers());
  bar.append(spkBtn);

  // output volume
  const volRange = $('input') as HTMLInputElement;
  volRange.type = 'range';
  volRange.min = '0';
  volRange.max = '1.5';
  volRange.step = '0.05';
  volRange.value = String(client.outputVolume);
  volRange.addEventListener('input', () => client.setOutputVolumeDirect(Number(volRange.value)));
  bar.append(volRange);

  bar.append($('div', 'spacer'));

  // sound toggle
  const sndBtn = $('button', 'ghost');
  sndBtn.textContent = client.soundsEnabled ? '🔔' : '🔕';
  sndBtn.title = client.soundsEnabled ? 'silenciar avisos' : 'ativar avisos';
  sndBtn.addEventListener('click', () => client.setSoundsEnabled(!client.soundsEnabled));
  bar.append(sndBtn);

  // link state
  const state = text('span', 'mono', client.link);
  if (client.link === 'online') state.style.color = 'var(--signal)';
  else if (client.link === 'connecting') state.style.color = 'var(--amber)';
  else state.style.color = 'var(--text-faint)';
  bar.append(state);

  // unread badge
  if (client.unread > 0) {
    const badge = text('span', 'badge', String(client.unread));
    bar.append(badge);
  }

  return bar;
}

// ============================================================== context menus --

// ----------------------------------------------------------------- settings --

async function enumerateDevices(): Promise<void> {
  try {
    // Need permission first — ask for mic access briefly
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of tempStream.getTracks()) track.stop();
  } catch {
    // no permission, list what we can
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  inputDevices = all.filter((d) => d.kind === 'audioinput');
  outputDevices = all.filter((d) => d.kind === 'audiooutput');
}

function renderSettings(): HTMLElement {
  const overlay = $('div', 'settings-overlay');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      settingsOpen = false;
      closeSettings();
    }
  });

  const panel = $('div', 'settings');

  // --- nav ---
  const nav = $('div', 'settings-nav');
  const sections = [
    { id: 'capture', icon: '🎙', label: 'Capturar' },
    { id: 'playback', icon: '🔊', label: 'Reprodução' },
  ];
  let activeSection = 'capture';

  function buildNav(): void {
    nav.replaceChildren();
    for (const s of sections) {
      const btn = $('button');
      if (s.id === activeSection) btn.classList.add('active');
      btn.innerHTML = `<span class="icon">${s.icon}</span> ${s.label}`;
      btn.addEventListener('click', () => {
        activeSection = s.id;
        buildNav();
        buildBody();
      });
      nav.append(btn);
    }
  }

  // --- body ---
  const body = $('div', 'settings-body');

  function buildBody(): void {
    body.replaceChildren();
    if (activeSection === 'capture') buildCaptureSection(body, buildBody);
    else buildPlaybackSection(body);
  }

  // --- footer ---
  const footer = $('div', 'settings-footer');
  const closeBtn = $('button', 'primary');
  closeBtn.textContent = 'fechar';
  closeBtn.addEventListener('click', () => {
    settingsOpen = false;
    closeSettings();
  });
  footer.append(closeBtn);

  buildNav();
  buildBody();
  panel.append(nav, body, footer);
  overlay.append(panel);
  return overlay;
}

function buildCaptureSection(body: HTMLElement, rebuild: () => void): void {
  // Title
  body.append(text('h3', '', 'CAPTURAR'));
  body.append(text('span', '', 'Configure o sistema de captura de áudio'));

  // Input device
  const devRow = $('div', 'settings-row');
  const devLabel = $('label');
  devLabel.append(text('span', '', 'Dispositivo de captura'));
  const devSelect = $('select') as HTMLSelectElement;
  for (const d of inputDevices) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = d.deviceId;
    opt.textContent = d.label || `microfone ${d.deviceId.slice(0, 8)}`;
    if (d.deviceId === client.mic.deviceId) opt.selected = true;
    devSelect.append(opt);
  }
  if (inputDevices.length === 0) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = '';
    opt.textContent = 'padrão do sistema';
    opt.selected = true;
    devSelect.append(opt);
  }
  devSelect.addEventListener('change', () => {
    client.applyMicSettings({ deviceId: devSelect.value });
  });
  devLabel.append(devSelect);
  devRow.append(devLabel);
  body.append(devRow);

  // Activation mode
  body.append($('hr'));
  const actLabel = text('span', '', 'Ativação');
  actLabel.style.cssText = 'font-weight:600;font-size:13px;color:var(--text-dim);';
  body.append(actLabel);

  const actGroup = $('div', '');
  actGroup.style.cssText = 'display:grid;gap:6px;';

  const modes: { value: MicSettings['activation']; label: string; desc: string }[] = [
    { value: 'ptt', label: 'Push-to-Talk', desc: 'Segure o botão para falar' },
    { value: 'voice', label: 'Detecção de atividade por voz', desc: 'Fala automaticamente ao detectar voz' },
  ];

  for (const m of modes) {
    const row = $('div', 'settings-toggle');
    const radio = $('input') as HTMLInputElement;
    radio.type = 'radio';
    radio.name = 'activation';
    radio.value = m.value;
    radio.checked = client.mic.activation === m.value;
    radio.addEventListener('change', () => {
      client.applyMicSettings({ activation: m.value });
      rebuild();
    });
    const span = $('span');
    span.append(text('b', '', m.label), text('span', '', ` — ${m.desc}`));
    span.querySelector('span')!.style.color = 'var(--text-faint)';
    row.append(radio, span);
    actGroup.append(row);
  }
  body.append(actGroup);

  // Threshold (only for voice activation)
  if (client.mic.activation === 'voice') {
    const thrRow = $('div', 'settings-row');
    thrRow.style.marginTop = '8px';

    const thrLabel = $('label');
    thrLabel.append(text('span', '', 'Limiar de detecção de voz'));

    const slider = $('div', 'settings-slider');
    const range = $('input') as HTMLInputElement;
    range.type = 'range';
    range.min = '0.005';
    range.max = '0.3';
    range.step = '0.005';
    range.value = String(client.mic.threshold);
    const valSpan = text('span', 'val', `${Math.round(client.mic.threshold * 100)}%`);
    slider.append(range, valSpan);
    thrLabel.append(slider);

    // threshold visualizer with live level
    const bar = $('div', 'threshold-bar');
    const levelFill = $('div', 'level-fill');
    const marker = $('div', 'marker');
    marker.style.left = `${Math.min(100, client.mic.threshold * 4 * 100)}%`;
    bar.append(levelFill, marker);
    thrLabel.append(bar);

    let thrAF: number | null = null;
    function updateThresholdViz(): void {
      const lvl = Math.min(1, client.micLevel);
      levelFill.style.width = `${lvl * 100}%`;
      levelFill.classList.toggle('above', client.micLevel >= client.mic.threshold * 4);
      thrAF = requestAnimationFrame(updateThresholdViz);
    }
    thrAF = requestAnimationFrame(updateThresholdViz);

    range.addEventListener('input', () => {
      const v = Number(range.value);
      client.applyMicSettings({ threshold: v });
      valSpan.textContent = `${Math.round(v * 100)}%`;
      marker.style.left = `${Math.min(100, v * 4 * 100)}%`;
      const consoleThr = document.querySelector('[data-meter="mic"] u') as HTMLElement | null;
      if (consoleThr) consoleThr.style.left = `${Math.min(100, v * 4 * 100)}%`;
    });

    thrRow.append(thrLabel);
    body.append(thrRow);
  }

  // Test mic with loopback
  body.append($('hr'));
  const testRow = $('div', 'settings-test');
  const testBtn = $('button', 'ghost');
  testBtn.textContent = micTestStream ? '■ parar teste' : '▶ teste de microfone';
  const testDot = $('div', 'dot');
  let testIv: ReturnType<typeof setInterval> | null = null;

  testBtn.addEventListener('click', async () => {
    if (micTestStream) {
      stopMicTest();
      if (testIv) { clearInterval(testIv); testIv = null; }
      testBtn.textContent = '▶ teste de microfone';
      testDot.classList.remove('live');
      return;
    }
    const ok = await startMicTest();
    if (!ok) {
      testBtn.textContent = '▶ erro de microfone';
      return;
    }
    testBtn.textContent = '■ parar teste';
    testIv = setInterval(() => {
      if (!micTestStream) { clearInterval(testIv!); testIv = null; return; }
      testDot.classList.toggle('live', client.micLevel > 0.01);
    }, 60);
  });
  testRow.append(testBtn, testDot);
  body.append(testRow);

  // Bitrate
  body.append($('hr'));
  const brRow = $('div', 'settings-row');
  const brLabel = $('label');
  brLabel.append(text('span', '', 'Bitrate (kbps)'));
  const brSelect = $('select') as HTMLSelectElement;
  for (const br of [16, 24, 32, 48, 64]) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = String(br * 1000);
    opt.textContent = `${br} kbps`;
    if (br * 1000 === client.mic.bitrate) opt.selected = true;
    brSelect.append(opt);
  }
  brSelect.addEventListener('change', () => {
    client.applyMicSettings({ bitrate: Number(brSelect.value) });
  });
  brLabel.append(brSelect);
  brRow.append(brLabel);
  body.append(brRow);
}

function buildPlaybackSection(body: HTMLElement): void {
  body.append(text('h3', '', 'REPRODUÇÃO'));
  body.append(text('span', '', 'Configure o sistema de reprodução de áudio'));

  // Output volume
  const volRow = $('div', 'settings-row');
  const volLabel = $('label');
  volLabel.append(text('span', '', 'Volume geral'));
  const volSlider = $('div', 'settings-slider');
  const volRange = $('input') as HTMLInputElement;
  volRange.type = 'range';
  volRange.min = '0';
  volRange.max = '1.5';
  volRange.step = '0.05';
  volRange.value = String(client.outputVolume);
  const volVal = text('span', 'val', `${Math.round(client.outputVolume * 100)}%`);
  volRange.addEventListener('input', () => {
    const v = Number(volRange.value);
    client.setOutputVolumeDirect(v);
    volVal.textContent = `${Math.round(v * 100)}%`;
  });
  volSlider.append(volRange, volVal);
  volLabel.append(volSlider);
  volRow.append(volLabel);
  body.append(volRow);

  // Sounds
  body.append($('hr'));
  const sndRow = $('div', 'settings-toggle');
  const sndCheck = $('input') as HTMLInputElement;
  sndCheck.type = 'checkbox';
  sndCheck.checked = client.soundsEnabled;
  sndCheck.addEventListener('change', () => {
    client.setSoundsEnabled(sndCheck.checked);
  });
  sndRow.append(sndCheck, text('span', '', 'Reproduzir sons de aviso (join, leave, mensagem)'));
  body.append(sndRow);

  // Test sound
  const testRow = $('div', 'settings-test');
  const testBtn = $('button', 'ghost');
  testBtn.textContent = '▶ reproduzir som de teste';
  testBtn.addEventListener('click', () => {
    // Play a simple test tone
    const ctx = new AudioContext({ sampleRate: 48000 });
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.3;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.stop(ctx.currentTime + 0.5);
    osc.onended = () => ctx.close();
  });
  testRow.append(testBtn);
  body.append(testRow);

  // Voice volume adjustment (per-user is handled elsewhere, this is global preamp)
  body.append($('hr'));
  const preRow = $('div', 'settings-row');
  const preLabel = $('label');
  preLabel.append(text('span', '', 'Ajuste de voz (preamp)'));
  const preSlider = $('div', 'settings-slider');
  const preRange = $('input') as HTMLInputElement;
  preRange.type = 'range';
  preRange.min = '0.5';
  preRange.max = '2';
  preRange.step = '0.05';
  preRange.value = '1';
  const preVal = text('span', 'val', '+0 dB');
  preRange.addEventListener('input', () => {
    const v = Number(preRange.value);
    const db = v === 1 ? 0 : Math.round(20 * Math.log10(v));
    preVal.textContent = db >= 0 ? `+${db} dB` : `${db} dB`;
    client.setOutputVolumeDirect(v);
  });
  preSlider.append(preRange, preVal);
  preLabel.append(preSlider);
  preRow.append(preLabel);
  body.append(preRow);
}

// ============================================================ context menus --

function closeMenu(): void {
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

function onGlobalClick(): void {
  closeMenu();
}

function onGlobalContext(e: Event): void {
  e.preventDefault();
  closeMenu();
}

function openMenu(anchor: HTMLElement, items: HTMLElement[]): void {
  closeMenu();
  const menu = $('div', 'menu');
  menu.append(...items);
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

  document.addEventListener('click', onGlobalClick);
  document.addEventListener('contextmenu', onGlobalContext);
}

function collapsible(label: string, danger = false): { toggle: HTMLButtonElement; sub: HTMLDivElement } {
  const toggle = $('button', danger ? 'danger' : '') as HTMLButtonElement;
  const arrow = $('span', 'arrow');
  arrow.textContent = '›';
  toggle.append(document.createTextNode(label), arrow);

  const sub = $('div', 'sub collapsed') as HTMLDivElement;
  const inner = $('div', '');
  sub.append(inner);

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    sub.classList.toggle('collapsed');
    toggle.classList.toggle('open');
  });

  return { toggle, sub };
}

function showUserMenu(anchor: HTMLElement, target: ClientInfo): void {
  const items: HTMLElement[] = [];
  const isSelf = target.id === client.selfId;
  const isAway = (target.flags & ClientFlags.Away) !== 0;
  const isMuted = (target.flags & ClientFlags.MutedMic) !== 0;
  const isDeaf = (target.flags & ClientFlags.MutedSpeakers) !== 0;

  // ---- header ----
  const head = $('div', 'head');
  const nickRow = $('div', '');
  nickRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
  nickRow.append(text('div', 'nick', target.nickname));
  // rank badge in header
  if (target.group > Group.Guest) {
    const icons: Record<number, string> = { [Group.Moderator]: '⚔', [Group.Admin]: '★', [Group.Owner]: '♛' };
    const badge = text('span', 'rank', icons[target.group] || GROUP_NAMES[target.group].charAt(0).toUpperCase());
    badge.title = GROUP_NAMES[target.group];
    nickRow.append(badge);
  }
  head.append(nickRow);
  if (target.fingerprint) {
    head.append(text('div', 'mono', target.fingerprint.slice(0, 20) + '…'));
  }
  const statusParts: string[] = [];
  if (isAway) statusParts.push('ausente');
  if (isMuted) statusParts.push('mic mudo');
  if (isDeaf) statusParts.push('surdo');
  if (statusParts.length > 0) {
    const status = text('div', 'mono', statusParts.join(' · '));
    status.style.color = 'var(--amber-dim)';
    head.append(status);
  }
  items.push(head);

  if (isSelf) {
    // ---- self actions ----
    items.push($('hr'));

    const awayBtn = $('button');
    awayBtn.textContent = isAway ? 'voltar' : 'ausente';
    awayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      client.toggleAway();
      closeMenu();
    });
    items.push(awayBtn);

    const deafBtn = $('button');
    deafBtn.textContent = isDeaf ? 'ouvir novamente' : 'não ouvir nada (deafen)';
    deafBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      client.toggleSpeakers();
      closeMenu();
    });
    items.push(deafBtn);
  } else {
    // ---- other user actions ----

    // volume
    const volWrap = $('div', 'slider');
    const volLabel = text('span', 'label', `volume: ${Math.round(client.userVolume(target) * 100)}%`);
    const volRange = $('input') as HTMLInputElement;
    volRange.type = 'range';
    volRange.min = '0';
    volRange.max = '2';
    volRange.step = '0.05';
    volRange.value = String(client.userVolume(target));
    volRange.addEventListener('input', () => {
      client.setUserVolume(target, Number(volRange.value));
      volLabel.textContent = `volume: ${Math.round(Number(volRange.value) * 100)}%`;
    });
    volWrap.append(volLabel, volRange);
    items.push(volWrap);

    // mute
    const muteBtn = $('button');
    muteBtn.textContent = client.isUserMuted(target) ? 'desmutar' : 'mutar';
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      client.toggleUserMute(target);
      closeMenu();
    });
    items.push(muteBtn);

    // ---- move to channel ----
    if (client.canModerate(target, Group.Moderator)) {
      const channels = [...client.channels.values()].filter((c) => c.id !== target.channelId);
      if (channels.length > 0) {
        items.push($('hr'));
        const { toggle, sub } = collapsible('mover para');
        items.push(toggle);
        for (const ch of channels) {
          const chBtn = $('button');
          chBtn.textContent = ch.name;
          chBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            client.moveUser(target.id, ch.id);
            closeMenu();
          });
          sub.firstElementChild!.append(chBtn);
        }
        items.push(sub);
      }
    }

    // ---- moderation ----
    if (client.canModerate(target, Group.Moderator)) {
      items.push($('hr'));

      const kickBtn = $('button', 'danger');
      kickBtn.textContent = 'expulsar';
      kickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        client.kick(target.id, '');
        closeMenu();
      });
      items.push(kickBtn);
    }

    if (client.canModerate(target, Group.Admin)) {
      const { toggle, sub } = collapsible('banir', true);
      items.push(toggle);

      const banDurations: { label: string; minutes: number }[] = [
        { label: '5 minutos', minutes: 5 },
        { label: '30 minutos', minutes: 30 },
        { label: '1 hora', minutes: 60 },
        { label: '24 horas', minutes: 1440 },
        { label: 'permanente', minutes: 0 },
      ];
      for (const d of banDurations) {
        const dBtn = $('button', 'danger');
        dBtn.textContent = d.label;
        dBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          client.ban(target.id, d.minutes, '');
          closeMenu();
        });
        sub.firstElementChild!.append(dBtn);
      }
      items.push(sub);
    }

    // ---- group assignment ----
    if (client.canModerate(target, Group.Admin)) {
      const { toggle, sub } = collapsible('grupo');
      items.push(toggle);

      const groups: { value: Group; label: string }[] = [
        { value: Group.Guest, label: 'convidado' },
        { value: Group.Moderator, label: 'moderador' },
        { value: Group.Admin, label: 'administrador' },
      ];
      for (const g of groups) {
        if (g.value >= client.myGroup) continue;
        const gBtn = $('button');
        const isCurrent = target.group === g.value;
        gBtn.textContent = isCurrent ? `✓ ${g.label}` : g.label;
        if (isCurrent) {
          gBtn.style.color = 'var(--amber)';
          gBtn.disabled = true;
        }
        gBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          client.setGroup(target.id, g.value);
          closeMenu();
        });
        sub.firstElementChild!.append(gBtn);
      }
      items.push(sub);
    }
  }

  openMenu(anchor, items);
}

function showChannelMenu(e: MouseEvent, ch: ChannelInfo): void {
  const items: HTMLElement[] = [];

  // header
  const head = $('div', 'head');
  head.append(text('div', 'nick', ch.name));
  if (ch.topic) head.append(text('div', 'mono', ch.topic));
  const flags: string[] = [];
  if (ch.flags & ChannelFlags.Password) flags.push('🔒');
  if (ch.flags & ChannelFlags.Permanent) flags.push('perm');
  if (ch.flags & ChannelFlags.Default) flags.push('padrão');
  if (ch.maxClients > 0) flags.push(`${ch.maxClients} vagas`);
  if (flags.length > 0) {
    head.append(text('div', '', flags.join(' · ')));
  }
  items.push(head);

  // join
  if (ch.id !== client.self?.channelId) {
    const joinBtn = $('button');
    joinBtn.textContent = 'entrar';
    joinBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      client.join(ch.id);
      closeMenu();
    });
    items.push(joinBtn);
  }

  // moderator actions
  if (client.myGroup >= Group.Moderator) {
    items.push($('hr'));

    // edit channel
    const editBtn = $('button');
    editBtn.textContent = 'editar canal';
    editBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      showEditChannelOverlay(ch);
    });
    items.push(editBtn);

    // create sub-channel
    const subBtn = $('button');
    subBtn.textContent = 'criar sub-canal';
    subBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      showCreateChannelOverlay(ch.id);
    });
    items.push(subBtn);

    // delete
    if (!(ch.flags & ChannelFlags.Default)) {
      const delBtn = $('button', 'danger');
      delBtn.textContent = 'remover canal';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        client.deleteChannel(ch.id);
        closeMenu();
      });
      items.push(delBtn);
    }
  }

  const anchor = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement;
  if (anchor) openMenu(anchor, items);
}

function showEditChannelOverlay(ch: ChannelInfo): void {
  const overlay = $('div', 'settings-overlay');
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.remove();
  });

  const panel = $('div', 'settings');
  panel.style.width = '420px';
  panel.style.gridTemplateColumns = '1fr';

  const body = $('div', 'settings-body');
  body.append(text('h3', '', `EDITAR: ${ch.name}`));

  // name
  const nameRow = $('div', 'settings-row');
  const nameLabel = $('label');
  nameLabel.append(text('span', '', 'Nome'));
  const nameInput = $('input') as HTMLInputElement;
  nameInput.value = ch.name;
  nameLabel.append(nameInput);
  nameRow.append(nameLabel);
  body.append(nameRow);

  // topic
  const topicRow = $('div', 'settings-row');
  const topicLabel = $('label');
  topicLabel.append(text('span', '', 'Tópico'));
  const topicInput = $('input') as HTMLInputElement;
  topicInput.value = ch.topic;
  topicInput.placeholder = 'descrição do canal';
  topicLabel.append(topicInput);
  topicRow.append(topicLabel);
  body.append(topicRow);

  // max clients
  const maxRow = $('div', 'settings-row');
  const maxLabel = $('label');
  maxLabel.append(text('span', '', 'Máximo de clientes (0 = ilimitado)'));
  const maxInput = $('input') as HTMLInputElement;
  maxInput.type = 'number';
  maxInput.value = String(ch.maxClients);
  maxInput.min = '0';
  maxLabel.append(maxInput);
  maxRow.append(maxLabel);
  body.append(maxRow);

  // flags info
  const flagInfo = $('div', '');
  flagInfo.style.cssText = 'font-size:12px;color:var(--text-faint);';
  const flagParts: string[] = [];
  if (ch.flags & ChannelFlags.Permanent) flagParts.push('Permanente');
  if (ch.flags & ChannelFlags.Default) flagParts.push('Canal padrão (não removível)');
  if (ch.flags & ChannelFlags.Password) flagParts.push('Protegido por senha');
  flagInfo.textContent = flagParts.length > 0 ? `Flags: ${flagParts.join(', ')}` : 'Sem flags especiais';
  body.append(flagInfo);

  const footer = $('div', 'settings-footer');
  const saveBtn = $('button', 'primary');
  saveBtn.textContent = 'salvar';
  saveBtn.addEventListener('click', () => {
    client.editChannel(
      ch.id,
      nameInput.value.trim() || ch.name,
      topicInput.value.trim(),
      Number(maxInput.value) || 0,
    );
    overlay.remove();
  });
  const cancelBtn = $('button', 'ghost');
  cancelBtn.textContent = 'cancelar';
  cancelBtn.addEventListener('click', () => overlay.remove());
  footer.append(saveBtn, cancelBtn);

  panel.append(body, footer);
  overlay.append(panel);
  document.body.append(overlay);
}

function showTreeMenu(e: MouseEvent): void {
  const items: HTMLElement[] = [];

  // header
  const head = $('div', 'head');
  head.append(text('div', 'nick', client.serverName || 'vox'));
  const stats: string[] = [];
  stats.push(`${client.channels.size} canais`);
  stats.push(`${client.clients.size} conectados`);
  head.append(text('div', 'mono', stats.join(' · ')));
  items.push(head);

  items.push($('hr'));

  // create channel
  const createBtn = $('button');
  createBtn.textContent = 'criar canal';
  createBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMenu();
    showCreateChannelOverlay();
  });
  items.push(createBtn);

  // edit server (admin+)
  if (client.myGroup >= Group.Admin) {
    const editBtn = $('button');
    editBtn.textContent = 'editar servidor';
    editBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
    });
    items.push(editBtn);
  }

  const anchor = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement;
  if (anchor) openMenu(anchor, items);
}

function showCreateChannelOverlay(parentId = NO_CHANNEL): void {
  const overlay = $('div', 'settings-overlay');
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.remove();
  });

  const panel = $('div', 'settings');
  panel.style.width = '400px';
  panel.style.gridTemplateColumns = '1fr';

  const body = $('div', 'settings-body');
  body.append(text('h3', '', parentId !== NO_CHANNEL ? 'CRIAR SUB-CANAL' : 'CRIAR CANAL'));

  const nameRow = $('div', 'settings-row');
  const nameLabel = $('label');
  nameLabel.append(text('span', '', 'Nome'));
  const nameInput = $('input') as HTMLInputElement;
  nameInput.placeholder = 'ex: Sala de jogos';
  nameLabel.append(nameInput);
  nameRow.append(nameLabel);
  body.append(nameRow);

  const passRow = $('div', 'settings-row');
  const passLabel = $('label');
  passLabel.append(text('span', '', 'Senha (opcional)'));
  const passInput = $('input') as HTMLInputElement;
  passInput.type = 'password';
  passInput.placeholder = 'deixe vazio para canal aberto';
  passLabel.append(passInput);
  passRow.append(passLabel);
  body.append(passRow);

  const footer = $('div', 'settings-footer');
  const saveBtn = $('button', 'primary');
  saveBtn.textContent = 'criar';
  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    client.createChannel(name, passInput.value, parentId);
    overlay.remove();
  });
  const cancelBtn = $('button', 'ghost');
  cancelBtn.textContent = 'cancelar';
  cancelBtn.addEventListener('click', () => overlay.remove());
  footer.append(saveBtn, cancelBtn);

  panel.append(body, footer);
  overlay.append(panel);
  document.body.append(overlay);

  requestAnimationFrame(() => nameInput.focus());
}

function promptCreateChannel(): void {
  showCreateChannelOverlay();
}

// ============================================================ keyboard shortcuts =

let pttActive = false;

document.addEventListener('keydown', (e) => {
  if (view !== 'shell') return;
  if ((e.target as HTMLElement).tagName === 'INPUT') return;

  // Push-to-talk: espaco (configuravel)
  if (e.code === 'Space' && !pttActive) {
    e.preventDefault();
    pttActive = true;
    client.setPtt(true);
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && pttActive) {
    pttActive = false;
    client.setPtt(false);
  }
});

// ============================================================ init ==

async function connectTo(fav: Favorite): Promise<void> {
  view = 'shell';
  render();
  await client.connect(fav);
}

// Probe servers on browser view
async function refreshServers(): Promise<void> {
  serverList = [];
  const favs = listFavorites();
  const seen = new Set<string>();
  const controllers: AbortController[] = [];

  for (const fav of favs) {
    const addr = fav.address || '';
    if (seen.has(addr)) continue;
    seen.add(addr);
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const result = await probe(addr, ctrl.signal);
    if (result) serverList.push(...result);
  }

  if (view === 'browser') render();
}

// --------------------------------------------------------- boot --

client = new VoxClient(() => {
  if (view === 'shell') render();
});

// Initial render
render();

// Probe known servers for occupancy
void refreshServers();

// Enumerate audio devices (needs mic permission first)
void enumerateDevices();

// ------------------------------------------------- animation loop --

function tick(): void {
  // mic meter
  const micMeter = document.querySelector('[data-meter="mic"]') as HTMLElement | null;
  if (micMeter) {
    const fill = micMeter.querySelector('i');
    if (fill) {
      const pct = Math.round(client.micLevel * 100);
      fill.style.width = `${pct}%`;
      micMeter.classList.toggle('live', pct > 0);
    }
  }

  // peer VU meters
  const vuMeters = document.querySelectorAll('[data-vu]');
  for (const el of vuMeters) {
    const clientId = Number((el as HTMLElement).dataset.vu);
    const talking = client.isTalking(clientId);
    el.classList.toggle('live', talking);
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
