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

import { initNotifications, notify, requestNotificationPermission } from './notifications.js';
import { VoxClient } from './client.js';
import type { MicSettings } from './audio/microphone.js';
import { isMicTestRunning, startMicTest, stopMicTest } from './audio/mic-test.js';
import { renderBrowserView } from './browser.js';
import { exportIdentity, importIdentity, loadIdentity, resetIdentity } from './identity.js';
import {
  ChannelFlags,
  ClientFlags,
  Group,
  GROUP_NAMES,
  NO_CHANNEL,
  ChatScope,
} from '@vox/protocol';
import type { ChannelInfo, ClientInfo, GroupDef } from '@vox/protocol';
import {
  listFavorites,
  probe,
  type Favorite,
  type ServerStatus,
} from './favorites.js';
import { $, text, timeHHMM } from './ui/dom.js';
import { closeMenu, openMenu } from './ui/menu.js';
import { keyLabel, loadPttKey, savePttKey } from './ui/ptt.js';

// ------------------------------------------------------------------- state --

let client: VoxClient;
let view: 'browser' | 'shell' = 'browser';
let serverList: ServerStatus[] = [];
let settingsOpen = false;

let selectedChannelId = 0;
let selectedClientId = 0;

// ---- drag-to-move state ----
let dragClientId = 0;
let dragGhost: HTMLElement | null = null;
let dragStartY = 0;
let dragActive = false;
let dragPointerId = 0;
let inputDevices: MediaDeviceInfo[] = [];
let outputDevices: MediaDeviceInfo[] = [];

// ---------------------------------------------------------------- helpers --

// ---------------------------------------------------------------- render --

function render(): void {
  const app = document.getElementById('app')!;
  const chatInput = app.querySelector('.composer input') as HTMLInputElement | null;
  const hadFocus = chatInput && document.activeElement === chatInput;
  const savedValue = chatInput?.value ?? '';

  if (view === 'browser') {
    app.replaceChildren(renderBrowserView({ client, serverList, connectTo, rerender: render }));
  } else {
    app.replaceChildren(renderShell());
  }

  if (hadFocus && view === 'shell') {
    const newInput = app.querySelector('.composer input') as HTMLInputElement | null;
    if (newInput) {
      newInput.value = savedValue;
      newInput.focus();
    }
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

    const moderated = (ch.flags & ChannelFlags.Moderated) !== 0;
    const idx = text('span', 'idx', locked ? '🔒' : moderated ? '🎙' : '#');
    const info = $('div', 'room-info');
    info.append(text('span', 'name', ch.name));
    if (moderated) {
      const modLabel = text('span', 'topic', 'moderado');
      modLabel.style.color = 'var(--amber)';
      info.append(modLabel);
    }
    if (ch.topic) info.append(text('span', 'topic', ch.topic));
    const cap =
      ch.maxClients > 0 ? text('span', 'cap', `${members.length}/${ch.maxClients}`) : text('span', 'cap', String(members.length));
    row.append(idx, info, cap);

    row.dataset.channelId = String(ch.id);

    row.addEventListener('click', () => {
      selectedChannelId = ch.id;
      selectedClientId = 0;
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
  if (c.id === selectedClientId) row.classList.add('selected');

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
  } else {
    row.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      client.openDm(c.id);
      render();
    });
  }
  const gdef = client.groupDef(c.group);
  if (gdef.color) nick.style.color = gdef.color;
  else if (c.group >= Group.Owner) nick.style.color = 'var(--amber)';
  row.append(vu, nick);

  // rank badge — mostra se o grupo tem icone ou se nao e guest
  if (gdef.icon) {
    const iconImg = $('img') as HTMLImageElement;
    iconImg.src = gdef.icon;
    iconImg.title = gdef.name;
    iconImg.style.cssText = 'width:14px;height:14px;object-fit:contain;flex-shrink:0;';
    row.append(iconImg);
  } else if (c.group > Group.Guest) {
    const icons: Record<number, string> = { [Group.Moderator]: '⚔', [Group.Admin]: '★', [Group.Owner]: '♛' };
    const badge = text('span', 'rank', icons[c.group] || gdef.name.charAt(0).toUpperCase());
    badge.title = gdef.name;
    if (gdef.color) badge.style.color = gdef.color;
    else if (c.group === Group.Owner) badge.style.color = 'var(--amber)';
    else if (c.group === Group.Admin) badge.style.color = '#e0a040';
    else badge.style.color = 'var(--text-dim)';
    row.append(badge);
  }

  // flags
  const peerChannel = client.channels.get(c.channelId);
  const channelModerated = peerChannel ? (peerChannel.flags & ChannelFlags.Moderated) !== 0 : false;
  const hasVoice = (c.flags & ClientFlags.HasVoice) !== 0;
  const silencedByMod = channelModerated && c.group < Group.Moderator && !hasVoice;

  if (hasVoice) {
    const vf = text('span', 'flag', '🎤');
    vf.title = 'voice';
    vf.style.color = 'var(--signal)';
    row.append(vf);
  }
  if (silencedByMod) {
    const sf = text('span', 'flag', '🚫');
    sf.title = 'silenciado pela moderação';
    sf.style.opacity = '0.7';
    row.append(sf);
  }
  if (muted) row.append(text('span', 'flag', '🔇'));
  if (away) {
    const awayFlag = text('span', 'flag', 'Away');
    if (c.id === client.selfId && client.awayMessage) {
      awayFlag.textContent = `Away: ${client.awayMessage}`;
      awayFlag.title = client.awayMessage;
    }
    row.append(awayFlag);
  }
  if (noInput) row.append(text('span', 'flag', '⚠'));

  row.addEventListener('click', (e) => {
    if (c.id === client.selfId && (e.target as HTMLElement).closest('.nick')) return;
    if (selectedClientId === c.id && selectedChannelId === 0) return;
    selectedClientId = c.id;
    selectedChannelId = 0;
    render();
  });

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
      dragClientId = c.id;
      dragStartY = e.clientY;
      dragActive = false;
      dragPointerId = e.pointerId;
    });
    row.addEventListener('pointermove', (e) => {
      if (!dragClientId || dragClientId !== c.id) return;
      if (!dragActive && Math.abs(e.clientY - dragStartY) < 6) return;
      if (!dragActive) {
        dragActive = true;
        row.setPointerCapture(dragPointerId);
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
      row.classList.remove('dragging');
      if (dragActive) {
        try { row.releasePointerCapture(e.pointerId); } catch {}
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
    text('span', '', '·'),
    text('span', '', 'drop'),
    text('b', '', String(client.connection.droppedVoice)),
  );
  hdr.append(serverLabel, motd, stat);
  pane.append(hdr);

  // info panel (channel or client)
  const selCh = selectedChannelId ? client.channels.get(selectedChannelId) : null;
  const selCl = selectedClientId ? client.clients.get(selectedClientId) : null;
  if (selCh) {
    pane.append(renderChannelInfoPanel(selCh));
  } else if (selCl) {
    pane.append(renderClientInfoPanel(selCl));
  }

  // chat tabs
  const tabs = $('div', 'chat-tabs');
  const channelTab = $('button', 'chat-tab');
  channelTab.textContent = '# canal';
  if (client.activeDmTab === null) channelTab.classList.add('active');
  if (client.unread > 0 && client.activeDmTab !== null) {
    const badge = text('span', 'tab-badge', String(client.unread));
    channelTab.append(badge);
  }
  channelTab.addEventListener('click', () => {
    client.activeDmTab = null;
    client.clearUnread();
    render();
  });
  tabs.append(channelTab);

  for (const [dmId, dm] of client.dmTabs) {
    const tab = $('button', 'chat-tab');
    if (client.activeDmTab === dmId) tab.classList.add('active');
    const label = text('span', '', dm.name);
    tab.append(label);
    if (dm.unread > 0 && client.activeDmTab !== dmId) {
      const badge = text('span', 'tab-badge', String(dm.unread));
      tab.append(badge);
    }
    const close = text('span', 'tab-close', '×');
    close.addEventListener('click', (e) => { e.stopPropagation(); client.closeDm(dmId); render(); });
    tab.append(close);
    tab.addEventListener('click', () => { client.activeDmTab = dmId; dm.unread = 0; render(); });
    tabs.append(tab);
  }
  pane.append(tabs);

  // chat log
  const messages = client.activeDmTab !== null
    ? client.dmMessages(client.activeDmTab)
    : client.channelMessages();

  const log = $('div', 'log');
  for (const line of messages) {
    const row = $('div', 'line');
    if (line.senderId === 0) row.classList.add('system');
    if (line.scope === ChatScope.Private) row.classList.add('dm');
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
  if (client.activeDmTab !== null && messages.length === 0) {
    const empty = text('div', 'empty-dm', 'nenhuma mensagem ainda');
    log.append(empty);
  }
  requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
  pane.append(log);

  // composer
  const composer = $('div', 'composer');
  const input = $('input') as HTMLInputElement;
  const dmTarget = client.activeDmTab !== null ? client.dmTabs.get(client.activeDmTab) : null;
  input.placeholder = dmTarget ? `mensagem para ${dmTarget.name}…` : 'mensagem…';
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

      const mgdef = client.groupDef(m.group);
      const mNick = text('span', '', m.nickname);
      if (mgdef.color) mNick.style.color = mgdef.color;
      else if (m.group >= Group.Owner) mNick.style.color = 'var(--amber)';
      item.append(statusDot, mNick);

      if (mgdef.icon) {
        const mIcon = $('img') as HTMLImageElement;
        mIcon.src = mgdef.icon;
        mIcon.style.cssText = 'width:12px;height:12px;object-fit:contain;';
        item.append(mIcon);
      } else if (m.group > Group.Guest) {
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

function renderClientInfoPanel(c: ClientInfo): HTMLElement {
  const panel = $('div', 'channel-info');
  const gdef = client.groupDef(c.group);
  const isSelf = c.id === client.selfId;
  const ch = client.channels.get(c.channelId);
  const isOwner = client.myGroup >= Group.Owner;

  // header: icon + nickname + dismiss
  const top = $('div', 'channel-info-header');

  if (gdef.icon) {
    const icon = $('img') as HTMLImageElement;
    icon.src = gdef.icon;
    icon.style.cssText = 'width:18px;height:18px;object-fit:contain;';
    top.append(icon);
  }

  const nm = text('span', 'channel-name', c.nickname);
  if (gdef.color) nm.style.color = gdef.color;
  top.append(nm);

  if (isSelf) {
    const badge = text('span', 'label', 'voce');
    badge.style.color = 'var(--signal)';
    top.append(badge);
  }

  const dismiss = $('button', 'ghost');
  dismiss.textContent = '✕';
  dismiss.style.cssText = 'padding:2px 6px;font-size:12px;min-width:unset;margin-left:auto;';
  dismiss.addEventListener('click', () => { selectedClientId = 0; render(); });
  top.append(dismiss);
  panel.append(top);

  // info rows (TS3 style)
  const info = $('div', 'client-info-rows');

  const addRow = (label: string, value: string, color?: string) => {
    const row = $('div', 'client-info-row');
    row.append(text('span', 'client-info-label', label));
    const val = text('span', 'client-info-value', value);
    if (color) val.style.color = color;
    row.append(val);
    info.append(row);
  };

  // platform
  if (c.platform) {
    addRow('Plataforma:', c.platform);
  }

  // online since
  if (c.connectedAt > 0) {
    const elapsed = Date.now() - c.connectedAt;
    addRow('On-line desde:', formatDuration(elapsed));
  }

  // server group
  const groupRow = $('div', 'client-info-row');
  groupRow.append(text('span', 'client-info-label', 'Grupo do servidor:'));
  const groupVal = $('span', 'client-info-value');
  groupVal.style.display = 'inline-flex';
  groupVal.style.alignItems = 'center';
  groupVal.style.gap = '4px';
  if (gdef.icon) {
    const gi = $('img') as HTMLImageElement;
    gi.src = gdef.icon;
    gi.style.cssText = 'width:14px;height:14px;object-fit:contain;';
    groupVal.append(gi);
  }
  const gname = document.createTextNode(gdef.name);
  groupVal.append(gname);
  if (gdef.color) groupVal.style.color = gdef.color;
  groupRow.append(groupVal);
  info.append(groupRow);

  // channel
  if (ch) {
    addRow('Canal:', ch.name);
  }

  // status
  const muted = (c.flags & ClientFlags.MutedMic) !== 0;
  const deaf = (c.flags & ClientFlags.MutedSpeakers) !== 0;
  const away = (c.flags & ClientFlags.Away) !== 0;
  const statusParts: string[] = [];
  if (away) {
    const awayMsg = isSelf && client.awayMessage ? `Ausente: ${client.awayMessage}` : 'Ausente';
    statusParts.push(awayMsg);
  }
  if (deaf) statusParts.push('Fones de ouvido/alto-falantes silenciados');
  else if (muted) statusParts.push('Microfone silenciado');
  if (statusParts.length > 0) {
    for (const s of statusParts) {
      addRow('', s, 'var(--amber)');
    }
  }

  // fingerprint / ID (only visible to owners)
  if (c.fingerprint && isOwner) {
    addRow('ID:', c.fingerprint);
  }

  panel.append(info);

  // volume + mute controls (only for other users)
  if (!isSelf) {
    const controls = $('div', 'client-controls');

    const volLabel = text('span', 'stat-label', 'volume');
    const volSlider = $('input') as HTMLInputElement;
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '200';
    volSlider.value = String(Math.round(client.userVolume(c) * 100));
    volSlider.style.cssText = 'flex:1;accent-color:var(--amber);';
    const volVal = text('span', 'stat-value', `${volSlider.value}%`);
    volVal.style.minWidth = '40px';
    volVal.style.textAlign = 'right';
    volSlider.addEventListener('input', () => {
      const v = Number(volSlider.value) / 100;
      client.setUserVolume(c, v);
      volVal.textContent = `${volSlider.value}%`;
    });

    const volRow = $('div', 'client-vol-row');
    volRow.append(volLabel, volSlider, volVal);
    controls.append(volRow);

    const muteBtn = $('button', 'ghost');
    muteBtn.textContent = client.isUserMuted(c) ? '🔇 som desativado' : '🔊 som ativado';
    muteBtn.style.cssText = 'font-size:11px;padding:3px 8px;';
    muteBtn.addEventListener('click', () => { client.toggleUserMute(c); render(); });
    controls.append(muteBtn);

    panel.append(controls);
  }

  return panel;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} segundos`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minuto${m > 1 ? 's' : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}min`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${rh}h`;
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
    { id: 'identity', icon: '◈', label: 'Identidade' },
    { id: 'capture', icon: '🎙', label: 'Capturar' },
    { id: 'playback', icon: '🔊', label: 'Reprodução' },
    { id: 'notifications', icon: '🔔', label: 'Notificações' },
    ...(client.myGroup >= Group.Owner ? [{ id: 'groups', icon: '👥', label: 'Grupos' }] : []),
  ];
  let activeSection = 'identity';

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
    if (activeSection === 'identity') buildIdentitySection(body, buildBody);
    else if (activeSection === 'capture') buildCaptureSection(body, buildBody);
    else if (activeSection === 'playback') buildPlaybackSection(body);
    else if (activeSection === 'notifications') buildNotificationsSection(body);
    else if (activeSection === 'groups') buildGroupsSection(body, buildBody);
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

function buildIdentitySection(body: HTMLElement, rebuild: () => void): void {
  body.append(text('h3', '', 'IDENTIDADE'));
  body.append(text('span', '', 'Esta chave define quem você é para os servidores.'));

  const current = client.identity;
  const fpRow = $('div', 'settings-row');
  const fpLabel = $('label');
  fpLabel.append(text('span', '', 'Fingerprint'));
  const fp = $('input') as HTMLInputElement;
  fp.readOnly = true;
  fp.value = current?.fingerprint ?? 'identidade ainda não carregada';
  fpLabel.append(fp);
  fpRow.append(fpLabel);
  body.append(fpRow);

  const copyRow = $('div', 'settings-test');
  const copyBtn = $('button', 'ghost');
  copyBtn.textContent = 'copiar fingerprint';
  copyBtn.addEventListener('click', () => {
    if (!current?.fingerprint) return;
    navigator.clipboard?.writeText(current.fingerprint).catch(() => {});
    copyBtn.textContent = 'copiado';
  });
  copyRow.append(copyBtn);
  body.append(copyRow);

  body.append($('hr'));

  const exportRow = $('div', 'settings-row');
  const exportLabel = $('label');
  exportLabel.append(text('span', '', 'Backup da identidade'));
  const backup = $('textarea') as HTMLTextAreaElement;
  backup.rows = 5;
  backup.readOnly = true;
  backup.value = exportIdentity() ?? '';
  exportLabel.append(backup);
  exportRow.append(exportLabel);
  body.append(exportRow);

  const backupActions = $('div', 'settings-test');
  const copyBackup = $('button', 'ghost');
  copyBackup.textContent = 'copiar backup';
  copyBackup.addEventListener('click', () => {
    if (!backup.value) return;
    navigator.clipboard?.writeText(backup.value).catch(() => {});
    copyBackup.textContent = 'backup copiado';
  });
  backupActions.append(copyBackup);
  body.append(backupActions);

  body.append($('hr'));

  const importRow = $('div', 'settings-row');
  const importLabel = $('label');
  importLabel.append(text('span', '', 'Importar identidade'));
  const raw = $('textarea') as HTMLTextAreaElement;
  raw.rows = 5;
  raw.placeholder = 'cole aqui um backup de identidade';
  importLabel.append(raw);
  importRow.append(importLabel);
  body.append(importRow);

  const actions = $('div', 'settings-test');
  const importBtn = $('button', 'ghost');
  importBtn.textContent = 'importar';
  importBtn.addEventListener('click', async () => {
    const ok = await importIdentity(raw.value.trim());
    if (!ok) {
      importBtn.textContent = 'backup inválido';
      return;
    }
    client.identity = await loadIdentity();
    rebuild();
  });

  const resetBtn = $('button', 'danger');
  resetBtn.textContent = 'gerar nova identidade';
  resetBtn.addEventListener('click', async () => {
    if (!confirm('Gerar outra identidade? Grupos e posse de servidores ficam ligados à identidade antiga.')) return;
    client.identity = await resetIdentity();
    rebuild();
  });

  actions.append(importBtn, resetBtn);
  body.append(actions);
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

  // PTT key binding
  if (client.mic.activation === 'ptt') {
    const pttRow = $('div', 'settings-row');
    pttRow.style.marginTop = '8px';
    const pttLabel = $('label');
    pttLabel.append(text('span', '', 'Tecla Push-to-Talk'));
    const pttBtn = $('button', 'ghost');
    pttBtn.textContent = keyLabel(pttKey);
    pttBtn.style.cssText = 'min-width:120px;text-align:center;';
    let listening = false;
    pttBtn.addEventListener('click', () => {
      if (listening) return;
      listening = true;
      pttBtn.textContent = 'pressione uma tecla...';
      pttBtn.style.color = 'var(--amber)';
      const handler = (ev: KeyboardEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
        setPttKey(ev.code);
        pttBtn.textContent = keyLabel(ev.code);
        pttBtn.style.color = '';
        listening = false;
        document.removeEventListener('keydown', handler, true);
      };
      document.addEventListener('keydown', handler, true);
    });
    pttLabel.append(pttBtn);
    pttRow.append(pttLabel);
    body.append(pttRow);
  }

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
  testBtn.textContent = isMicTestRunning() ? '■ parar teste' : '▶ teste de microfone';
  const testDot = $('div', 'dot');
  let testIv: ReturnType<typeof setInterval> | null = null;

  testBtn.addEventListener('click', async () => {
    if (isMicTestRunning()) {
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
      if (!isMicTestRunning()) { clearInterval(testIv!); testIv = null; return; }
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

  // Output device
  const devRow = $('div', 'settings-row');
  const devLabel = $('label');
  devLabel.append(text('span', '', 'Dispositivo de reprodução'));
  const devSelect = $('select') as HTMLSelectElement;
  for (const d of outputDevices) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = d.deviceId;
    opt.textContent = d.label || `saída ${d.deviceId.slice(0, 8)}`;
    if (d.deviceId === client.outputDeviceId) opt.selected = true;
    devSelect.append(opt);
  }
  if (outputDevices.length === 0) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = '';
    opt.textContent = 'padrão do sistema';
    opt.selected = true;
    devSelect.append(opt);
  }
  devSelect.addEventListener('change', () => {
    client.setOutputDevice(devSelect.value);
  });
  devLabel.append(devSelect);
  devRow.append(devLabel);
  body.append(devRow);

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
  preRange.value = String(client.preamp);
  const preVal = text('span', 'val', '+0 dB');
  preRange.addEventListener('input', () => {
    const v = Number(preRange.value);
    const db = v === 1 ? 0 : Math.round(20 * Math.log10(v));
    preVal.textContent = db >= 0 ? `+${db} dB` : `${db} dB`;
    client.setPreamp(v);
  });
  preSlider.append(preRange, preVal);
  preLabel.append(preSlider);
  preRow.append(preLabel);
  body.append(preRow);
}

function buildNotificationsSection(body: HTMLElement): void {
  body.append(text('h3', '', 'NOTIFICAÇÕES'));
  body.append(text('span', '', 'Configure notificações nativas do sistema'));

  // Enable/disable
  const enableRow = $('div', 'settings-toggle');
  const enableCheck = $('input') as HTMLInputElement;
  enableCheck.type = 'checkbox';
  enableCheck.checked = client.notificationsEnabled ?? true;
  enableCheck.addEventListener('change', () => {
    client.setNotificationsEnabled(enableCheck.checked);
  });
  enableRow.append(enableCheck, text('span', '', 'Ativar notificações nativas (menções, mensagens privadas, pokes, kick/ban)'));
  body.append(enableRow);

  // Request permission button (if not granted)
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
    const permRow = $('div', 'settings-row');
    const permBtn = $('button', 'ghost');
    permBtn.textContent = '🔒 Permitir notificações';
    permBtn.addEventListener('click', async () => {
      const granted = await requestNotificationPermission();
      if (granted) {
        permBtn.textContent = '✅ Permitido';
        permBtn.disabled = true;
      } else {
        permBtn.textContent = '❌ Negado';
      }
    });
    permRow.append(permBtn);
    body.append(permRow);
  }

  // Test notification
  const testRow = $('div', 'settings-test');
  const testBtn = $('button', 'ghost');
  testBtn.textContent = '▶ testar notificação';
  testBtn.addEventListener('click', () => {
    (async () => {
      await notify({ title: 'Vox Test', body: 'Notificação de teste funcionando!', tag: 'test' });
    })();
  });
  testRow.append(testBtn);
  body.append(testRow);
}

function buildGroupsSection(body: HTMLElement, rebuild: () => void): void {
  body.append(text('h3', '', 'GRUPOS DO SERVIDOR'));
  body.append(text('span', '', 'Configure nome, cor e ícone dos grupos'));

  for (const def of client.groupDefs) {
    const card = $('div', 'group-card');

    // icon area
    const iconArea = $('div', 'group-icon-area');
    if (def.icon) {
      const img = $('img') as HTMLImageElement;
      img.src = def.icon;
      img.style.cssText = 'width:32px;height:32px;object-fit:contain;border-radius:var(--r);';
      iconArea.append(img);
    } else {
      const placeholder = $('div', 'group-icon-placeholder');
      placeholder.textContent = def.name.charAt(0).toUpperCase();
      iconArea.append(placeholder);
    }

    const iconBtn = $('button', 'ghost');
    iconBtn.textContent = def.icon ? 'trocar' : 'ícone';
    iconBtn.style.cssText = 'padding:2px 8px;font-size:11px;';
    iconBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/gif,image/webp';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file || file.size > 32 * 1024) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUri = reader.result as string;
          client.setGroupDef(def.id, def.name, dataUri, def.color);
          setTimeout(rebuild, 200);
        };
        reader.readAsDataURL(file);
      });
      input.click();
    });

    const removeIconBtn = $('button', 'ghost danger');
    removeIconBtn.textContent = '✕';
    removeIconBtn.style.cssText = 'padding:2px 6px;font-size:10px;min-width:unset;';
    removeIconBtn.addEventListener('click', () => {
      client.setGroupDef(def.id, def.name, '', def.color);
      setTimeout(rebuild, 200);
    });

    const iconBtns = $('div', '');
    iconBtns.style.cssText = 'display:flex;gap:4px;';
    iconBtns.append(iconBtn);
    if (def.icon) iconBtns.append(removeIconBtn);
    iconArea.append(iconBtns);
    card.append(iconArea);

    // info area
    const infoArea = $('div', 'group-info-area');

    const nameRow = $('div', 'settings-row');
    const nameLabel = $('label');
    nameLabel.append(text('span', '', 'Nome'));
    const nameInput = $('input') as HTMLInputElement;
    nameInput.value = def.name;
    nameInput.placeholder = 'Nome do grupo';
    nameLabel.append(nameInput);
    nameRow.append(nameLabel);
    infoArea.append(nameRow);

    const colorRow = $('div', '');
    colorRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
    const colorLabel = text('span', '', 'Cor');
    colorLabel.style.cssText = 'font-size:12px;color:var(--text-dim);';
    const colorInput = $('input') as HTMLInputElement;
    colorInput.type = 'color';
    colorInput.value = def.color || '#ebe5dc';
    colorInput.style.cssText = 'width:32px;height:28px;padding:2px;border:1px solid var(--line);background:var(--ink-900);border-radius:var(--r);cursor:pointer;';

    const colorClear = $('button', 'ghost');
    colorClear.textContent = 'padrão';
    colorClear.style.cssText = 'padding:2px 8px;font-size:11px;';
    colorClear.addEventListener('click', () => {
      colorInput.value = '#ebe5dc';
      client.setGroupDef(def.id, nameInput.value.trim() || def.name, def.icon, '');
      setTimeout(rebuild, 200);
    });

    const preview = text('span', '', def.name);
    preview.style.cssText = `font-weight:600;font-size:13px;color:${def.color || 'var(--text)'};`;
    colorRow.append(colorLabel, colorInput, colorClear, preview);
    infoArea.append(colorRow);

    // save button
    const saveBtn = $('button', 'primary');
    saveBtn.textContent = 'salvar';
    saveBtn.style.cssText = 'padding:4px 14px;font-size:12px;justify-self:start;';
    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim() || def.name;
      const color = colorInput.value === '#ebe5dc' ? '' : colorInput.value;
      client.setGroupDef(def.id, name, def.icon, color);
      setTimeout(rebuild, 200);
    });
    infoArea.append(saveBtn);

    card.append(infoArea);

    // power level label
    const powerLabel = text('span', 'label', `nível ${def.id}`);
    powerLabel.style.cssText = 'position:absolute;top:8px;right:10px;';
    card.append(powerLabel);

    body.append(card);
  }
}

// ============================================================ context menus --

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
    const tgdef = client.groupDef(target.group);
    if (tgdef.icon) {
      const iconImg = $('img') as HTMLImageElement;
      iconImg.src = tgdef.icon;
      iconImg.title = tgdef.name;
      iconImg.style.cssText = 'width:16px;height:16px;object-fit:contain;';
      nickRow.append(iconImg);
    } else {
      const icons: Record<number, string> = { [Group.Moderator]: '⚔', [Group.Admin]: '★', [Group.Owner]: '♛' };
      const badge = text('span', 'rank', icons[target.group] || tgdef.name.charAt(0).toUpperCase());
      badge.title = tgdef.name;
      nickRow.append(badge);
    }
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

    if (isAway) {
      const backBtn = $('button');
      backBtn.textContent = 'voltar';
      backBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        client.setAway(false);
        closeMenu();
      });
      items.push(backBtn);
    } else {
      const awayWrap = $('div', '');
      awayWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:0 4px;';
      const awayInput = $('input') as HTMLInputElement;
      awayInput.placeholder = 'mensagem de ausência (opcional)';
      awayInput.style.cssText = 'font-size:12px;padding:4px 8px;';
      awayInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          client.setAway(true, awayInput.value.trim());
          closeMenu();
        }
        ev.stopPropagation();
      });
      const awayBtn = $('button');
      awayBtn.textContent = 'ausente';
      awayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        client.setAway(true, awayInput.value.trim());
        closeMenu();
      });
      awayWrap.append(awayInput, awayBtn);
      items.push(awayWrap);
    }

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

    items.push($('hr'));

    // poke
    const pokeBtn = $('button');
    pokeBtn.textContent = '👉 poke';
    pokeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      showPokeOverlay('poke', target.nickname);
    });
    items.push(pokeBtn);

    // mensagem privada
    const dmBtn = $('button');
    dmBtn.textContent = '✉ mensagem privada';
    dmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      client.openDm(target.id);
      closeMenu();
      render();
    });
    items.push(dmBtn);

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

      const srvMuteBtn = $('button');
      const targetMuted = (target.flags & ClientFlags.MutedMic) !== 0;
      srvMuteBtn.textContent = targetMuted ? '🔇 desmutar (servidor)' : '🔇 mutar (servidor)';
      srvMuteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        client.botCommand(targetMuted ? 'unmute' : 'mute', target.nickname);
        closeMenu();
      });
      items.push(srvMuteBtn);

      // voice/devoice — only show if target's channel is moderated
      const targetCh = client.channels.get(target.channelId);
      if (targetCh && (targetCh.flags & ChannelFlags.Moderated)) {
        const hasVoice = (target.flags & ClientFlags.HasVoice) !== 0;
        const voiceBtn = $('button');
        voiceBtn.textContent = hasVoice ? '🔕 remover voice' : '🎤 dar voice';
        voiceBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          client.botCommand(hasVoice ? 'devoice' : 'voice', target.nickname);
          closeMenu();
        });
        items.push(voiceBtn);
      }

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

      const groups = client.groupDefs.filter((g) => g.id < client.myGroup);
      for (const g of groups) {
        const gBtn = $('button');
        const isCurrent = target.group === g.id;
        if (g.icon) {
          const gIcon = $('img') as HTMLImageElement;
          gIcon.src = g.icon;
          gIcon.style.cssText = 'width:14px;height:14px;object-fit:contain;';
          gBtn.append(gIcon);
        }
        gBtn.append(document.createTextNode(isCurrent ? `✓ ${g.name}` : g.name));
        if (isCurrent) {
          gBtn.style.color = 'var(--amber)';
          gBtn.disabled = true;
        }
        gBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          client.setGroup(target.id, g.id);
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

  // masspoke
  items.push($('hr'));
  const massPokeBtn = $('button');
  massPokeBtn.textContent = '👉 poke em massa';
  massPokeBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeMenu();
    showPokeOverlay('masspoke');
  });
  items.push(massPokeBtn);

  // moderator actions
  if (client.myGroup >= Group.Moderator) {
    items.push($('hr'));

    // moderate channel
    const modBtn = $('button');
    modBtn.textContent = '🎙 moderação';
    modBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      showModerateOverlay(ch);
    });
    items.push(modBtn);

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

    // masspush — move users to/from this channel
    const otherChannels = [...client.channels.values()].filter((c) => c.id !== ch.id);
    if (otherChannels.length > 0) {
      // move everyone FROM this channel to another
      const { toggle: fromToggle, sub: fromSub } = collapsible('mover deste canal para');
      items.push(fromToggle);
      for (const dest of otherChannels) {
        const destBtn = $('button');
        destBtn.textContent = dest.name;
        destBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          client.botCommand('masspush', dest.name, ch.name);
          closeMenu();
        });
        fromSub.firstElementChild!.append(destBtn);
      }
      items.push(fromSub);
    }

    // move ALL users from the entire server to this channel
    const pullAllBtn = $('button');
    pullAllBtn.textContent = `mover todos do servidor para ${ch.name}`;
    pullAllBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      client.botCommand('masspush', ch.name);
      closeMenu();
    });
    items.push(pullAllBtn);

    // mass kick — expulsa todos do servidor
    const massKickBtn = $('button', 'danger');
    massKickBtn.textContent = 'expulsar todos do servidor';
    massKickBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      client.botCommand('masskick');
      closeMenu();
    });
    items.push(massKickBtn);

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

function showPokeOverlay(command: 'poke' | 'masspoke', targetNick?: string): void {
  const overlay = $('div', 'settings-overlay');
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.remove();
  });

  const panel = $('div', 'settings');
  panel.style.width = '380px';
  panel.style.height = 'auto';
  panel.style.gridTemplateColumns = '1fr';

  const body = $('div', 'settings-body');
  body.style.padding = '20px';

  const titleText = command === 'poke'
    ? `👉 POKE: ${targetNick}`
    : '👉 POKE EM MASSA';
  const title = text('h3', '', titleText);
  title.style.cssText = 'margin:0 0 4px;font-size:13px;letter-spacing:0.1em;color:var(--amber);';
  body.append(title);

  if (command === 'masspoke') {
    const hint = text('div', '', 'Todos os usuários do servidor serão cutucados.');
    hint.style.cssText = 'font-size:12px;color:var(--text-dim);margin-bottom:12px;';
    body.append(hint);
  }

  const msgLabel = text('label', 'label', 'MENSAGEM (OPCIONAL)');
  msgLabel.style.cssText = 'display:block;margin-bottom:6px;margin-top:12px;';
  body.append(msgLabel);

  const msgInput = $('textarea') as HTMLTextAreaElement;
  msgInput.placeholder = 'escreva uma mensagem…';
  msgInput.rows = 3;
  msgInput.style.cssText = 'resize:vertical;min-height:60px;';
  body.append(msgInput);

  const btnRow = $('div', '');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px;';

  const cancelBtn = $('button', 'ghost');
  cancelBtn.textContent = 'cancelar';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const sendBtn = $('button', 'primary');
  sendBtn.textContent = 'enviar poke';
  sendBtn.addEventListener('click', () => {
    const msg = msgInput.value.trim();
    if (command === 'poke' && targetNick) {
      client.botCommand('poke', targetNick, ...(msg ? [msg] : []));
    } else {
      client.botCommand('masspoke', ...(msg ? [msg] : []));
    }
    overlay.remove();
  });

  btnRow.append(cancelBtn, sendBtn);
  body.append(btnRow);

  panel.append(body);
  overlay.append(panel);
  document.body.append(overlay);

  msgInput.focus();
}

function showBanListOverlay(): void {
  const overlay = $('div', 'settings-overlay');
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) {
      client.onBotResult = null;
      overlay.remove();
    }
  });

  const panel = $('div', 'settings');
  panel.style.width = '480px';
  panel.style.height = 'auto';
  panel.style.maxHeight = '80vh';
  panel.style.gridTemplateColumns = '1fr';

  const body = $('div', 'settings-body');
  body.style.padding = '20px';
  body.style.overflowY = 'auto';

  const title = text('h3', '', 'GERENCIAR BANS');
  title.style.cssText = 'margin:0 0 16px;font-size:13px;letter-spacing:0.1em;color:var(--amber);';
  body.append(title);

  const listContainer = $('div', '');
  listContainer.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

  const loading = text('div', 'mono', 'carregando...');
  loading.style.cssText = 'color:var(--text-dim);font-size:12px;padding:12px 0;';
  listContainer.append(loading);
  body.append(listContainer);

  client.onBotResult = (msg) => {
    listContainer.innerHTML = '';

    if (msg === 'nenhum ban ativo') {
      const empty = text('div', '', 'nenhum ban ativo');
      empty.style.cssText = 'color:var(--text-dim);font-size:13px;padding:16px 0;text-align:center;';
      listContainer.append(empty);
      return;
    }

    const lines = msg.split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length < 3) continue;
      const [fp, until, ...reasonParts] = parts;
      const reason = reasonParts.join(' ');

      const row = $('div', '');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--r);background:var(--ink-700);';

      const info = $('div', '');
      info.style.cssText = 'flex:1;min-width:0;';

      const fpEl = text('div', 'mono', fp!);
      fpEl.style.cssText = 'font-size:12px;color:var(--amber);';
      const detailEl = text('div', '', `${until} — ${reason}`);
      detailEl.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:2px;';

      info.append(fpEl, detailEl);

      const removeBtn = $('button', 'ghost');
      removeBtn.textContent = 'remover';
      removeBtn.style.cssText = 'flex:none;font-size:11px;padding:4px 8px;color:var(--danger);';
      removeBtn.addEventListener('click', () => {
        const prefix = fp!.replace('…', '');
        client.onBotResult = () => {
          row.remove();
          if (listContainer.children.length === 0) {
            const empty = text('div', '', 'nenhum ban ativo');
            empty.style.cssText = 'color:var(--text-dim);font-size:13px;padding:16px 0;text-align:center;';
            listContainer.append(empty);
          }
        };
        client.botCommand('unban', prefix);
      });

      row.append(info, removeBtn);
      listContainer.append(row);
    }

    if (listContainer.children.length === 0) {
      const empty = text('div', '', 'nenhum ban ativo');
      empty.style.cssText = 'color:var(--text-dim);font-size:13px;padding:16px 0;text-align:center;';
      listContainer.append(empty);
    }
  };

  client.botCommand('banlist');

  const btnRow = $('div', '');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:20px;';
  const closeBtn = $('button', 'ghost');
  closeBtn.textContent = 'fechar';
  closeBtn.addEventListener('click', () => {
    client.onBotResult = null;
    overlay.remove();
  });
  btnRow.append(closeBtn);
  body.append(btnRow);

  panel.append(body);
  overlay.append(panel);
  document.body.append(overlay);
}

function showModerateOverlay(ch: ChannelInfo): void {
  const overlay = $('div', 'settings-overlay');
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.remove();
  });

  const panel = $('div', 'settings');
  panel.style.width = '400px';
  panel.style.height = 'auto';
  panel.style.maxHeight = '80vh';
  panel.style.gridTemplateColumns = '1fr';

  const body = $('div', 'settings-body');
  body.style.padding = '20px';
  body.style.overflowY = 'auto';

  const title = text('h3', '', `🎙 MODERAÇÃO: ${ch.name}`);
  title.style.cssText = 'margin:0 0 16px;font-size:13px;letter-spacing:0.1em;color:var(--amber);';
  body.append(title);

  const isModerated = (ch.flags & ChannelFlags.Moderated) !== 0;

  // toggle moderation
  const toggleRow = $('div', '');
  toggleRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;';
  const toggleCheck = $('input') as HTMLInputElement;
  toggleCheck.type = 'checkbox';
  toggleCheck.checked = isModerated;
  toggleCheck.style.cssText = 'width:auto;flex:none;accent-color:var(--amber);';
  const toggleLabel = text('span', '', 'Canal moderado');
  toggleLabel.style.cssText = 'font-weight:600;font-size:14px;';
  toggleRow.append(toggleCheck, toggleLabel);
  body.append(toggleRow);

  const desc = text('div', '', 'Quando ativo, apenas Moderator+ e quem receber voice podem falar. Os outros ouvem mas não transmitem áudio.');
  desc.style.cssText = 'font-size:12px;color:var(--text-dim);margin-bottom:16px;line-height:1.5;';
  body.append(desc);

  // user list with voice checkboxes
  const listTitle = text('div', 'label', 'PERMISSÕES DE VOZ');
  listTitle.style.cssText = 'margin-bottom:8px;';
  body.append(listTitle);

  const members = client.membersOf(ch.id);
  const userList = $('div', '');
  userList.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

  const voiceChanges = new Map<string, boolean>();

  for (const m of members) {
    const isMod = m.group >= Group.Moderator;
    const hasVoice = (m.flags & ClientFlags.HasVoice) !== 0;

    const row = $('div', '');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--r);background:var(--ink-700);';

    const check = $('input') as HTMLInputElement;
    check.type = 'checkbox';
    check.style.cssText = 'width:auto;flex:none;accent-color:var(--signal);';

    if (isMod) {
      check.checked = true;
      check.disabled = true;
    } else {
      check.checked = hasVoice;
      check.addEventListener('change', () => {
        voiceChanges.set(m.nickname, check.checked);
      });
    }

    const avatar = $('span', '');
    avatar.textContent = m.nickname.charAt(0).toUpperCase();
    avatar.style.cssText = 'width:22px;height:22px;border-radius:50%;background:var(--ink-500);display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--amber);flex:none;';

    const nick = text('span', '', m.nickname);
    nick.style.cssText = 'flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const gdef = client.groupDef(m.group);
    if (gdef.color) nick.style.color = gdef.color;
    else if (m.group >= Group.Owner) nick.style.color = 'var(--amber)';

    const groupLabel = text('span', 'mono', gdef.name);
    groupLabel.style.cssText = 'color:var(--text-faint);flex:none;';

    row.append(check, avatar, nick, groupLabel);
    userList.append(row);
  }

  body.append(userList);

  // buttons
  const btnRow = $('div', '');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:20px;';

  const cancelBtn = $('button', 'ghost');
  cancelBtn.textContent = 'cancelar';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = $('button', 'primary');
  saveBtn.textContent = 'aplicar';
  saveBtn.addEventListener('click', () => {
    const wantModerated = toggleCheck.checked;
    if (wantModerated !== isModerated) {
      client.botCommand('moderate');
    }
    for (const [nick, grant] of voiceChanges) {
      client.botCommand(grant ? 'voice' : 'devoice', nick);
    }
    overlay.remove();
  });

  btnRow.append(cancelBtn, saveBtn);
  body.append(btnRow);

  panel.append(body);
  overlay.append(panel);
  document.body.append(overlay);
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

  // ban management (admin+)
  if (client.myGroup >= Group.Admin) {
    const bansBtn = $('button');
    bansBtn.textContent = 'gerenciar bans';
    bansBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      showBanListOverlay();
    });
    items.push(bansBtn);
  }

  // group management (owner)
  if (client.myGroup >= Group.Owner) {
    const groupsBtn = $('button');
    groupsBtn.textContent = 'gerenciar grupos';
    groupsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      settingsOpen = true;
      openSettings();
      // switch to groups tab after settings opens
      requestAnimationFrame(() => {
        const navBtns = document.querySelectorAll('.settings-nav button');
        for (const btn of navBtns) {
          if (btn.textContent?.includes('Grupos')) (btn as HTMLElement).click();
        }
      });
    });
    items.push(groupsBtn);
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
let pttKey = loadPttKey();

function setPttKey(code: string): void {
  pttKey = code;
  savePttKey(code);
}

document.addEventListener('keydown', (e) => {
  if (view !== 'shell') return;
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.code === pttKey && !pttActive) {
    e.preventDefault();
    pttActive = true;
    client.setPtt(true);
  }
});

document.addEventListener('keyup', (e) => {
  if (e.code === pttKey && pttActive) {
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

const pokeQueue: { from: string; message: string; stamp: number }[] = [];

function renderPokeModal(): void {
  const existing = document.querySelector('.poke-overlay');
  if (existing) existing.remove();
  if (pokeQueue.length === 0) return;

  const overlay = $('div', 'poke-overlay');
  const modal = $('div', 'poke-modal');

  // header
  const header = $('div', 'poke-header');
  const icon = $('span', 'poke-icon');
  icon.textContent = '👉';
  const title = $('span', 'poke-title');
  title.textContent = 'Poke recebido';
  header.append(icon, title);
  if (pokeQueue.length > 1) {
    const count = $('span', 'poke-count');
    count.textContent = `${pokeQueue.length}`;
    header.append(count);
  }

  // list
  const list = $('div', 'poke-list');
  for (let i = pokeQueue.length - 1; i >= 0; i--) {
    const p = pokeQueue[i]!;
    const entry = $('div', 'poke-entry');
    if (i === pokeQueue.length - 1) entry.classList.add('poke-new');

    const avatar = $('div', 'poke-avatar');
    avatar.textContent = p.from.charAt(0).toUpperCase();

    const info = $('div', 'poke-info');
    const from = $('div', 'poke-from');
    from.textContent = `${p.from} te cutucou!`;
    info.append(from);
    if (p.message) {
      const msg = $('div', 'poke-msg');
      msg.textContent = `"${p.message}"`;
      msg.style.fontStyle = 'italic';
      info.append(msg);
    }

    const time = $('span', 'poke-time');
    time.textContent = timeHHMM(p.stamp);

    entry.append(avatar, info, time);
    list.append(entry);
  }

  // footer
  const footer = $('div', 'poke-footer');
  if (pokeQueue.length > 1) {
    const clearBtn = $('button', 'ghost');
    clearBtn.textContent = 'limpar tudo';
    clearBtn.addEventListener('click', () => {
      pokeQueue.length = 0;
      overlay.remove();
    });
    footer.append(clearBtn);
  }
  const okBtn = $('button', 'primary');
  okBtn.textContent = 'OK';
  okBtn.addEventListener('click', () => {
    pokeQueue.length = 0;
    overlay.remove();
  });
  footer.append(okBtn);

  modal.append(header, list, footer);
  overlay.append(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      pokeQueue.length = 0;
      overlay.remove();
    }
  });
  document.body.append(overlay);
}

client.onPoke = (from, message) => {
  pokeQueue.push({ from, message, stamp: Date.now() });
  renderPokeModal();
};

// Inicializa notificacoes (pede permissao se necessario)
void initNotifications();

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
      const me = client.self;
      const silenced = me ? client.isVoiceSilenced(me) : false;
      const pct = silenced ? 0 : Math.round(client.micLevel * 100);
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
