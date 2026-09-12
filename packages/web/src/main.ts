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
import { VoxClient, type ChatLine } from './client.js';
import type { MicSettings } from './audio/microphone.js';
import { isMicTestRunning, micTestLevel, startMicTest, stopMicTest } from './audio/mic-test.js';
import { renderBrowserView } from './browser.js';
import { exportIdentity, importIdentity, loadIdentity, resetIdentity } from './identity.js';
import {
  BotControlAction,
  ChannelFlags,
  ClientFlags,
  DEFAULT_PERMISSIONS,
  Group,
  GROUP_NAMES,
  NO_CHANNEL,
  ChatScope,
  PERMISSION_LABELS,
  PermissionAction,
  SERVER_PRESETS,
  presetGroups,
  canonicalRespawnIn,
  parsePreset,
} from '@vox/protocol';
import type { BotStateInfo, ChannelInfo, ClientInfo, GroupDef, PlayerInfo, RespClaimInfo, RespawnCatalogItem, TemplateCategory, UserProfile } from '@vox/protocol';
import {
  listFavorites,
  probe,
  type Favorite,
  type ServerStatus,
} from './favorites.js';
import { $, text, timeHHMM } from './ui/dom.js';
import {
  iconHome, iconSettings, iconMic, iconMicOff,
  iconVolume, iconVolumeOff, iconBell, iconBellOff,
  iconBrandMark,
} from './ui/icons.js';
import { closeMenu, openMenu } from './ui/menu.js';
import { keyLabel, loadPttKey, savePttKey } from './ui/ptt.js';
import { isDesktopShell } from './net/connection.js';
import { createPwaInstallCard, registerPwaServiceWorker } from './pwa.js';
import { SOUND_EVENT_LABELS, SOUND_PACK_LABELS, type SoundName, type SoundPackId } from './audio/sounds.js';
import { createLocaleSelect, t, translateTree } from './i18n.js';
import { DEFAULT_PROFILE_ACCENT } from './profile.js';
import { buildProfileEditor, renderProfileCover } from './profile-editor.js';

registerPwaServiceWorker();

// ------------------------------------------------------------------- state --

let client: VoxClient;
let view: 'browser' | 'shell' = 'browser';
let serverList: ServerStatus[] = [];
let settingsOpen = false;
let refreshVisibleSettings: (() => void) | null = null;

let selectedChannelId = 0;
let selectedClientId = 0;
let selectedTool: 'statistics' | 'claims' | null = null;
let lastVoiceChannelId = 0;
type ConnectionProgressStage = 'preparing' | 'connecting' | 'authenticating' | 'channels' | 'ready';
type ConnectionStage = ConnectionProgressStage | 'error';
interface ConnectionModalState {
  run: number;
  favorite: Favorite;
  stage: ConnectionStage;
  failedAt: ConnectionProgressStage;
  detail: string;
  started: boolean;
  channelsLoaded: boolean;
}
let connectionModal: ConnectionModalState | null = null;
let connectionRun = 0;
/** Tentativa cujo shell ja foi atualizado com o snapshot completo. */
let connectionBackgroundRun = 0;
let connectionCloseTimer: ReturnType<typeof setTimeout> | null = null;
let connectionReadyTimer: ReturnType<typeof setTimeout> | null = null;
const CHANNEL_INFO_HEIGHT_KEY = 'vox.channel-info-height';
const RESP_CLAIM_DURATION_MIN = 3 * 60;
let channelInfoHeight = loadChannelInfoHeight();
const collapsedChannels = new Set<number>();
const BOT_CHANNEL_NAMES = new Set(['bot', 'hunted list online', 'up level', 'deathlist', 'transfers', 'former names']);

// ---- drag-to-move state ----
let dragClientId = 0;
let dragGhost: HTMLElement | null = null;
let dragStartY = 0;
let dragActive = false;
let dragPointerId = 0;
let dragChannelId = 0;
let dragChannelStartY = 0;
let dragChannelPointerId = 0;
let inputDevices: MediaDeviceInfo[] = [];
let outputDevices: MediaDeviceInfo[] = [];
let audioDevicesLoading = false;
let audioDevicesMessage = '';

interface AudioOutputPicker {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>;
}

/**
 * Edicoes pendentes de grupos, mantidas fora do closure para sobreviver
 * a re-renders do modal de settings. Somente aplicadas ao clicar em salvar.
 */
const groupEdits = new Map<number, { name: string; color: string; icon: string }>();

/**
 * Enquanto o usuario esta arrastando um slider, qualquer re-render destroi
 * o input e cancela o drag. Suspendemos renders ate o pointer soltar.
 */
let sliderDragging = false;
let renderPending = false;

/** Modo expandido do dock de compartilhamento. Persiste enquanto o dock existir. */
let screenDockExpanded = false;
/** Dock de compartilhamento minimizado — so mostra o header. */
let screenDockMinimized = false;
/** Tile em foco quando ha varias telas: 'self' para propria, clientId para outros. */
let focusedScreenId: 'self' | number | null = null;

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    const el = e.target as HTMLElement | null;
    if (el instanceof HTMLInputElement && el.type === 'range') {
      sliderDragging = true;
    }
  });
  const releaseDrag = (): void => {
    let needsRender = false;
    if (sliderDragging) {
      sliderDragging = false;
      needsRender = true;
    }
    if (dragActive || dragClientId || dragChannelId) {
      clearDropHighlight();
      if (dragGhost) { dragGhost.remove(); dragGhost = null; }
      dragClientId = 0;
      dragChannelId = 0;
      dragActive = false;
      needsRender = true;
    }
    if (needsRender && renderPending) {
      renderPending = false;
      render();
    }
  };
  document.addEventListener('pointerup', releaseDrag);
  document.addEventListener('pointercancel', releaseDrag);
}


// ---------------------------------------------------------------- helpers --

// ---------------------------------------------------------------- render --

function render(): void {
  if (sliderDragging || dragActive) {
    renderPending = true;
    return;
  }
  syncConnectionModal();
  syncVoiceChannelView();
  // O shell por trás do modal não precisa acompanhar cada evento do handshake.
  // Mantê-lo intacto evita flashes enquanto canais e permissões chegam.
  if (view === 'shell' && connectionModal && document.querySelector('.connection-overlay')
      && (connectionModal.stage !== 'ready' || connectionBackgroundRun === connectionModal.run)) {
    syncConnectionOverlay();
    return;
  }
  const app = document.getElementById('app')!;
  // O shell e remontado inteiro a cada mudanca de estado. Guardar o scroll da
  // arvore antes de trocar os nos evita que um clique em um channel devolva a
  // lista para o topo.
  const tree = app.querySelector('.tree');
  const treeScrollTop = tree instanceof HTMLElement ? tree.scrollTop : null;
  const chatInput = app.querySelector('.composer input') as HTMLInputElement | null;
  const hadFocus = chatInput && document.activeElement === chatInput;
  const savedValue = chatInput?.value ?? '';

  if (view === 'browser') {
    app.replaceChildren(renderBrowserView({ client, serverList, connectTo, rerender: render }));
  } else {
    app.replaceChildren(renderShell());
  }
  translateTree(app);

  if (treeScrollTop !== null) {
    const newTree = app.querySelector('.tree');
    if (newTree instanceof HTMLElement) newTree.scrollTop = treeScrollTop;
  }

  // O primeiro render de "sessão pronta" traz o snapshot completo para o
  // fundo. Depois disso, mensagens tardias do bootstrap nao podem remontar o
  // shell enquanto o modal ainda esta visivel.
  if (connectionModal?.stage === 'ready') connectionBackgroundRun = connectionModal.run;

  if (hadFocus && view === 'shell') {
    const newInput = app.querySelector('.composer input') as HTMLInputElement | null;
    if (newInput) {
      newInput.value = savedValue;
      newInput.focus();
    }
  }
  syncConnectionOverlay();
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
  translateTree(overlay);
  queueMicrotask(() => {
    (overlay.querySelector('.settings-nav button.active') as HTMLButtonElement | null)?.focus();
  });
}

function closeSettings(): void {
  const existing = document.querySelector('.settings-overlay');
  if (existing) existing.remove();
  refreshVisibleSettings = null;
  stopMicTest();
  // Descarta edicoes nao salvas de grupos quando o modal fecha, para nao
  // reaparecerem na proxima abertura.
  if (!settingsOpen) groupEdits.clear();
}

// ================================================================ shell ==

function renderShell(): HTMLElement {
  const root = $('div', 'shell');
  root.append(renderRail(), renderRooms(), renderTalk(), renderConsole());
  const dock = renderScreenDock();
  if (dock) root.append(dock);
  const installCard = createPwaInstallCard({ compact: true, dismissible: true, mobileOnly: true });
  if (installCard) {
    installCard.classList.add('pwa-install-shell');
    root.append(installCard);
  }
  return root;
}

function syncConnectionModal(): void {
  const state = connectionModal;
  if (!state || state.stage === 'error' || state.stage === 'ready') return;

  if (client.link === 'connecting') {
    state.stage = 'connecting';
    state.detail = client.detail || 'abrindo uma conexão segura…';
    return;
  }

  if (client.link === 'online') {
    if (client.channels.size === 0) {
      state.stage = 'authenticating';
      state.detail = client.serverName
        ? `acesso aceito em ${client.serverName}`
        : 'servidor respondeu; validando sua identidade';
    } else if (!state.channelsLoaded) {
      state.channelsLoaded = true;
      state.stage = 'channels';
      state.detail = `recebendo ${client.channels.size} canais e usuários…`;
      scheduleConnectionReady(state.run);
    } else if (!client.self) {
      state.stage = 'channels';
      state.detail = 'sincronizando canais e usuários…';
    } else {
      state.stage = 'ready';
      state.detail = `${client.channels.size} canais e ${client.clients.size} usuário(s) carregados`;
      scheduleConnectionModalClose(state.run);
    }
    return;
  }

  // Durante a preparação do cliente, o WebSocket ainda não foi aberto.
  // Depois que a tentativa começou, offline significa falha definitiva.
  if (state.started) {
    state.failedAt = state.stage;
    state.stage = 'error';
    state.detail = client.detail || 'não foi possível estabelecer a conexão';
  }
}

/** Mantém o modal fora do #app para que renders de estado não reiniciem sua animação. */
function syncConnectionOverlay(): void {
  const existing = document.querySelector('.connection-overlay') as HTMLElement | null;
  if (!connectionModal || view !== 'shell') {
    existing?.remove();
    return;
  }

  const stageKey = `${connectionModal.run}:${connectionModal.stage}`;
  if (!existing) {
    const overlay = renderConnectionModal(connectionModal);
    overlay.dataset.stageKey = stageKey;
    document.body.append(overlay);
    return;
  }

  // Preserve o overlay durante todo o handshake. Recria-lo a cada etapa
  // reinicia a animacao de entrada e faz o fundo parecer que esta piscando.
  if (existing.dataset.stageKey !== stageKey) {
    const next = renderConnectionModal(connectionModal);
    const nextCard = next.firstElementChild as HTMLElement | null;
    if (nextCard) {
      // A animacao de entrada pertence apenas a primeira exibicao do modal.
      nextCard.style.animation = 'none';
      existing.replaceChildren(nextCard);
    }
    existing.dataset.stageKey = stageKey;
    return;
  }

  const detail = existing.querySelector('.connection-detail');
  if (detail && detail.textContent !== connectionModal.detail) {
    detail.textContent = connectionModal.detail;
  }
}

function scheduleConnectionReady(run: number): void {
  if (connectionReadyTimer !== null) return;
  connectionReadyTimer = setTimeout(() => {
    connectionReadyTimer = null;
    const state = connectionModal;
    if (state?.run !== run || state.stage !== 'channels' || client.link !== 'online' || !client.self) return;
    state.stage = 'ready';
    state.detail = `${client.channels.size} canais e ${client.clients.size} usuário(s) carregados`;
    scheduleConnectionModalClose(run);
    render();
  }, 260);
}

function scheduleConnectionModalClose(run: number): void {
  if (connectionCloseTimer !== null) return;
  connectionCloseTimer = setTimeout(() => {
    connectionCloseTimer = null;
    if (connectionModal?.run !== run || connectionModal.stage !== 'ready') return;
    connectionModal = null;
    // O shell ja foi atualizado no primeiro estado "ready". Remover apenas o
    // overlay evita uma segunda troca visivel da parte superior da tela.
    syncConnectionOverlay();
  }, 700);
}

function clearConnectionModalTimer(): void {
  if (connectionCloseTimer !== null) {
    clearTimeout(connectionCloseTimer);
    connectionCloseTimer = null;
  }
  if (connectionReadyTimer !== null) {
    clearTimeout(connectionReadyTimer);
    connectionReadyTimer = null;
  }
}

function closeConnectionAttempt(run: number): void {
  if (connectionModal?.run !== run) return;
  connectionRun++;
  connectionBackgroundRun = 0;
  clearConnectionModalTimer();
  connectionModal = null;
  client.disconnect();
  view = 'browser';
  render();
}

function retryConnection(run: number): void {
  const state = connectionModal;
  if (!state || state.run !== run) return;
  const favorite = state.favorite;
  connectionRun++;
  connectionBackgroundRun = 0;
  clearConnectionModalTimer();
  connectionModal = null;
  client.disconnect();
  void connectTo(favorite);
}

function renderConnectionModal(state: ConnectionModalState): HTMLElement {
  const overlay = $('div', 'connection-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-live', 'polite');

  const card = $('div', 'connection-modal');
  if (state.stage === 'error') card.classList.add('error');

  const header = $('div', 'connection-header');
  const statusIcon = text('span', `connection-icon ${state.stage === 'error' ? 'failure' : ''}`, state.stage === 'error' ? '!' : '◌');
  const heading = $('div', 'connection-heading');
  heading.append(
    text('div', 'connection-eyebrow', state.stage === 'error' ? 'CONEXÃO FALHOU' : 'CONECTANDO'),
    text('h2', '', state.stage === 'error' ? 'Não foi possível entrar' : 'Entrando no servidor'),
    text('div', 'connection-target', state.favorite.label || state.favorite.address || 'servidor atual'),
  );
  header.append(statusIcon, heading);
  card.append(header);

  const steps = $('div', 'connection-steps');
  const currentIndex = Math.max(0, CONNECTION_STEPS.findIndex((step) => step.stage === (state.stage === 'error' ? state.failedAt : state.stage)));
  for (const [index, step] of CONNECTION_STEPS.entries()) {
    const completed = state.stage === 'ready' || index < currentIndex;
    const current = !completed && index === currentIndex && state.stage !== 'error';
    const row = $('div', `connection-step ${completed ? 'completed' : current ? 'current' : state.stage === 'error' && index === currentIndex ? 'failed' : ''}`.trim());
    const marker = text('span', 'connection-step-marker', completed ? '✓' : current ? '…' : state.stage === 'error' && index === currentIndex ? '×' : '·');
    row.append(marker, text('span', '', step.label));
    steps.append(row);
  }
  card.append(steps);

  const detail = text('div', 'connection-detail', state.detail);
  card.append(detail);

  const footer = $('div', 'connection-footer');
  if (state.stage === 'error') {
    const retry = $('button', 'primary');
    retry.textContent = 'tentar novamente';
    retry.addEventListener('click', () => retryConnection(state.run));
    const back = $('button', 'ghost');
    back.textContent = 'voltar';
    back.addEventListener('click', () => closeConnectionAttempt(state.run));
    footer.append(back, retry);
  } else {
    const cancel = $('button', 'ghost');
    cancel.textContent = 'cancelar';
    cancel.addEventListener('click', () => closeConnectionAttempt(state.run));
    footer.append(cancel);
  }
  card.append(footer);
  overlay.append(card);
  return overlay;
}

const CONNECTION_STEPS: readonly { stage: ConnectionProgressStage; label: string }[] = [
  { stage: 'preparing', label: 'Preparando identidade e áudio' },
  { stage: 'connecting', label: 'Conectando ao servidor' },
  { stage: 'authenticating', label: 'Autenticando acesso' },
  { stage: 'channels', label: 'Carregando canais e usuários' },
  { stage: 'ready', label: 'Sessão pronta' },
];

// ------------------------------------------------------------------- rail --

function renderRail(): HTMLElement {
  const rail = $('div', 'rail');

  rail.append(iconBrandMark());

  const home = $('button');
  home.append(iconHome());
  home.title = 'servidores';
  home.addEventListener('click', () => {
    client.disconnect();
    view = 'browser';
    render();
  });
  rail.append(home);

  const settingsBtn = $('button');
  settingsBtn.append(iconSettings());
  settingsBtn.title = 'configurações';
  settingsBtn.addEventListener('click', () => {
    settingsOpen = true;
    openSettings();
  });
  rail.append(settingsBtn);

  rail.append($('div', 'spacer'));

  const me = client.self;
  if (me) {
    const nick = $('button', 'rail-avatar');
    nick.append(renderProfileAvatar(me, 'profile-avatar-rail', true));
    nick.title = `${me.nickname} · abrir perfil`;
    nick.setAttribute('aria-label', `${me.nickname}, abrir configurações do perfil`);
    nick.addEventListener('click', () => {
      settingsOpen = true;
      openSettings();
    });
    rail.append(nick);
  }

  return rail;
}

// ------------------------------------------------------------------ rooms --

function renderRooms(): HTMLElement {
  const pane = $('div', 'rooms');

  // header
  const hdr = $('header', 'rooms-header');
  const headline = $('div', 'rooms-headline');
  headline.append(text('div', 'name', client.serverName || 'v0x'), text('span', 'label', `v${client.serverId || 1}`));
  const presence = $('div', 'rooms-presence');
  presence.append(text('span', 'presence-dot', '●'), text('span', '', `${client.clients.size} online`));
  hdr.append(headline, presence);
  hdr.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTreeMenu(e);
  });
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
  const foot = $('footer', 'rooms-footer');
  foot.setAttribute('aria-label', 'ações do servidor');
  const footActions = $('div', 'rooms-footer-actions');

  const addBtn = $('button', 'ghost');
  addBtn.textContent = '+ canal';
  addBtn.addEventListener('click', () => promptCreateChannel());
  footActions.append(addBtn);

  const disconnectBtn = $('button', 'ghost danger');
  disconnectBtn.textContent = 'sair';
  disconnectBtn.addEventListener('click', () => {
    client.disconnect();
    view = 'browser';
    render();
  });
  footActions.append(disconnectBtn);

  const channelHint = client.myGroup >= client.permissionFor(PermissionAction.MoveChannel)
    ? 'duplo clique para entrar · arraste canais para organizar'
    : 'duplo clique para entrar';
  foot.append(footActions, text('span', 'rooms-footer-hint', channelHint));
  pane.append(foot);
  return pane;
}

/** Ao entrar em outro canal, abre automaticamente o chat daquele canal. */
function syncVoiceChannelView(): void {
  const voiceChannelId = client.self?.channelId ?? 0;
  if (voiceChannelId === lastVoiceChannelId) return;
  lastVoiceChannelId = voiceChannelId;
  if (!voiceChannelId) return;

  selectedChannelId = voiceChannelId;
  selectedClientId = 0;
  selectedTool = null;
  client.activeDmTab = null;
}

function loadChannelInfoHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(CHANNEL_INFO_HEIGHT_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 160 ? Math.round(value) : null;
  } catch {
    return null;
  }
}

function renderChannelTree(parent: HTMLElement, parentId: number, depth: number): void {
  const rawChildren = client.childrenOf(parentId);
  if (depth > 0) {
    for (const ch of rawChildren) renderChannelBranch(parent, ch, depth);
    return;
  }

  const defaults = rawChildren.filter((c) => (c.flags & ChannelFlags.Default) !== 0);
  const bots = rawChildren.filter((c) => isBotChannel(c));
  const rest = rawChildren.filter((c) => !defaults.includes(c) && !bots.includes(c));

  // O canal de entrada continua no topo, sem competir com as seções abaixo.
  for (const ch of defaults) renderChannelBranch(parent, ch, depth);

  if (bots.length > 0) {
    parent.append(renderSectionHeader('BOT', bots.length, 'bot-section'));
    for (const ch of bots) renderChannelBranch(parent, ch, depth);
  }

  renderToolRows(parent);

  if (rest.length > 0) {
    parent.append(renderSectionHeader('CANAIS', rest.length));
    for (const ch of rest) renderChannelBranch(parent, ch, depth);
  }

  if (rawChildren.length === 0) {
    parent.append(text('div', 'tree-empty', 'nenhum canal disponível'));
  }
}

function renderChannelBranch(parent: HTMLElement, ch: ChannelInfo, depth: number): void {
  const members = client.membersOf(ch.id);
  const locked = (ch.flags & ChannelFlags.Password) !== 0;
  const moderated = (ch.flags & ChannelFlags.Moderated) !== 0;
  const voiceDisabled = (ch.flags & ChannelFlags.VoiceDisabled) !== 0;
  const full = ch.maxClients > 0 && members.length >= ch.maxClients;
  const children = client.childrenOf(ch.id);
  const hasChildren = children.length > 0;
  const expanded = !collapsedChannels.has(ch.id);

  const row = $('div', 'room channel-row');
  if (ch.id === client.self?.channelId) row.classList.add('here');
  if (ch.id === selectedChannelId) row.classList.add('selected');
  if (isBotChannel(ch)) row.classList.add('bot-channel');
  if (locked) row.classList.add('locked');
  if (moderated) row.classList.add('moderated');
  if (voiceDisabled) row.classList.add('voice-disabled');
  if (full) row.classList.add('full');
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.dataset.channelId = String(ch.id);
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.setAttribute('aria-label', `${ch.name}, ${members.length} usuário(s)`);
  if (ch.id === client.self?.channelId) row.setAttribute('aria-current', 'true');
  if (hasChildren) row.setAttribute('aria-expanded', String(expanded));
  if (full) row.title = 'canal lotado';

  const leading = $('span', 'room-leading');
  if (hasChildren) {
    const disclosure = $('button', 'room-disclosure');
    disclosure.type = 'button';
    disclosure.textContent = expanded ? '⌄' : '›';
    disclosure.title = expanded ? 'recolher canal' : 'expandir canal';
    disclosure.setAttribute('aria-label', disclosure.title);
    disclosure.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expanded) collapsedChannels.add(ch.id);
      else collapsedChannels.delete(ch.id);
      render();
    });
    leading.append(disclosure);
  } else {
    leading.append($('span', 'room-disclosure-placeholder'));
  }

  const glyph = isBotChannel(ch) ? '◆' : voiceDisabled ? '🔇' : locked ? '🔒' : moderated ? '◈' : '#';
  leading.append(text('span', 'idx', glyph));

  const info = $('div', 'room-info');
  info.append(text('span', 'name', ch.name));
  if (members.some((member) => isScreenSharedBy(member.id))) {
    appendScreenIndicator(info, 'alguém está compartilhando a tela neste canal');
  }
  const details: string[] = [];
  if (voiceDisabled) details.push('sem voz');
  else if (moderated) details.push('moderado');
  if (ch.topic) details.push(ch.topic);
  if (details.length > 0) info.append(text('span', 'topic', details.join(' · ')));

  const cap = ch.maxClients > 0 ? `${members.length}/${ch.maxClients}` : String(members.length);
  const count = text('span', 'cap', cap);
  count.title = `${members.length} usuário(s)${ch.maxClients > 0 ? ` de ${ch.maxClients}` : ''}`;
  row.append(leading, info, count);

  const select = (): void => {
    selectedChannelId = ch.id;
    selectedClientId = 0;
    selectedTool = null;
    render();
  };
  row.addEventListener('click', select);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    }
  });
  row.addEventListener('dblclick', () => {
    if (ch.id !== client.self?.channelId) client.join(ch.id);
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showChannelMenu(e, ch);
  });

  if (client.canMoveChannel(ch)) {
    row.classList.add('movable');
    row.title = full
      ? 'canal lotado · arraste para antes/depois ou sobre outro para criar subcanal; solte no espaço vazio para raiz'
      : 'arraste para antes/depois ou sobre outro para criar subcanal; solte no espaço vazio para raiz';
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('.room-disclosure')) return;
      dragChannelId = ch.id;
      dragChannelStartY = e.clientY;
      dragChannelPointerId = e.pointerId;
      dragActive = false;
    });
    row.addEventListener('pointermove', (e) => {
      if (!dragChannelId || dragChannelId !== ch.id) return;
      if (!dragActive && Math.abs(e.clientY - dragChannelStartY) < 6) return;
      if (!dragActive) {
        dragActive = true;
        row.setPointerCapture(dragChannelPointerId);
        row.classList.add('dragging');
        dragGhost = $('div', 'drag-ghost');
        dragGhost.textContent = `# ${ch.name}`;
        document.body.append(dragGhost);
      }
      dragGhost!.style.left = `${e.clientX + 12}px`;
      dragGhost!.style.top = `${e.clientY - 14}px`;
      updateChannelDropHighlight(e.clientX, e.clientY, ch.id);
      const placement = getChannelDropPlacement(e.clientX, e.clientY, ch.id);
      const modeLabel = placement
        ? placement.mode === 'before' ? t('antes')
          : placement.mode === 'inside' ? t('dentro')
            : placement.mode === 'after' ? t('depois') : t('na raiz')
        : '';
      dragGhost!.textContent = modeLabel ? `# ${ch.name} · ${modeLabel}` : `# ${ch.name}`;
    });
    row.addEventListener('pointerup', (e) => {
      if (!dragChannelId || dragChannelId !== ch.id) return;
      row.classList.remove('dragging');
      if (dragActive) {
        try { row.releasePointerCapture(e.pointerId); } catch {}
        if (dragGhost) dragGhost.style.display = 'none';
        const placement = getChannelDropPlacement(e.clientX, e.clientY, ch.id);
        if (placement) client.moveChannel(ch.id, placement.parentId, placement.beforeChannelId);
        clearDropHighlight();
      }
      if (dragGhost) { dragGhost.remove(); dragGhost = null; }
      dragChannelId = 0;
      dragActive = false;
      if (renderPending) { renderPending = false; render(); }
    });
    row.addEventListener('lostpointercapture', () => {
      if (dragChannelId === ch.id) {
        row.classList.remove('dragging');
        clearDropHighlight();
        if (dragGhost) { dragGhost.remove(); dragGhost = null; }
        dragChannelId = 0;
        dragActive = false;
        if (renderPending) { renderPending = false; render(); }
      }
    });
  }

  parent.append(row);
  if (!expanded) return;
  for (const member of members) parent.append(renderPeer(member));
  renderChannelTree(parent, ch.id, depth + 1);
}

function isBotChannel(ch: ChannelInfo): boolean {
  return BOT_CHANNEL_NAMES.has(ch.name.toLowerCase());
}

function renderSectionHeader(label: string, count: number, extraClass = ''): HTMLElement {
  const header = $('div', `section-header ${extraClass}`.trim());
  const title = text('span', 'section-label', label);
  const countLabel = text('span', 'section-count', String(count).padStart(2, '0'));
  header.append(title, countLabel);
  return header;
}

function renderToolRows(parent: HTMLElement): void {
  parent.append(renderSectionHeader('FERRAMENTAS', 2, 'tools-section'));
  const stats = renderToolRow('statistics', 'visão geral', String(client.clients.size));
  const claims = renderToolRow('claims', 'respawns reivindicados', String(client.claims.size));
  parent.append(stats, claims);
}

function renderToolRow(tool: 'statistics' | 'claims', label: string, count: string): HTMLElement {
  const row = $('div', 'room tool-channel');
  if (selectedTool === tool) row.classList.add('selected');
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.setAttribute('aria-label', `${label}, ${count}`);
  const glyph = tool === 'statistics' ? '≡' : '◇';
  row.append(text('span', 'idx', glyph));
  const info = $('div', 'room-info');
  info.append(text('span', 'name', label));
  row.append(info, text('span', 'cap', count));
  row.addEventListener('click', () => {
    selectedTool = tool;
    selectedChannelId = 0;
    selectedClientId = 0;
    client.activeDmTab = null;
    render();
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      row.click();
    }
  });
  return row;
}

/** Extrai "Main: <nome>" lower-case da descricao. Vazio se nao ha main. */
function currentMainOf(c: ClientInfo): string {
  const m = /main\s*:\s*(.+)/i.exec(c.description || '');
  return (m?.[1] || '').trim().toLowerCase();
}

/**
 * Resolve icones hospedados pelo servidor conectado.
 *
 * No navegador, `/icons/foo.png` pode parecer correto porque a pagina e o
 * servidor costumam compartilhar a origem. No Tauri, a pagina vive em
 * `tauri.localhost`; sem esta conversao o WebView procura o arquivo dentro do
 * pacote do app, em vez de buscar no dominio Vox.
 */
function serverAssetUrl(source: string): string {
  const value = source.trim();
  if (!value || /^(?:data|blob):/i.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value)) return value;

  const address = client.favorite?.address?.trim() ?? '';
  let origin = '';
  try {
    if (!address) {
      origin = isDesktopShell ? 'http://127.0.0.1:9987' : location.origin;
    } else if (/^wss?:\/\//i.test(address)) {
      origin = new URL(address.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')).origin;
    } else if (/^https?:\/\//i.test(address)) {
      origin = new URL(address).origin;
    } else {
      const host = address.replace(/\/+$/, '');
      const local = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\])(?::\d+)?$/i.test(host);
      origin = `${local || /:\d+$/.test(host) ? 'http' : 'https'}://${host}`;
    }
    return new URL(value, `${origin}/`).toString();
  } catch {
    return value;
  }
}

/**
 * Retorna o PlayerInfo cacheado apenas se ele corresponde ao Main atual
 * da descricao. Isso evita mostrar dados velhos quando o usuario troca de
 * char antes do bot ter tempo de atualizar.
 */
function playerInfoFor(c: ClientInfo): PlayerInfo | undefined {
  if (!c.fingerprint) return undefined;
  const pi = client.playerInfos.get(c.fingerprint);
  if (!pi) return undefined;
  const wanted = currentMainOf(c);
  if (!wanted) return undefined;
  if (pi.name.toLowerCase() !== wanted) return undefined;
  return pi;
}

function isScreenSharedBy(clientId: number): boolean {
  return client.screen.isLive(clientId);
}

function appendScreenIndicator(parent: HTMLElement, title = 'transmissão de tela ao vivo'): void {
  const dot = text('span', 'screen-live-dot', '●');
  dot.title = title;
  dot.setAttribute('aria-label', title);
  parent.append(dot);
}

function renderProfileAvatar(
  c: ClientInfo,
  className: string,
  showStatus = false,
  override?: UserProfile,
): HTMLElement {
  const profile = override ?? client.profileFor(c);
  const avatar = $('span', `user-avatar ${className} profile-border-${profile.border}`);
  avatar.style.setProperty('--profile-accent', profile.accent || DEFAULT_PROFILE_ACCENT);
  avatar.setAttribute('aria-label', `${t('Avatar de')} ${c.nickname}`);
  const media = $('span', 'profile-avatar-media');

  if (profile.avatar) {
    const image = $('img') as HTMLImageElement;
    image.src = profile.avatar;
    image.alt = '';
    image.draggable = false;
    image.addEventListener('error', () => {
      avatar.classList.add('profile-avatar-empty');
      media.replaceChildren(text('span', 'profile-avatar-initial', c.nickname.charAt(0).toUpperCase() || '?'));
    }, { once: true });
    media.append(image);
  } else {
    avatar.classList.add('profile-avatar-empty');
    media.append(text('span', 'profile-avatar-initial', c.nickname.charAt(0).toUpperCase() || '?'));
  }
  avatar.append(media);

  if (showStatus) {
    const away = (c.flags & ClientFlags.Away) !== 0;
    const state = away ? 'away' : 'online';
    const dot = $('span', `profile-presence-dot ${state}`);
    dot.title = t(away ? 'ausente' : 'online');
    dot.setAttribute('aria-label', dot.title);
    avatar.append(dot);
  }
  return avatar;
}

function renderUserProfileCard(
  c: ClientInfo,
  profile = client.profileFor(c),
  description = c.description,
  preview = false,
): HTMLElement {
  const card = $('article', `user-profile-card${preview ? ' preview' : ''}`);
  card.style.setProperty('--profile-accent', profile.accent || DEFAULT_PROFILE_ACCENT);
  card.setAttribute('aria-label', `${t('Perfil de')} ${c.nickname}`);

  const cover = renderProfileCover(profile);

  const content = $('div', 'user-profile-content');
  const hero = $('div', 'user-profile-hero');
  hero.append(renderProfileAvatar(c, 'profile-avatar-large', true, profile));

  const identity = $('div', 'user-profile-identity');
  const name = text('strong', 'user-profile-name', c.nickname || t('Novo usuário'));
  name.dataset.i18nSkip = '';
  const away = (c.flags & ClientFlags.Away) !== 0;
  const presence = $('div', 'user-profile-presence');
  presence.append(
    text('span', `profile-presence-inline ${away ? 'away' : 'online'}`, '●'),
    text('span', '', t(away ? 'Ausente' : 'Online agora')),
  );
  if (profile.statusText) {
    const statusCopy = text('span', 'profile-status-copy', profile.statusText);
    statusCopy.dataset.i18nSkip = '';
    identity.append(statusCopy);
  }
  identity.prepend(name, presence);
  hero.append(identity);

  const badges = $('div', 'user-profile-badges');
  const gdef = client.groupDef(c.group);
  const groupBadge = $('span', 'profile-badge group');
  if (gdef.icon) {
    const icon = $('img') as HTMLImageElement;
    icon.src = serverAssetUrl(gdef.icon);
    icon.alt = '';
    icon.onerror = () => icon.remove();
    groupBadge.append(icon);
  }
  groupBadge.append(document.createTextNode(gdef.name));
  groupBadge.dataset.i18nSkip = '';
  if (gdef.color) groupBadge.style.color = gdef.color;
  badges.append(groupBadge);

  if (c.fingerprint) {
    const verified = text('span', 'profile-badge verified', t('✓ identidade verificada'));
    verified.title = t('Identidade protegida pela chave local do v0x');
    badges.append(verified);
  }
  if (c.platform) {
    const platformBadge = text('span', 'profile-badge', c.platform);
    platformBadge.dataset.i18nSkip = '';
    badges.append(platformBadge);
  }

  const player = playerInfoFor(c);
  if (player?.name) {
    const label = [player.vocation, player.level > 0 ? `Lv. ${player.level}` : ''].filter(Boolean).join(' · ');
    const playerBadge = text('span', 'profile-badge game', `${player.name}${label ? ` · ${label}` : ''}`);
    playerBadge.dataset.i18nSkip = '';
    badges.append(playerBadge);
  }

  const about = $('div', 'user-profile-about');
  about.append(text('span', 'user-profile-kicker', t('SOBRE')));
  if (description) {
    const descriptionCopy = text('p', '', description);
    descriptionCopy.dataset.i18nSkip = '';
    about.append(descriptionCopy);
  } else {
    about.append(text('p', 'user-profile-empty', t(preview ? 'Conte um pouco sobre você ou informe seu Main.' : 'Este usuário ainda não adicionou uma apresentação.')));
  }

  const facts = $('div', 'user-profile-facts');
  const channel = client.channels.get(c.channelId);
  const channelFact = $('div');
  const channelName = text('strong', '', channel?.name ?? t('Sem canal'));
  channelName.dataset.i18nSkip = '';
  channelFact.append(text('span', '', t('CANAL')), channelName);
  const timeFact = $('div');
  timeFact.append(
    text('span', '', t('NA SESSÃO')),
    text('strong', '', c.connectedAt > 0 ? formatDuration(Date.now() - c.connectedAt) : t('agora')),
  );
  facts.append(channelFact, timeFact);

  content.append(hero, badges, about, facts);
  card.append(cover, content);
  return card;
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

  // avatar
  const avatar = renderProfileAvatar(c, 'peer-avatar');
  if (talking) avatar.classList.add('talking');
  if (muted || noInput) avatar.classList.add('muted');

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
  row.append(avatar, vu, nick);
  if (isScreenSharedBy(c.id)) appendScreenIndicator(row);

  // rank badge — mostra se o grupo tem icone ou se nao e guest
  if (gdef.icon) {
    const iconImg = $('img') as HTMLImageElement;
    iconImg.src = serverAssetUrl(gdef.icon);
    iconImg.onerror = () => iconImg.remove();
    iconImg.title = gdef.name;
    iconImg.style.cssText = 'width:14px;height:14px;object-fit:contain;flex-shrink:0;';
    row.append(iconImg);
  } else if (c.group > Group.Guest) {
    const icons: Record<number, string> = { [Group.Moderator]: '⚔', [Group.Admin]: '★', [Group.Owner]: '♛', [Group.Dono]: '♛' };
    const badge = text('span', 'rank', icons[c.group] || gdef.name.charAt(0).toUpperCase());
    badge.title = gdef.name;
    if (gdef.color) badge.style.color = gdef.color;
    else if (c.group === Group.Owner || c.group === Group.Dono) badge.style.color = 'var(--amber)';
    else if (c.group === Group.Admin) badge.style.color = '#e0a040';
    else badge.style.color = 'var(--text-dim)';
    row.append(badge);
  }

  // Char do Tibia (Main: ...) — icone da vocacao + level + online dot.
  const pInfo = playerInfoFor(c);
  if (pInfo && (pInfo.vocation || pInfo.level > 0 || pInfo.name)) {
    if (pInfo.vocation) {
      const vocIcon = $('img') as HTMLImageElement;
      vocIcon.src = serverAssetUrl(`/icons/${pInfo.vocation.toLowerCase()}.png`);
      vocIcon.alt = pInfo.vocation;
      vocIcon.title = `${pInfo.name} (${pInfo.vocation})`;
      vocIcon.className = 'peer-voc';
      vocIcon.onerror = () => vocIcon.remove();
      row.append(vocIcon);
    }
    if (pInfo.level > 0) {
      const lvl = text('span', 'peer-level', String(pInfo.level));
      lvl.title = `level ${pInfo.level}`;
      row.append(lvl);
    }
    const status = text('span', `peer-online ${pInfo.online ? 'on' : 'off'}`, '');
    status.title = pInfo.online ? 'online no Tibia' : 'offline no Tibia';
    row.append(status);
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
    selectedTool = null;
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
      if (renderPending) { renderPending = false; render(); }
    });
    row.addEventListener('lostpointercapture', () => {
      if (dragClientId === c.id) {
        row.classList.remove('dragging');
        clearDropHighlight();
        if (dragGhost) { dragGhost.remove(); dragGhost = null; }
        dragClientId = 0;
        dragActive = false;
        if (renderPending) { renderPending = false; render(); }
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
  const serverLabel = text('span', 'name', client.serverName || 'v0x');
  const motd = text('span', 'motd', client.motd || '');
  if (client.notice?.kind === 'error') motd.classList.add('warn');
  const stat = renderConnectionStatus();
  hdr.append(serverLabel, motd, stat);
  pane.append(hdr);

  if (selectedTool === 'statistics') {
    pane.append(renderStatisticsPanel());
    return pane;
  }
  if (selectedTool === 'claims') {
    pane.append(renderRespClaimsPanel());
    return pane;
  }

  // info panel (channel or client)
  const selCh = selectedChannelId ? client.channels.get(selectedChannelId) : null;
  const selCl = selectedClientId ? client.clients.get(selectedClientId) : null;
  if (selCh) {
    const infoPanel = renderChannelInfoPanel(selCh);
    if (channelInfoHeight !== null) {
      infoPanel.style.height = `${channelInfoHeight}px`;
      infoPanel.style.maxHeight = 'none';
    }
    pane.append(infoPanel, renderChannelInfoResizer());
  } else if (selCl) {
    pane.append(renderClientInfoPanel(selCl));
  }

  // chat tabs
  const tabs = $('div', 'chat-tabs');
  const channelTab = $('button', 'chat-tab');
  const currentChannel = client.self ? client.channels.get(client.self.channelId) : null;
  channelTab.textContent = `# ${currentChannel?.name ?? 'canal'}`;
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
    const dmOnline = client.clients.has(dmId);
    const dmStatus = text('span', `dm-status-dot ${dmOnline ? 'online' : 'offline'}`, '●');
    dmStatus.title = dmOnline ? 'online' : 'offline';
    tab.append(dmStatus);
    if (dm.unread > 0 && client.activeDmTab !== dmId) {
      const badge = text('span', 'tab-badge', String(dm.unread));
      tab.append(badge);
    }
    const close = text('span', 'tab-close', '×');
    close.addEventListener('click', (e) => { e.stopPropagation(); client.closeDm(dmId); render(); });
    tab.append(close);
    tab.addEventListener('click', () => {
      client.activeDmTab = dmId;
      dm.unread = 0;
      client.markDmRead(dmId);
      render();
    });
    tabs.append(tab);
  }
  pane.append(tabs);

  const activeDm = client.activeDmTab !== null ? client.dmTabs.get(client.activeDmTab) : null;
  if (activeDm && !client.clients.has(activeDm.clientId)) {
    const offline = $('div', 'dm-offline-banner');
    offline.append(
      text('span', 'dm-offline-dot', '●'),
      text('span', '', `${activeDm.name} está offline no momento.`),
    );
    pane.append(offline);
  }

  // chat log
  const isDmView = client.activeDmTab !== null;
  const dmPeerId = client.activeDmTab;
  const messages = isDmView
    ? client.dmMessages(client.activeDmTab!)
    : client.channelMessages(client.self?.channelId ?? 0);

  const log = $('div', isDmView ? 'log dm-log' : 'log');
  const readStamp = dmPeerId !== null ? (client.dmReadStamps.get(dmPeerId) ?? 0) : 0;
  for (const line of messages) {
    // Em DM view, mensagens de usuarios (nao-sistema, nao-bot) viram bolhas.
    const isSystem = line.senderId === 0;
    if (isDmView && !isSystem) {
      log.append(renderDmBubble(line, line.senderId === client.selfId, readStamp));
      continue;
    }
    const row = $('div', 'line');
    if (isSystem) row.classList.add('system');
    if (line.scope === ChatScope.Private) row.classList.add('dm');
    const isBot = line.senderId === 0 && (
      line.senderName === 'rubinot'
      || line.senderName === 'deusot'
      || line.senderName === 'deusold'
    );
    const parsed = isBot ? parseBotLine(line.text) : null;
    if (isBot) {
      row.classList.add('bot');
      if (parsed?.kind) row.classList.add(`bot-${parsed.kind}`);
      if (parsed?.side) row.classList.add(`bot-side-${parsed.side}`);
    }
    row.append(
      text('time', '', timeHHMM(line.stamp)),
      (() => {
        const body = $('span', 'body');
        if (isBot && parsed) {
          if (parsed.kind) body.append(text('span', 'bot-tag', parsed.kind));
          if (parsed.side) body.append(text('span', `bot-side bot-side-${parsed.side}-tag`, parsed.side));
          if (parsed.guild) body.append(text('span', 'bot-guild-tag', parsed.guild));
          appendBotBody(body, parsed.body);
        } else if (isBot) {
          body.append(document.createTextNode(line.text));
        } else {
          if (line.senderId !== 0) {
            body.append(text('span', 'who', line.senderName));
          }
          body.append(document.createTextNode(line.text));
        }
        return body;
      })(),
    );
    log.append(row);
  }
  if (messages.length === 0) {
    const empty = $('div', 'empty-chat');
    empty.append(
      text('div', 'empty-chat-icon', '#'),
      text('div', '', client.activeDmTab !== null ? 'nenhuma mensagem ainda' : 'sem mensagens no canal'),
      text('div', 'empty-chat-hint', 'escreva algo para começar a conversa'),
    );
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

/**
 * Atualiza só o indicador no header. O probe QUIC roda a cada dois segundos;
 * trocar o shell inteiro nesse ritmo fazia o canal aberto perder a posição do
 * scroll e produzia o flash percebido durante a conexão.
 */
function renderConnectionStatus(): HTMLElement {
  const stat = $('span', 'stat');
  fillConnectionStatus(stat);
  return stat;
}

function updateLiveConnectionStatus(): void {
  const stat = document.querySelector('.talk > header .stat');
  if (!(stat instanceof HTMLElement)) return;
  fillConnectionStatus(stat);
}

function fillConnectionStatus(stat: HTMLElement): void {
  const connection = client.connection;
  const usingQuic = connection.voiceTransport === 'quic';
  const transport = text('span', 'via', usingQuic ? 'QUIC' : 'WS');
  const voiceRtt = text('b', 'voice-rtt', usingQuic && connection.voiceRtt > 0 ? `${connection.voiceRtt}ms` : '—');
  const voiceRegion = text('span', 'voice-region', usingQuic ? (connection.voiceRegion || 'edge') : 'voz');
  const voiceQuality = text('span', `voice-quality ${connection.voiceQuality}`, voiceQualityLabel(connection.voiceQuality));
  const parts: HTMLElement[] = [
    text('span', '', 'ctrl'),
    text('b', '', `${connection.rtt}ms`),
    text('span', '', '·'),
    text('span', 'voice-label', 'voz'),
    voiceRtt,
    text('span', '', '·'),
    transport,
    text('span', '', '·'),
    voiceRegion,
    text('span', '', '·'),
    voiceQuality,
  ];

  // Jitter e perda so aparecem depois que alguem falou: antes disso seriam dois
  // zeros ocupando o header sem dizer nada.
  if (connection.rxJitterMs > 0 || connection.rxLossPct > 0) {
    parts.push(
      text('span', '', '·'),
      text('span', '', 'jit'),
      text('b', `voice-jitter${connection.rxJitterMs > 40 ? ' bad' : connection.rxJitterMs > 20 ? ' warn' : ''}`,
        `${connection.rxJitterMs.toFixed(0)}ms`),
      text('span', '', '·'),
      text('span', '', 'perda'),
      text('b', `voice-loss${connection.rxLossPct > 5 ? ' bad' : connection.rxLossPct > 1 ? ' warn' : ''}`,
        `${connection.rxLossPct.toFixed(1)}%`),
    );
  }

  parts.push(
    text('span', '', '·'),
    text('span', '', 'drop'),
    text('b', '', String(connection.droppedVoice)),
  );
  stat.replaceChildren(...parts);
}

function voiceQualityLabel(quality: string): string {
  switch (quality) {
    case 'excellent': return 'excelente';
    case 'good': return 'boa';
    case 'unstable': return 'instável';
    case 'measuring': return 'medindo';
    default: return '—';
  }
}

function renderChannelInfoResizer(): HTMLElement {
  const handle = $('div', 'channel-info-resizer');
  handle.title = 'arraste para aumentar ou diminuir a descrição';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', 'redimensionar descrição do canal');
  handle.setAttribute('aria-orientation', 'horizontal');

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const panel = handle.previousElementSibling as HTMLElement | null;
    if (!panel) return;

    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const talk = handle.parentElement?.getBoundingClientRect();
    const minHeight = 160;
    const maxHeight = Math.max(minHeight, (talk?.height ?? window.innerHeight) - 104);
    handle.classList.add('dragging');

    const move = (moveEvent: PointerEvent): void => {
      const next = Math.round(Math.min(maxHeight, Math.max(minHeight, startHeight + moveEvent.clientY - startY)));
      channelInfoHeight = next;
      panel.style.height = `${next}px`;
      panel.style.maxHeight = 'none';
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      handle.classList.remove('dragging');
      if (channelInfoHeight !== null) {
        try { window.localStorage.setItem(CHANNEL_INFO_HEIGHT_KEY, String(channelInfoHeight)); } catch {}
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  });

  handle.addEventListener('dblclick', () => {
    channelInfoHeight = null;
    try { window.localStorage.removeItem(CHANNEL_INFO_HEIGHT_KEY); } catch {}
    render();
  });

  return handle;
}

function appendChannelTopic(target: HTMLElement, topic: string): void {
  for (const line of topic.split(/\r?\n/)) {
    const row = $('div', 'channel-desc-line');
    if (!line) {
      row.textContent = '\u00a0';
      target.append(row);
      continue;
    }

    const side = /\b(FRIENDS?|HUNTEDS?)\b/i.exec(line);
    if (!side || side.index === undefined) {
      row.textContent = line;
      target.append(row);
      continue;
    }

    const sideName = side[1] ?? '';
    const kind = sideName.toLowerCase().startsWith('friend') ? 'friend' : 'hunted';
    row.classList.add(`report-${kind}`);
    row.append(
      document.createTextNode(line.slice(0, side.index)),
      text('span', 'report-side', sideName),
      document.createTextNode(line.slice(side.index + sideName.length)),
    );
    target.append(row);
  }
}

function renderChannelInfoPanel(ch: ChannelInfo): HTMLElement {
  const panel = $('div', 'channel-info');
  const members = client.membersOf(ch.id);
  const isHere = ch.id === client.self?.channelId;

  // top row: name + join button
  const top = $('div', 'channel-info-header');
  const locked = (ch.flags & ChannelFlags.Password) !== 0;
  const voiceDisabled = (ch.flags & ChannelFlags.VoiceDisabled) !== 0;
  const icon = text('span', 'channel-icon', voiceDisabled ? '🔇' : locked ? '🔒' : '#');
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
    appendChannelTopic(desc, ch.topic);
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
  if (voiceDisabled) flags.push('Sem voz');
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
      if (isScreenSharedBy(m.id)) appendScreenIndicator(item);

      if (mgdef.icon) {
        const mIcon = $('img') as HTMLImageElement;
        mIcon.src = serverAssetUrl(mgdef.icon);
        mIcon.onerror = () => mIcon.remove();
        mIcon.style.cssText = 'width:12px;height:12px;object-fit:contain;';
        item.append(mIcon);
      } else if (m.group > Group.Guest) {
        const icons: Record<number, string> = { [Group.Moderator]: '⚔', [Group.Admin]: '★', [Group.Owner]: '♛', [Group.Dono]: '♛' };
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
  const panel = $('div', 'channel-info profile-panel');
  const isSelf = c.id === client.selfId;
  const ch = client.channels.get(c.channelId);
  const isDono = client.myGroup >= Group.Dono;

  const top = $('div', 'profile-panel-toolbar');
  if (isSelf) {
    const edit = $('button', 'ghost');
    edit.textContent = 'editar meu perfil';
    edit.addEventListener('click', () => {
      settingsOpen = true;
      openSettings();
    });
    top.append(edit);
  }

  const dismiss = $('button', 'ghost');
  dismiss.textContent = '✕';
  dismiss.title = 'fechar perfil';
  dismiss.setAttribute('aria-label', 'Fechar perfil');
  dismiss.addEventListener('click', () => { selectedClientId = 0; render(); });
  top.append(dismiss);
  panel.append(top, renderUserProfileCard(c));

  // Detalhes técnicos da sessão ficam separados do cartão público.
  const info = $('div', 'client-info-rows');
  info.append(text('span', 'user-profile-kicker', 'DETALHES DA SESSÃO'));

  const addRow = (label: string, value: string, color?: string) => {
    const row = $('div', 'client-info-row');
    row.append(text('span', 'client-info-label', label));
    const val = text('span', 'client-info-value', value);
    if (color) val.style.color = color;
    row.append(val);
    info.append(row);
  };

  // online since
  if (c.connectedAt > 0) {
    const elapsed = Date.now() - c.connectedAt;
    addRow('On-line desde:', formatDuration(elapsed));
  }

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

  // fingerprint / ID (only visible to Donos)
  if (c.fingerprint && isDono) {
    addRow('ID:', c.fingerprint);
  }

  panel.append(info);

  // Moderadores ainda podem corrigir a descrição de terceiros. O próprio
  // usuário edita tudo pela experiência completa de Perfil.
  const canEditDesc = c.fingerprint !== '' && !isSelf && client.myGroup >= Group.Moderator;
  if (canEditDesc) {
    const descRow = $('div', 'client-desc-edit');
    const descInput = $('input') as HTMLInputElement;
    descInput.placeholder = 'ex: Main: Pedrao Warsz';
    descInput.value = c.description ?? '';
    descInput.maxLength = 200;
    const saveBtn = $('button', 'ghost');
    saveBtn.textContent = 'salvar descrição';
    saveBtn.style.cssText = 'font-size:11px;padding:3px 8px;';
    saveBtn.addEventListener('click', () => {
      client.setClientDescription(c.fingerprint, descInput.value.trim());
    });
    descInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBtn.click();
    });
    descRow.append(descInput, saveBtn);
    panel.append(descRow);
  }

  // volume + mute controls (only for other users); botoes do bot musica caem
  // na mesma barra pra ficar tudo em uma linha compacta.
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

    // Botoes de acao ficam numa linha so, horizontais e compactos.
    const actions = $('div', 'client-actions-row');

    const muteBtn = $('button', 'ghost icon-btn');
    const muted = client.isUserMuted(c);
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.title = muted ? 'som desativado — clique para reativar' : 'som ativado — clique para mutar';
    muteBtn.addEventListener('click', () => { client.toggleUserMute(c); render(); });
    actions.append(muteBtn);

    if (c.nickname === 'music') {
      const skipBtn = $('button', 'ghost icon-btn');
      skipBtn.textContent = '⏭';
      skipBtn.title = 'pular faixa atual';
      skipBtn.addEventListener('click', () => client.say('skip', ChatScope.Private, c.id));

      const stopBtn = $('button', 'ghost icon-btn danger');
      stopBtn.textContent = '⏹';
      stopBtn.title = 'parar tudo e limpar fila';
      stopBtn.addEventListener('click', () => client.say('stop', ChatScope.Private, c.id));

      actions.append(skipBtn, stopBtn);
    }

    controls.append(actions);
    panel.append(controls);
  }

  return panel;
}

function renderRespClaimsPanel(): HTMLElement {
  const panel = $('section', 'claims-page');
  const head = $('div', 'claims-head');
  head.append(text('h2', '', 'claimed resp'));
  const active = client.claims.size;
  head.append(text('span', 'label', active === 1 ? '1 ativo' : `${active} ativos`));
  panel.append(head);

  const myClaim = [...client.claims.values()].find((c) => c.ownerId === client.selfId);

  const form = $('div', 'claim-form');
  const searchWrap = $('div', 'resp-search');
  const respawn = $('input') as HTMLInputElement;
  respawn.placeholder = 'buscar respawn';
  const searchResults = $('div', 'resp-search-results');
  const defaultHint = myClaim
    ? `voce ja tem ${myClaim.respawn} claimado; libere antes de pegar outro`
    : 'selecione um respawn da lista';
  const searchHint = text('span', 'claim-meta resp-search-hint', defaultHint);
  searchWrap.append(respawn, searchResults, searchHint);
  if (myClaim) respawn.disabled = true;

  const note = $('input') as HTMLInputElement;
  note.placeholder = 'nota opcional';

  const duration = text('span', 'claim-duration', '3h');
  duration.title = 'duração fixa do claim';

  const claimBtn = $('button', 'primary');
  claimBtn.textContent = 'claim';
  claimBtn.disabled = true;
  const updateSearch = () => {
    if (myClaim) {
      claimBtn.disabled = true;
      searchHint.textContent = defaultHint;
      searchResults.replaceChildren();
      return;
    }
    const selected = canonicalRespawnIn(client.preset, respawn.value);
    claimBtn.disabled = !selected;
    searchHint.textContent = selected ? selected : defaultHint;
    searchResults.replaceChildren();
    const query = respawn.value.trim().toLowerCase();
    if (!query || selected) return;
    const matches = client.preset.respawns.flatMap((group) => group.items
      .filter((item) => `${item.code} ${item.name}`.toLowerCase().includes(query))
      .map((item) => ({ group: group.title, item })))
      .slice(0, 8);
    if (matches.length === 0) {
      searchResults.append(text('div', 'resp-search-empty', 'nenhum respawn encontrado'));
      return;
    }
    for (const match of matches) {
      const row = $('button', 'resp-search-option');
      row.type = 'button';
      row.append(text('span', 'resp-code', match.item.code), text('strong', '', match.item.name), text('small', '', match.group));
      row.addEventListener('click', () => {
        respawn.value = match.item.name;
        updateSearch();
        note.focus();
      });
      searchResults.append(row);
    }
  };
  claimBtn.addEventListener('click', () => {
    const name = canonicalRespawnIn(client.preset, respawn.value);
    if (!name) {
      respawn.focus();
      updateSearch();
      return;
    }
    client.claimResp(name, note.value.trim(), RESP_CLAIM_DURATION_MIN);
    respawn.value = '';
    note.value = '';
    updateSearch();
  });
  respawn.addEventListener('input', updateSearch);
  respawn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') claimBtn.click();
  });
  updateSearch();
  form.append(searchWrap, note, duration, claimBtn);
  panel.append(form);

  const claims = [...client.claims.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  const occupied = $('section', 'claims-panel');
  occupied.append(text('h3', '', 'ocupados'));
  if (claims.length === 0) occupied.append(text('div', 'claims-empty', 'nenhum respawn ocupado'));
  else {
    const rows = $('div', 'claims-list');
    for (const claim of claims) rows.append(renderRespClaim(claim));
    occupied.append(rows);
  }
  panel.append(occupied);

  const catalog = $('section', 'claims-panel resp-catalog');
  catalog.append(text('h3', '', 'todos os respawns'));
  const taken = new Map(claims.map((c) => [c.respawn.toLowerCase(), c]));
  const catalogRows = $('div', 'claims-list resp-list');
  for (const group of client.preset.respawns) {
    catalogRows.append(renderRespawnCatalogGroup(group.title, group.items, taken, Boolean(myClaim)));
  }
  catalog.append(catalogRows);
  panel.append(catalog);
  return panel;
}

function renderRespClaim(claim: RespClaimInfo): HTMLElement {
  const row = $('div', 'claim-row');
  const main = $('div', 'claim-main');
  main.append(text('strong', '', claim.respawn));
  const next = claim.queue[0]?.name;
  const meta = text(
    'span',
    'claim-meta',
    `${claim.ownerName} · expira em ${formatRemaining(claim.expiresAt)}${next ? ` · next ${next}` : ''}`,
  );
  main.append(meta);
  if (claim.note) main.append(text('span', 'claim-note', claim.note));

  const canRelease = claim.ownerId === client.selfId || client.myGroup >= Group.Moderator;
  const actions = $('div', 'claim-actions');
  const queued = claim.queue.some((q) => q.clientId === client.selfId);
  if (claim.ownerId !== client.selfId) {
    const queue = $('button', 'ghost');
    queue.textContent = queued ? 'sair fila' : 'fila';
    queue.addEventListener('click', () => {
      if (queued) client.leaveRespQueue(claim.id);
      else client.joinRespQueue(claim.id);
    });
    actions.append(queue);
  }
  if (canRelease) {
    const release = $('button', 'ghost danger');
    release.textContent = 'liberar';
    release.addEventListener('click', () => client.releaseResp(claim.id));
    actions.append(release);
  }
  row.append(main, actions);
  return row;
}

function renderRespawnCatalogGroup(
  title: string,
  items: RespawnCatalogItem[],
  taken: Map<string, RespClaimInfo>,
  alreadyHasClaim: boolean,
): HTMLElement {
  const group = $('section', 'resp-group collapsed');
  const head = $('div', 'resp-group-head');
  const arrow = text('span', 'resp-group-arrow', '▸');
  head.append(arrow, text('strong', '', title), text('span', 'label', `${items.length}`));
  head.style.cursor = 'pointer';
  head.addEventListener('click', () => {
    group.classList.toggle('collapsed');
    arrow.textContent = group.classList.contains('collapsed') ? '▸' : '▾';
  });
  group.append(head);
  const body = $('div', 'resp-group-body');
  for (const item of items) {
    body.append(renderRespawnCatalogRow(item, taken.get(item.name.toLowerCase()), alreadyHasClaim));
  }
  group.append(body);
  return group;
}

function renderRespawnCatalogRow(
  item: RespawnCatalogItem,
  claim: RespClaimInfo | undefined,
  alreadyHasClaim: boolean,
): HTMLElement {
  const name = item.name;
  const row = $('div', claim ? 'claim-row occupied' : 'claim-row free');
  const main = $('div', 'claim-main');
  const title = $('div', 'resp-title');
  title.append(text('span', 'resp-code', item.code), text('strong', '', name));
  main.append(title);
  if (claim) {
    const next = claim.queue[0]?.name ?? 'sem fila';
    main.append(text('span', 'claim-meta', `${claim.ownerName} · next ${next} · ${formatRemaining(claim.expiresAt)}`));
  } else {
    main.append(text('span', 'claim-meta', 'livre'));
  }
  const action = $('button', claim ? 'ghost' : 'primary');
  action.textContent = claim ? 'fila' : 'claim';
  if (!claim && alreadyHasClaim) {
    action.disabled = true;
    action.title = 'voce ja tem um respawn claimado';
  }
  action.addEventListener('click', () => {
    if (claim) client.joinRespQueue(claim.id);
    else client.claimResp(name, '', RESP_CLAIM_DURATION_MIN);
  });
  row.append(main, action);
  return row;
}

function buildBotSection(body: HTMLElement, rebuild: () => void): void {
  if (client.botState === null) client.getBotState();
  const state = client.botState;

  const provider = client.preset.bot.provider;
  body.append(text('h3', '', provider === 'none' ? 'BOT' : `BOT ${provider.toUpperCase()}`));

  if (!state) {
    body.append(text('span', '', 'Carregando configuração...'));
    return;
  }

  const status = $('div', 'settings-row');
  const running = state.running;
  const starting = state.starting;
  status.append(
    text('span', `bot-status ${starting ? 'bot-pending' : running ? 'bot-on' : 'bot-off'}`, `estado: ${starting ? 'sincronizando...' : running ? 'ativo' : 'parado'}`),
  );
  if (starting) {
    status.append(text('span', 'settings-hint bot-sync-hint', 'validando world, guilds e canais...'));
  }
  body.append(status);
  if (!starting && state.error) {
    body.append(text('div', 'error bot-error', `ultima tentativa: ${state.error}`));
  }

  // ---- config -----------------------------------------------------------
  const cfgHeader = text('h3', '', 'CONEXAO');
  cfgHeader.style.cssText = 'margin-top:14px;';
  body.append(cfgHeader);

  const worldInput = $('input') as HTMLInputElement;
  worldInput.placeholder = 'ex: Vesperia';
  worldInput.value = state.world;
  worldInput.disabled = starting;

  const channelInput = $('input') as HTMLInputElement;
  channelInput.value = state.channelName || 'bot';
  channelInput.disabled = starting;

  const intervalInput = $('input') as HTMLInputElement;
  intervalInput.type = 'number';
  intervalInput.min = '10';
  intervalInput.step = '5';
  intervalInput.value = String(Math.max(Math.round(state.intervalMs / 1000), 10));
  intervalInput.disabled = starting;

  const grid = $('div', 'bot-grid');
  grid.append(
    botField('world', worldInput),
    botField('canal', channelInput),
    botField('intervalo (s)', intervalInput),
  );
  body.append(grid);

  // ---- alertas por evento ----------------------------------------------
  const alertsHeader = text('h3', '', 'ALERTAS');
  alertsHeader.style.cssText = 'margin-top:14px;';
  body.append(alertsHeader);
  body.append(text('span', 'settings-hint', 'escolha o que o bot deve postar no canal.'));

  const enemyDeathCb = boolCheckbox(state.alertEnemyDeath);
  const friendDeathCb = boolCheckbox(state.alertFriendDeath);
  const friendLvlCb = boolCheckbox(state.alertFriendLevelUp);
  const enemyLvlCb = boolCheckbox(state.alertEnemyLevelUp);
  const enemyOnCb = boolCheckbox(state.alertEnemyOnline);
  const enemyOffCb = boolCheckbox(state.alertEnemyOffline);
  for (const checkbox of [enemyDeathCb, friendDeathCb, friendLvlCb, enemyLvlCb, enemyOnCb, enemyOffCb]) {
    checkbox.disabled = starting;
  }

  const alerts = $('div', 'bot-grid');
  alerts.append(
    botField('morte de inimigo', enemyDeathCb),
    botField('morte de amigo', friendDeathCb),
    botField('level up de amigo', friendLvlCb),
    botField('level up de inimigo', enemyLvlCb),
    botField('inimigo online', enemyOnCb),
    botField('inimigo offline', enemyOffCb),
  );
  body.append(alerts);

  // ---- broadcast global -----------------------------------------------
  const broadHeader = text('h3', '', 'BROADCAST');
  broadHeader.style.cssText = 'margin-top:14px;';
  body.append(broadHeader);
  body.append(text('span', 'settings-hint', 'enviar tambem para quem esta fora do canal do bot.'));

  const levelInput = $('input') as HTMLInputElement;
  levelInput.type = 'number';
  levelInput.min = '0';
  levelInput.value = String(state.globalLevelMin);
  levelInput.disabled = starting;

  const presenceInput = $('input') as HTMLInputElement;
  presenceInput.type = 'number';
  presenceInput.min = '1';
  presenceInput.value = String(Math.max(Math.round(state.presenceSummaryMs / 60_000), 1));
  presenceInput.disabled = starting;

  const deathsCb = boolCheckbox(state.globalDeaths);
  const killsCb = boolCheckbox(state.globalKills);
  const summarizeCb = boolCheckbox(state.summarizePresence);
  const enabledCb = boolCheckbox(state.enabled);
  for (const checkbox of [deathsCb, killsCb, summarizeCb, enabledCb]) checkbox.disabled = starting;

  const broad = $('div', 'bot-grid');
  broad.append(
    botField('nivel minimo (levelup global)', levelInput),
    botField('resumo presenca (min)', presenceInput),
    botField('mortes globais', deathsCb),
    botField('kills globais', killsCb),
    botField('resumir login/logout', summarizeCb),
    botField('habilitar bot', enabledCb),
  );
  body.append(broad);

  // ---- actions --------------------------------------------------------
  const actions = $('div', 'bot-actions');
  const save = $('button', 'primary');
  save.textContent = starting ? 'Sincronizando...' : 'Salvar Configuração';
  save.disabled = starting;
  save.setAttribute('aria-busy', String(starting));
  save.addEventListener('click', () => {
    const cfg: Omit<BotStateInfo, 'hunted' | 'friends' | 'friendGuilds' | 'enemyGuilds' | 'running' | 'starting' | 'error'> = {
      world: worldInput.value.trim(),
      guildName: state.guildName, // legado; guilds sao gerenciadas em listas separadas
      channelName: channelInput.value.trim() || 'bot',
      intervalMs: Math.max(Number(intervalInput.value) * 1000, 10_000),
      globalLevelMin: Math.max(Number(levelInput.value) || 0, 0),
      presenceSummaryMs: Math.max(Number(presenceInput.value) * 60_000, 60_000),
      globalDeaths: deathsCb.checked,
      globalKills: killsCb.checked,
      summarizePresence: summarizeCb.checked,
      enabled: enabledCb.checked,
      alertEnemyDeath: enemyDeathCb.checked,
      alertFriendDeath: friendDeathCb.checked,
      alertFriendLevelUp: friendLvlCb.checked,
      alertEnemyLevelUp: enemyLvlCb.checked,
      alertEnemyOnline: enemyOnCb.checked,
      alertEnemyOffline: enemyOffCb.checked,
    };
    client.updateBotConfig(cfg);
    setTimeout(rebuild, 200);
  });
  actions.append(save);

  const startBtn = $('button', 'ghost');
  startBtn.textContent = starting ? (running ? 'Reiniciando...' : 'Iniciando...') : running ? 'Reiniciar' : 'Iniciar';
  startBtn.disabled = starting;
  startBtn.setAttribute('aria-busy', String(starting));
  startBtn.addEventListener('click', () => {
    client.botControl(BotControlAction.Start);
    setTimeout(rebuild, 200);
  });
  actions.append(startBtn);

  if (running && !starting) {
    const stopBtn = $('button', 'ghost danger');
    stopBtn.textContent = 'Parar';
    stopBtn.addEventListener('click', () => {
      client.botControl(BotControlAction.Stop);
      setTimeout(rebuild, 200);
    });
    actions.append(stopBtn);
  }

  const testBtn = $('button', 'ghost');
  testBtn.textContent = 'Enviar Teste';
  testBtn.disabled = starting;
  testBtn.addEventListener('click', () => client.botControl(BotControlAction.Test));
  actions.append(testBtn);

  body.append(actions);

  // ---- guilds amigas -------------------------------------------------
  buildGuildManager(
    body,
    `GUILDS AMIGAS (${state.friendGuilds.length})`,
    'membros viram amigos; tag [GUILD] aparece nos alertas.',
    state.friendGuilds,
    BotControlAction.AddFriendGuild,
    BotControlAction.RemoveFriendGuild,
    rebuild,
  );

  // ---- guilds inimigas -----------------------------------------------
  buildGuildManager(
    body,
    `GUILDS INIMIGAS (${state.enemyGuilds.length})`,
    'todos os membros sao tratados como inimigos.',
    state.enemyGuilds,
    BotControlAction.AddEnemyGuild,
    BotControlAction.RemoveEnemyGuild,
    rebuild,
  );

  // ---- inimigos manuais (hunted) -------------------------------------
  const enemiesHeader = text('h3', '', `INIMIGOS MANUAIS (${state.hunted.length})`);
  enemiesHeader.style.cssText = 'margin-top:14px;';
  body.append(enemiesHeader);
  body.append(text('span', 'settings-hint', 'nomes soltos, sem guild associada.'));

  const addRow = $('div', 'bot-hunted-add');
  const addInput = $('input') as HTMLInputElement;
  addInput.placeholder = 'nome do jogador';
  const addBtn = $('button', 'primary');
  addBtn.textContent = 'Adicionar';
  const addAction = () => {
    const name = addInput.value.trim();
    if (!name) return;
    client.botControl(BotControlAction.AddHunted, name);
    addInput.value = '';
    setTimeout(rebuild, 200);
  };
  addBtn.addEventListener('click', addAction);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addAction();
  });
  addRow.append(addInput, addBtn);
  body.append(addRow);

  if (state.hunted.length === 0) {
    body.append(text('span', 'settings-hint', 'nenhum inimigo cadastrado.'));
  } else {
    const list = $('div', 'bot-name-list');
    for (const name of [...state.hunted].sort((a, b) => a.localeCompare(b))) {
      const row = $('div', 'bot-name-row');
      row.append(text('span', 'bot-name', name));
      const remove = $('button', 'ghost danger');
      remove.textContent = 'Remover';
      remove.addEventListener('click', () => {
        client.botControl(BotControlAction.RemoveHunted, name);
        setTimeout(rebuild, 200);
      });
      row.append(remove);
      list.append(row);
    }
    body.append(list);
  }

  // ---- amigos sincronizados ------------------------------------------
  if (state.friends.length > 0) {
    const fHeader = text('h3', '', `AMIGOS ONLINE-DB (${state.friends.length})`);
    fHeader.style.cssText = 'margin-top:14px;';
    body.append(fHeader);
    body.append(text('span', 'settings-hint', 'nomes carregados das guilds amigas.'));
    const list = $('div', 'bot-name-list');
    for (const name of [...state.friends].sort((a, b) => a.localeCompare(b))) {
      const row = $('div', 'bot-name-row');
      row.append(text('span', 'bot-name', name));
      list.append(row);
    }
    body.append(list);
  }

  // A sincronizacao afeta tambem guilds e lista manual: nenhum controle deve
  // aceitar uma segunda alteracao enquanto o servidor aplica a primeira.
  if (starting) {
    for (const control of body.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea')) {
      control.disabled = true;
    }
  }
}

function buildGuildManager(
  body: HTMLElement,
  header: string,
  hint: string,
  guilds: string[],
  addAction: BotControlAction,
  removeAction: BotControlAction,
  rebuild: () => void,
): void {
  const h = text('h3', '', header);
  h.style.cssText = 'margin-top:14px;';
  body.append(h, text('span', 'settings-hint', hint));

  const row = $('div', 'bot-hunted-add');
  const input = $('input') as HTMLInputElement;
  input.placeholder = 'nome exato da guild';
  const btn = $('button', 'primary');
  btn.textContent = 'Adicionar';
  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    client.botControl(addAction, name);
    input.value = '';
    setTimeout(rebuild, 300);
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  row.append(input, btn);
  body.append(row);

  if (guilds.length === 0) {
    body.append(text('span', 'settings-hint', 'nenhuma guild cadastrada.'));
    return;
  }
  const list = $('div', 'bot-name-list');
  for (const name of [...guilds].sort((a, b) => a.localeCompare(b))) {
    const rr = $('div', 'bot-name-row');
    const label = $('span', 'bot-name');
    label.append(text('span', 'bot-guild-tag', `[${name.toUpperCase()}]`));
    label.append(text('span', '', ` ${name}`));
    rr.append(label);
    const remove = $('button', 'ghost danger');
    remove.textContent = 'Remover';
    remove.addEventListener('click', () => {
      client.botControl(removeAction, name);
      setTimeout(rebuild, 200);
    });
    rr.append(remove);
    list.append(rr);
  }
  body.append(list);
}

function renderDmBubble(line: ChatLine, mine: boolean, peerReadStamp: number): HTMLElement {
  const row = $('div', `dm-row ${mine ? 'dm-out' : 'dm-in'}`);

  if (!mine) {
    const sender = client.clients.get(line.senderId);
    const avatar = sender
      ? renderProfileAvatar(sender, 'dm-avatar')
      : text('span', 'dm-avatar profile-avatar-initial', (line.senderName || '?').charAt(0).toUpperCase());
    row.append(avatar);
  }

  const bubble = $('div', 'dm-bubble');
  bubble.append(text('div', 'dm-text', line.text));

  const meta = $('div', 'dm-meta');
  meta.append(text('time', '', timeHHMM(line.stamp)));
  if (mine) {
    const read = line.stamp <= peerReadStamp;
    const check = text('span', `dm-check ${read ? 'read' : 'sent'}`, read ? '✓✓' : '✓');
    check.title = read ? 'lida' : 'enviada';
    meta.append(check);
  }
  bubble.append(meta);
  row.append(bubble);

  if (mine) {
    const self = client.self;
    const avatar = self
      ? renderProfileAvatar(self, 'dm-avatar dm-avatar-mine')
      : text('span', 'dm-avatar dm-avatar-mine profile-avatar-initial', '?');
    row.append(avatar);
  }
  return row;
}

interface ParsedBotLine {
  kind: string;
  side: 'amigo' | 'inimigo' | '';
  guild: string;
  body: string;
}

function parseBotLine(text: string): ParsedBotLine | null {
  // Formatos aceitos:
  //   [test] ...
  //   [presence] ...
  //   [death/amigo][GUILD] ...
  //   [levelup/inimigo] ...        (sem guild = manual)
  const m = /^\[([a-z]+)(?:\/(amigo|inimigo))?\](?:\[([^\]]+)\])?\s*(.*)$/i.exec(text);
  if (!m || !m[1]) return null;
  return {
    kind: m[1].toLowerCase(),
    side: (m[2]?.toLowerCase() ?? '') as ParsedBotLine['side'],
    guild: m[3] ?? '',
    body: m[4] ?? '',
  };
}

function appendBotBody(target: HTMLElement, body: string): void {
  // 1) `nome (lvl NNN) rest` — nome em destaque, level como badge.
  const withLvl = /^(.*?)\s\(lvl\s([^)]+)\)\s?(.*)$/.exec(body);
  if (withLvl) {
    target.append(
      text('span', 'bot-player', withLvl[1] ?? ''),
      document.createTextNode(' '),
      text('span', 'bot-level', `lvl ${withLvl[2] ?? ''}`),
    );
    if (withLvl[3]) target.append(document.createTextNode(` ${withLvl[3]}`));
    return;
  }
  // 2) levelup: `nome subiu de X para Y` — nome em destaque, numeros como badges.
  const lvlUp = /^(.*?)\ssubiu de (\d+) para (\d+)\s*$/.exec(body);
  if (lvlUp) {
    target.append(
      text('span', 'bot-player', lvlUp[1] ?? ''),
      document.createTextNode(' subiu de '),
      text('span', 'bot-level bot-level-from', lvlUp[2] ?? ''),
      document.createTextNode(' para '),
      text('span', 'bot-level bot-level-to', lvlUp[3] ?? ''),
    );
    return;
  }
  target.append(document.createTextNode(body));
}

function boolCheckbox(checked: boolean): HTMLInputElement {
  const cb = $('input') as HTMLInputElement;
  cb.type = 'checkbox';
  cb.checked = checked;
  return cb;
}

function botField(label: string, control: HTMLElement): HTMLElement {
  const wrap = $('label', 'bot-field');
  wrap.append(text('span', 'bot-field-label', label), control);
  return wrap;
}

function renderStatisticsPanel(): HTMLElement {
  const panel = $('section', 'stats-page');
  const claims = [...client.claims.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  const nextCount = claims.reduce((sum, c) => sum + c.queue.length, 0);
  const cards = $('div', 'stats-grid');
  for (const [label, value] of [
    ['clientes', String(client.clients.size)],
    ['canais', String(client.channels.size)],
    ['resp ocupados', String(claims.length)],
    ['na fila', String(nextCount)],
  ] as const) {
    const card = $('div', 'stat-card');
    card.append(text('span', 'label', label), text('strong', '', value));
    cards.append(card);
  }
  panel.append(cards);

  const occupied = $('section', 'claims-panel');
  occupied.append(text('h3', '', 'próximos claims'));
  if (claims.length === 0) {
    occupied.append(text('div', 'claims-empty', 'nenhum respawn ocupado agora'));
  } else {
    const rows = $('div', 'claims-list');
    for (const claim of claims.slice(0, 8)) rows.append(renderRespClaim(claim));
    occupied.append(rows);
  }
  panel.append(occupied);
  panel.append(renderVoiceQualityPanel());
  return panel;
}

/**
 * Qualidade da voz agora e nos ultimos minutos.
 *
 * A serie e o ponto: um numero isolado nao diz se a chamada esta piorando, e e
 * exatamente isso que se quer saber antes de culpar a internet de alguem.
 */
function renderVoiceQualityPanel(): HTMLElement {
  const panel = $('section', 'claims-panel voice-panel');
  panel.append(text('h3', '', 'qualidade da voz'));

  const connection = client.connection;
  const history = client.voiceHistory;
  if (history.length < 2) {
    panel.append(text('div', 'claims-empty', 'medindo — a série aparece depois de alguns segundos em chamada'));
    return panel;
  }

  const summary = $('div', 'voice-series');
  summary.append(
    voiceSeries('jitter', history.map((sample) => sample.jitterMs), `${connection.rxJitterMs.toFixed(0)}ms`, 40),
    voiceSeries('perda', history.map((sample) => sample.lossPct), `${connection.rxLossPct.toFixed(1)}%`, 5),
    voiceSeries('rtt voz', history.map((sample) => (sample.voiceRttMs || sample.rttMs)), `${connection.voiceRtt || connection.rtt}ms`, 120),
  );
  panel.append(summary);

  const senders = client.voiceSenders.filter((sender) => sender.receivedPackets > 0);
  if (senders.length > 0) {
    const rows = $('div', 'voice-senders');
    for (const sender of [...senders].sort((a, b) => b.jitterMs - a.jitterMs)) {
      const row = $('div', 'voice-sender');
      const who = client.clients.get(sender.clientId)?.nickname ?? `#${sender.clientId}`;
      row.append(
        text('span', 'voice-sender-name', who),
        text('span', 'voice-sender-metric', `jit ${sender.jitterMs.toFixed(0)}ms`),
        text('span', `voice-sender-metric${sender.lossPct > 5 ? ' bad' : sender.lossPct > 1 ? ' warn' : ''}`,
          `perda ${sender.lossPct.toFixed(1)}%`),
        text('span', 'voice-sender-metric', `${sender.lostPackets} perdidos`),
      );
      rows.append(row);
    }
    panel.append(rows);
  }
  return panel;
}

/**
 * Linha da serie em SVG. `reference` e o valor que ocupa o topo quando a serie
 * inteira esta abaixo dele — sem isso, uma chamada boa desenharia um serrote
 * dramatico feito de variacao de decimo de milissegundo.
 */
function voiceSeries(label: string, values: number[], current: string, reference: number): HTMLElement {
  const wrap = $('div', 'voice-serie');
  const head = $('div', 'voice-serie-head');
  head.append(text('span', 'voice-serie-label', label), text('b', '', current));
  wrap.append(head);

  const max = Math.max(reference, ...values);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;
  const points = values
    .map((value, index) => `${(index * step).toFixed(2)},${(24 - (value / max) * 24).toFixed(2)}`)
    .join(' ');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 24');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'voice-spark');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points);
  svg.append(line);
  wrap.append(svg);
  wrap.append(text('span', 'voice-serie-scale', `máx ${max.toFixed(max < 10 ? 1 : 0)}`));
  return wrap;
}

function formatRemaining(expiresAt: number): string {
  const left = Math.max(0, expiresAt - Date.now());
  const min = Math.ceil(left / 60_000);
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} segundo${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minuto${m > 1 ? 's' : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}min`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return `${d}d ${rh}h`;
}

function formatRecordingDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ----------------------------------------------------------------- console --

// ------------------------------------------------------- drag-to-move helpers --

function getDropChannel(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const room = (el as HTMLElement).closest('.room') as HTMLElement | null;
  return room?.dataset.channelId ? Number(room.dataset.channelId) : null;
}

function updateDropHighlight(x: number, y: number): void {
  clearDropHighlight();
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const room = (el as HTMLElement).closest('.room') as HTMLElement | null;
  if (room) room.classList.add('drop-target');
}

interface ChannelDropPlacement {
  parentId: number;
  beforeChannelId: number;
  mode: 'before' | 'inside' | 'after' | 'root';
}

function getNextSiblingChannelId(channelId: number, excludedChannelId = 0): number {
  const channel = client.channels.get(channelId);
  if (!channel) return NO_CHANNEL;
  const siblings = client.childrenOf(channel.parentId).filter((candidate) => candidate.id !== excludedChannelId);
  const index = siblings.findIndex((candidate) => candidate.id === channelId);
  return index >= 0 ? siblings[index + 1]?.id ?? NO_CHANNEL : NO_CHANNEL;
}

function getChannelDropPlacement(x: number, y: number, draggedChannelId: number): ChannelDropPlacement | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const channelRow = (el as HTMLElement).closest('.channel-row') as HTMLElement | null;
  if (channelRow?.dataset.channelId) {
    const targetId = Number(channelRow.dataset.channelId);
    if (targetId === draggedChannelId || isChannelDescendant(targetId, draggedChannelId)) return null;
    const target = client.channels.get(targetId);
    if (!target) return null;
    const rect = channelRow.getBoundingClientRect();
    const ratio = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
    if (ratio < 0.3) {
      return { parentId: target.parentId, beforeChannelId: target.id, mode: 'before' };
    }
    if (ratio > 0.7) {
      return {
        parentId: target.parentId,
        beforeChannelId: getNextSiblingChannelId(target.id, draggedChannelId),
        mode: 'after',
      };
    }
    return { parentId: target.id, beforeChannelId: NO_CHANNEL, mode: 'inside' };
  }
  return (el as HTMLElement).closest('.tree')
    ? { parentId: NO_CHANNEL, beforeChannelId: NO_CHANNEL, mode: 'root' }
    : null;
}

function isChannelDescendant(channelId: number, ancestorId: number): boolean {
  const seen = new Set<number>();
  let current = client.channels.get(channelId);
  while (current && current.parentId !== NO_CHANNEL && !seen.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    seen.add(current.id);
    current = client.channels.get(current.parentId);
  }
  return false;
}

function updateChannelDropHighlight(x: number, y: number, draggedChannelId: number): void {
  clearDropHighlight();
  const placement = getChannelDropPlacement(x, y, draggedChannelId);
  if (!placement) return;
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const channelRow = (el as HTMLElement).closest('.channel-row') as HTMLElement | null;
  if (channelRow?.dataset.channelId) {
    channelRow.classList.add('drop-target', `drop-${placement.mode}`);
    return;
  }
  const tree = (el as HTMLElement).closest('.tree');
  if (tree) tree.classList.add('drop-root-target');
}

function clearDropHighlight(): void {
  document.querySelectorAll('.room.drop-target').forEach((el) => {
    el.classList.remove('drop-target', 'drop-before', 'drop-inside', 'drop-after');
  });
  document.querySelectorAll('.tree.drop-root-target').forEach((el) => el.classList.remove('drop-root-target'));
}

// ----------------------------------------------------------------- console --

function renderConsole(): HTMLElement {
  const bar = $('div', 'console');

  // mic toggle
  const micBtn = $('button');
  const micMuted = (client.flags & ClientFlags.MutedMic) !== 0;
  micBtn.append(micMuted ? iconMicOff() : iconMic());
  if (micMuted) micBtn.classList.add('armed');
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

  if (client.isVoiceRecording) {
    const recording = text('span', 'recording-indicator', '● REC');
    recording.title = 'gravação de análise em andamento';
    bar.append(recording);
  }

  // divider
  bar.append($('div', 'divider'));

  // speaker toggle
  const spkBtn = $('button');
  const spkMuted = (client.flags & ClientFlags.MutedSpeakers) !== 0;
  spkBtn.append(spkMuted ? iconVolumeOff() : iconVolume());
  if (spkMuted) spkBtn.classList.add('armed');
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

  const screenBtn = $('button', 'ghost');
  screenBtn.textContent = client.screen.sharing ? '■ tela' : '▣ tela';
  screenBtn.title = client.screen.sharing ? 'parar compartilhamento de tela' : 'compartilhar tela ou janela';
  screenBtn.setAttribute('aria-label', screenBtn.title);
  if (client.screen.sharing) screenBtn.classList.add('armed');
  screenBtn.addEventListener('click', () => {
    void client.screen.toggle().then(() => {
      client.previewSound('screen');
      render();
    });
  });
  bar.append(screenBtn);

  // sound toggle
  const sndBtn = $('button', 'ghost');
  sndBtn.append(client.soundsEnabled ? iconBell() : iconBellOff());
  sndBtn.title = client.soundsEnabled ? 'silenciar avisos' : 'ativar avisos';
  sndBtn.setAttribute('aria-label', sndBtn.title);
  sndBtn.addEventListener('click', () => client.setSoundsEnabled(!client.soundsEnabled));
  bar.append(sndBtn);

  return bar;
}

interface ScreenTile {
  id: 'self' | number;
  label: string;
  stream: MediaStream;
  muted: boolean;
}

function renderScreenDock(): HTMLElement | null {
  const liveIds = [...client.screen.live];
  if (client.screen.sharing) liveIds.unshift(client.selfId);
  const remotes = [...client.screen.remotes.values()];
  if (liveIds.length === 0 && !client.screen.sharing && remotes.length === 0 && !client.screen.error && !client.screen.starting) return null;

  // Um espectador continua assinado enquanto o dock estiver visível; ao
  // minimizar, a assinatura é retirada e ele deixa de contar como audiência.
  client.screen.setVisibleScreens(screenDockMinimized && !screenDockExpanded ? [] : [...client.screen.watching]);

  const tiles: ScreenTile[] = [];
  if (client.screen.sharing && client.screen.localStream) {
    tiles.push({ id: 'self', label: 'Você', stream: client.screen.localStream, muted: true });
  }
  for (const remote of remotes) {
    const name = client.clients.get(remote.clientId)?.nickname ?? `#${remote.clientId}`;
    tiles.push({ id: remote.clientId, label: name, stream: remote.stream, muted: false });
  }

  // Auto-foco quando so ha uma tela; foco em tile que sumiu vira grid.
  if (tiles.length === 1) focusedScreenId = tiles[0]!.id;
  if (focusedScreenId !== null && !tiles.find((t) => t.id === focusedScreenId)) {
    focusedScreenId = null;
  }
  // Se tem 2+ e nada em foco, escolhe a primeira remota (senao a propria).
  if (focusedScreenId === null && tiles.length > 1) {
    const firstRemote = tiles.find((t) => t.id !== 'self');
    focusedScreenId = firstRemote?.id ?? tiles[0]!.id;
  }

  const dock = $('div', 'screen-dock');
  if (screenDockExpanded) dock.classList.add('expanded');
  if (screenDockMinimized && !screenDockExpanded) dock.classList.add('minimized');
  const head = $('div', 'screen-head');
  const focused = tiles.find((t) => t.id === focusedScreenId);
  const title = focused
    ? focused.id === 'self'
      ? 'sua tela'
      : focused.label
    : 'compartilhamento';
  head.append(text('span', 'screen-title', title || 'transmissões ao vivo'));

  // Botao minimizar/restaurar — recolhe o dock para so o header.
  const minBtn = $('button', 'ghost');
  minBtn.textContent = screenDockMinimized ? '▲' : '▼';
  minBtn.title = screenDockMinimized ? 'restaurar visualização' : 'minimizar';
  minBtn.addEventListener('click', () => {
    screenDockMinimized = !screenDockMinimized;
    render();
  });
  head.append(minBtn);

  // Botao "voltar ao grid" quando ha varios e um focado.
  if (tiles.length > 1 && !screenDockMinimized) {
    const gridBtn = $('button', 'ghost');
    gridBtn.textContent = '▦ grade';
    gridBtn.title = 'ver todas as telas em miniatura';
    gridBtn.addEventListener('click', () => {
      focusedScreenId = null;
      forceGridMode = true;
      render();
    });
    head.append(gridBtn);
  }

  if (!screenDockMinimized) {
    const expandBtn = $('button', 'ghost screen-toggle');
    expandBtn.type = 'button';
    expandBtn.textContent = screenDockExpanded ? '↙ minimizar' : '↗ expandir';
    expandBtn.title = screenDockExpanded ? 'minimizar para o canto' : 'expandir na tela';
    expandBtn.setAttribute('aria-label', expandBtn.title);
    expandBtn.addEventListener('click', () => {
      screenDockExpanded = !screenDockExpanded;
      render();
    });
    head.append(expandBtn);
  }

  if (client.screen.sharing) {
    const stop = $('button', 'ghost');
    stop.textContent = 'parar';
    stop.title = 'parar de compartilhar sua tela';
    stop.addEventListener('click', () => client.screen.stop());
    head.append(stop);
  }
  dock.append(head);

  if (liveIds.length > 0) {
    const presence = $('div', 'screen-live-presence');
    presence.append(text('div', 'screen-live-heading', 'transmissões ao vivo'));
    for (const clientId of liveIds) {
      const row = $('div', 'screen-live-row');
      const name = clientId === client.selfId
        ? 'Você'
        : client.clients.get(clientId)?.nickname ?? `#${clientId}`;
      const identity = $('div', 'screen-live-identity');
      identity.append(text('span', 'screen-live-badge', 'AO VIVO'), text('strong', '', name));
      const viewers = client.screen.viewersOf(clientId);
      if (viewers.length > 0) {
        const viewerNames = viewers.map((viewer) => viewer.nickname).join(', ');
        const viewerCopy = text('span', 'screen-viewers', `👁 ${viewers.length} · ${viewerNames}`);
        viewerCopy.title = `espectadores: ${viewerNames}`;
        identity.append(viewerCopy);
      } else {
        identity.append(text('span', 'screen-viewers', '👁 0 espectadores'));
      }
      row.append(identity);

      if (clientId === client.selfId) {
        row.append(text('span', 'screen-live-state', 'você está compartilhando'));
      } else if (client.screen.watching.has(clientId)) {
        row.append(text('span', 'screen-live-state', 'assistindo'));
        const stopWatching = $('button', 'ghost');
        stopWatching.type = 'button';
        stopWatching.textContent = 'parar de assistir';
        stopWatching.addEventListener('click', () => client.screen.stopWatching(clientId));
        row.append(stopWatching);
      } else {
        const watch = $('button', 'primary');
        watch.type = 'button';
        watch.textContent = 'assistir';
        watch.title = `assistir à transmissão de ${name}`;
        watch.addEventListener('click', () => void client.screen.watch(clientId));
        row.append(watch);
      }
      presence.append(row);
    }
    dock.append(presence);
  }

  if (client.screen.error) {
    const err = text('div', 'screen-error', client.screen.error);
    dock.append(err);
  }

  if (!screenDockMinimized || screenDockExpanded) {
    const showGrid = forceGridMode && tiles.length > 1;
    if (showGrid) {
      const grid = $('div', 'screen-grid');
      for (const t of tiles) {
        const tile = renderScreenVideo(t.id, t.label, t.stream, t.muted);
        tile.classList.add('screen-tile-thumb');
        tile.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('.screen-full')) return;
          focusedScreenId = t.id;
          forceGridMode = false;
          render();
        });
        grid.append(tile);
      }
      dock.append(grid);
    } else if (focused) {
      dock.append(renderScreenVideo(focused.id, focused.label, focused.stream, focused.muted));
      if (tiles.length > 1) {
        const strip = $('div', 'screen-thumbs');
        for (const t of tiles) {
          if (t.id === focusedScreenId) continue;
          const thumb = renderScreenVideo(t.id, t.label, t.stream, t.muted);
          thumb.classList.add('screen-tile-thumb');
          thumb.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.screen-full')) return;
            focusedScreenId = t.id;
            render();
          });
          strip.append(thumb);
        }
        dock.append(strip);
      }
    }
  }

  return dock;
}

let forceGridMode = false;

function renderScreenVideo(id: 'self' | number, label: string, stream: MediaStream, muted: boolean): HTMLElement {
  const tile = $('div', 'screen-tile');
  const video = $('video') as HTMLVideoElement;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = muted;
  video.srcObject = stream;
  if (typeof id === 'number') {
    video.addEventListener('playing', () => client.screen.markPlaying(id, stream));
  }

  const fullBtn = $('button', 'screen-full');
  fullBtn.type = 'button';
  fullBtn.title = 'maximizar (tela cheia)';
  fullBtn.textContent = '⛶';
  fullBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = tile as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    const request = target.requestFullscreen?.bind(target) ?? target.webkitRequestFullscreen?.bind(target);
    if (request) void request().catch(() => {});
  });

  // Duplo click no video tambem entra em tela cheia — padrao familiar de players.
  video.addEventListener('dblclick', () => fullBtn.click());

  tile.append(video, text('span', 'screen-label', label), fullBtn);
  queueMicrotask(() => video.play().catch(() => {}));
  return tile;
}

// ============================================================== context menus --

// ----------------------------------------------------------------- settings --

async function enumerateDevices(options: {
  requestMicrophonePermission?: boolean;
  requestOutputPermission?: boolean;
} = {}): Promise<void> {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!media?.enumerateDevices) {
    inputDevices = [];
    outputDevices = [];
    audioDevicesMessage = 'seu navegador não disponibiliza a lista de dispositivos de áudio';
    refreshVisibleSettings?.();
    return;
  }

  if (audioDevicesLoading) return;
  audioDevicesLoading = true;
  audioDevicesMessage = '';
  refreshVisibleSettings?.();

  try {
    if (options.requestMicrophonePermission) {
      try {
        // Os nomes dos dispositivos ficam ocultos até uma permissão de captura
        // ser concedida. O stream é temporário; a captura real continua sob
        // controle do VoxClient.
        const tempStream = await media.getUserMedia({ audio: true, video: false });
        for (const track of tempStream.getTracks()) track.stop();
      } catch {
        audioDevicesMessage = 'permita o acesso ao microfone para listar suas entradas de áudio';
      }
    }

    if (options.requestOutputPermission) {
      // Chromium pode exigir uma permissão separada para revelar as saídas.
      // A chamada só acontece pelo botão da tela de configurações, portanto
      // continua dentro de um gesto explícito do usuário.
      const picker = media as MediaDevices & AudioOutputPicker;
      if (typeof picker.selectAudioOutput === 'function') {
        try {
          await picker.selectAudioOutput();
        } catch {
          // Cancelar o seletor não é erro: ainda listamos o que já está liberado.
        }
      }
    }

    const all = await media.enumerateDevices();
    const unique = (kind: MediaDeviceKind): MediaDeviceInfo[] => {
      const seen = new Set<string>();
      return all.filter((device) => {
        if (device.kind !== kind || !device.deviceId || seen.has(device.deviceId)) return false;
        seen.add(device.deviceId);
        return true;
      });
    };
    inputDevices = unique('audioinput');
    outputDevices = unique('audiooutput');
    if (inputDevices.length === 0 && outputDevices.length === 0 && !audioDevicesMessage) {
      audioDevicesMessage = 'nenhum dispositivo adicional foi disponibilizado pelo sistema';
    }
  } catch {
    inputDevices = [];
    outputDevices = [];
    audioDevicesMessage = 'não foi possível consultar os dispositivos de áudio';
  } finally {
    audioDevicesLoading = false;
    refreshVisibleSettings?.();
  }
}

function deviceOptionLabel(device: MediaDeviceInfo, fallback: string): string {
  const label = device.label.trim();
  if (label) return label;
  return `${fallback} ${device.deviceId.slice(0, 8)}`.trim();
}

function appendAudioDeviceRefresh(
  body: HTMLElement,
  kind: 'input' | 'output',
): void {
  const actions = $('div', 'settings-test');
  const refresh = $('button', 'ghost');
  refresh.type = 'button';
  refresh.textContent = audioDevicesLoading ? 'atualizando…' : 'atualizar dispositivos';
  refresh.disabled = audioDevicesLoading;
  refresh.addEventListener('click', () => {
    void enumerateDevices({
      requestMicrophonePermission: kind === 'input',
      requestOutputPermission: kind === 'output',
    });
  });
  actions.append(refresh);
  body.append(actions);
  if (audioDevicesMessage) body.append(text('span', 'settings-note', audioDevicesMessage));
}

function renderSettings(): HTMLElement {
  const overlay = $('div', 'settings-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Configurações do v0x');
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      settingsOpen = false;
      closeSettings();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...overlay.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hidden && element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
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
    { id: 'profile', icon: '●', label: t('Perfil') },
    { id: 'identity', icon: '◈', label: t('Identidade') },
    { id: 'capture', icon: '🎙', label: t('Capturar') },
    { id: 'playback', icon: '🔊', label: t('Reprodução') },
    { id: 'notifications', icon: '🔔', label: t('Notificações') },
    ...(client.myGroup >= Group.Dono
      ? [
          { id: 'groups', icon: '👥', label: t('Grupos') },
          { id: 'permissions', icon: '🔐', label: t('Permissões') },
          { id: 'bot', icon: '🤖', label: t('Bot') },
        ]
      : []),
  ];
  let activeSection = 'profile';

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
        if (s.id === 'capture') void enumerateDevices();
        if (s.id === 'playback') void enumerateDevices();
      });
      nav.append(btn);
    }
    translateTree(nav);
  }

  // --- body ---
  const body = $('div', 'settings-body');

  function buildBody(): void {
    body.replaceChildren();
    body.classList.toggle('profile-settings-body', activeSection === 'profile');
    if (activeSection === 'profile') buildProfileSection(body);
    else if (activeSection === 'identity') buildIdentitySection(body, buildBody);
    else if (activeSection === 'capture') buildCaptureSection(body, buildBody);
    else if (activeSection === 'playback') buildPlaybackSection(body);
    else if (activeSection === 'notifications') buildNotificationsSection(body);
    else if (activeSection === 'groups') buildGroupsSection(body, buildBody);
    else if (activeSection === 'permissions') buildPermissionsSection(body);
    else if (activeSection === 'bot') buildBotSection(body, buildBody);
    translateTree(body);
  }

  // O painel administrativo pode alterar o bot enquanto este modal está
  // aberto. Atualiza apenas o corpo da aba Bot, sem fechar o modal ou destruir
  // a navegação atual quando outro evento do servidor chega.
  refreshVisibleSettings = () => {
    if (activeSection === 'bot') buildBody();
  };

  // --- footer ---
  const footer = $('div', 'settings-footer');
  const closeBtn = $('button', 'primary');
  closeBtn.textContent = t('fechar');
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

function buildProfileSection(body: HTMLElement): void {
  const me = client.self;
  const fingerprint = client.identity?.fingerprint ?? '';
  if (!me || !fingerprint) {
    body.append(text('h3', '', t('MEU PERFIL')), text('p', 'settings-note', t('Entre em um servidor com sua identidade carregada para editar o perfil.')));
    return;
  }
  buildProfileEditor(body, {
    me,
    profile: { ...client.profileFor(me), fingerprint },
    renderCard: (person, profile) => renderUserProfileCard(person, profile, person.description, true),
    renderAvatar: (person, profile, className) => renderProfileAvatar(person, className, false, profile),
    publish: async (profile, nickname, description) => {
      if (client.link !== 'online') throw new Error('Você está offline. Reconecte para publicar o perfil.');
      if (nickname !== client.self?.nickname) client.setNickname(nickname);
      if (description !== client.self?.description) client.setClientDescription(fingerprint, description);
      await client.publishProfile(profile);
    },
  });
}

function buildIdentitySection(body: HTMLElement, rebuild: () => void): void {
  body.append(text('h3', '', t('IDENTIDADE')));
  body.append(text('span', '', t('Esta chave define quem você é para os servidores.')));

  const localeRow = $('div', 'settings-row');
  const localeLabel = $('label');
  localeLabel.append(text('span', '', t('Idioma')));
  const localeSelect = createLocaleSelect(() => {
    // O cliente monta a tela inteira de forma imperativa; remontar após a
    // troca garante que também tooltips, placeholders e textos dinâmicos
    // acompanhem o idioma escolhido.
    renderAll();
  });
  localeLabel.append(localeSelect);
  localeRow.append(localeLabel);
  body.append(localeRow);

  body.append($('hr'));

  const current = client.identity;
  const fpRow = $('div', 'settings-row');
  const fpLabel = $('label');
  fpLabel.append(text('span', '', t('Fingerprint')));
  const fp = $('input') as HTMLInputElement;
  fp.readOnly = true;
  fp.value = current?.fingerprint ?? t('identidade ainda não carregada');
  fpLabel.append(fp);
  fpRow.append(fpLabel);
  body.append(fpRow);

  const copyRow = $('div', 'settings-test');
  const copyBtn = $('button', 'ghost');
  copyBtn.textContent = t('copiar fingerprint');
  copyBtn.addEventListener('click', () => {
    if (!current?.fingerprint) return;
    navigator.clipboard?.writeText(current.fingerprint).catch(() => {});
    copyBtn.textContent = t('copiado');
  });
  copyRow.append(copyBtn);
  body.append(copyRow);

  body.append($('hr'));

  const exportRow = $('div', 'settings-row');
  const exportLabel = $('label');
  exportLabel.append(text('span', '', t('Backup da identidade')));
  const backup = $('textarea') as HTMLTextAreaElement;
  backup.rows = 5;
  backup.readOnly = true;
  backup.value = exportIdentity() ?? '';
  exportLabel.append(backup);
  exportRow.append(exportLabel);
  body.append(exportRow);

  const backupActions = $('div', 'settings-test');
  const copyBackup = $('button', 'ghost');
  copyBackup.textContent = t('copiar backup');
  copyBackup.addEventListener('click', () => {
    if (!backup.value) return;
    navigator.clipboard?.writeText(backup.value).catch(() => {});
    copyBackup.textContent = t('backup copiado');
  });
  backupActions.append(copyBackup);
  body.append(backupActions);

  body.append($('hr'));

  const importRow = $('div', 'settings-row');
  const importLabel = $('label');
  importLabel.append(text('span', '', t('Importar identidade')));
  const raw = $('textarea') as HTMLTextAreaElement;
  raw.rows = 5;
  raw.placeholder = t('cole aqui um backup de identidade');
  importLabel.append(raw);
  importRow.append(importLabel);
  body.append(importRow);

  const actions = $('div', 'settings-test');
  const importBtn = $('button', 'ghost');
  importBtn.textContent = t('importar');
  importBtn.addEventListener('click', async () => {
    const ok = await importIdentity(raw.value.trim());
    if (!ok) {
      importBtn.textContent = t('backup inválido');
      return;
    }
    client.identity = await loadIdentity();
    rebuild();
  });

  const resetBtn = $('button', 'danger');
  resetBtn.textContent = t('gerar nova identidade');
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
  body.append(text('span', 'settings-note', 'Voz mono em 48 kHz, com processamento otimizado para fala'));

  // Input device
  const devRow = $('div', 'settings-row');
  const devLabel = $('label');
  devLabel.append(text('span', '', 'Dispositivo de captura'));
  const devSelect = $('select') as HTMLSelectElement;
  const hasSelectedInput = inputDevices.some((device) => device.deviceId === client.mic.deviceId);
  const defaultOpt = $('option') as HTMLOptionElement;
  defaultOpt.value = '';
  defaultOpt.textContent = 'padrão do sistema';
  defaultOpt.selected = client.mic.deviceId === '' || !hasSelectedInput;
  devSelect.append(defaultOpt);
  for (const d of inputDevices) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = d.deviceId;
    opt.textContent = deviceOptionLabel(d, 'microfone');
    if (d.deviceId === client.mic.deviceId) opt.selected = true;
    devSelect.append(opt);
  }
  devSelect.addEventListener('change', () => {
    client.applyMicSettings({ deviceId: devSelect.value });
  });
  devLabel.append(devSelect);
  devRow.append(devLabel);
  body.append(devRow);
  appendAudioDeviceRefresh(body, 'input');

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
    thrLabel.append(text('span', 'settings-note', 'O medidor mostra o nível atual. O limiar de parada é suavizado para não cortar sílabas.'));

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

    const calibrationRow = $('div', 'settings-test');
    const calibrationBtn = $('button', 'ghost');
    calibrationBtn.textContent = 'calibrar ruído ambiente';
    const calibrationNote = text('span', 'settings-note', 'fique em silêncio por 1,5 s');
    calibrationBtn.addEventListener('click', async () => {
      calibrationBtn.disabled = true;
      calibrationBtn.textContent = 'medindo...';
      const threshold = await client.calibrateMicThreshold();
      if (threshold === null) {
        calibrationBtn.disabled = false;
        calibrationBtn.textContent = 'microfone indisponível';
        return;
      }
      rebuild();
    });
    calibrationRow.append(calibrationBtn, calibrationNote);
    body.append(calibrationRow);
  }

  // Test mic with loopback
  body.append($('hr'));
  const testRow = $('div', 'settings-test');
  const testBtn = $('button', 'ghost');
  testBtn.textContent = isMicTestRunning() ? '■ parar teste' : '▶ ouvir teste de microfone';
  const testDot = $('div', 'dot');
  let testIv: ReturnType<typeof setInterval> | null = null;

  testBtn.addEventListener('click', async () => {
    if (isMicTestRunning()) {
      stopMicTest();
      if (testIv) { clearInterval(testIv); testIv = null; }
      testBtn.textContent = '▶ ouvir teste de microfone';
      testDot.classList.remove('live');
      return;
    }
    const ok = await startMicTest(client.mic.deviceId);
    if (!ok) {
      testBtn.textContent = '▶ erro de microfone';
      return;
    }
    testBtn.textContent = '■ parar teste';
    testIv = setInterval(() => {
      if (!isMicTestRunning()) { clearInterval(testIv!); testIv = null; return; }
      testDot.classList.toggle('live', micTestLevel() > 0.01);
    }, 60);
  });
  testRow.append(testBtn, testDot);
  body.append(testRow);

  // Channel recording for objective voice-quality checks
  body.append($('hr'));
  body.append(text('h3', '', 'ANÁLISE DE VOZ'));
  body.append(text('span', 'settings-note', 'Grava localmente o mix do canal e o microfone local para comparar qualidade, cortes e ruído.'));
  body.append(text('span', 'settings-note', 'Use somente com o consentimento das pessoas gravadas.'));

  const recordingRow = $('div', 'settings-recording');
  const recordingBtn = $('button', client.isVoiceRecording ? 'danger' : 'ghost');
  recordingBtn.textContent = client.isVoiceRecording ? '■ parar e salvar' : '● iniciar gravação de análise';
  const recordingTimer = text('span', 'settings-recording-time', formatRecordingDuration(client.recordingElapsedMs));
  recordingTimer.dataset.recordingTimer = 'true';
  recordingBtn.addEventListener('click', async () => {
    recordingBtn.disabled = true;
    if (client.isVoiceRecording) {
      await client.stopVoiceRecording();
      rebuild();
      return;
    }
    if (!confirm('A gravação será salva localmente. Confirme que os participantes autorizaram a gravação.')) {
      recordingBtn.disabled = false;
      return;
    }
    const ok = await client.startVoiceRecording();
    if (!ok) {
      recordingBtn.disabled = false;
      recordingBtn.textContent = 'erro ao iniciar gravação';
      return;
    }
    rebuild();
  });
  recordingRow.append(recordingBtn, recordingTimer);
  body.append(recordingRow);

  if (client.lastRecording && !client.isVoiceRecording) {
    const result = client.lastRecording;
    const player = $('audio', 'recording-player') as HTMLAudioElement;
    player.controls = true;
    player.preload = 'metadata';
    player.src = result.audioUrl;
    const resultRow = $('div', 'settings-recording-result');
    resultRow.append(
      text('span', 'settings-note', `${formatRecordingDuration(result.report.durationMs)} · ${result.report.end.transport} · ${result.report.delta.droppedVoice} pacote(s) descartado(s)`),
      player,
    );
    const reportLink = $('a', 'settings-note') as HTMLAnchorElement;
    reportLink.href = result.reportUrl;
    reportLink.download = 'vox-channel-report.json';
    reportLink.textContent = 'baixar relatório JSON';
    resultRow.append(reportLink);
    body.append(resultRow);
  }

  // Voice quality
  body.append($('hr'));
  const brRow = $('div', 'settings-row');
  const brLabel = $('label');
  brLabel.append(text('span', '', 'Qualidade de voz (bitrate)'));
  const brSelect = $('select') as HTMLSelectElement;
  for (const br of [16, 24, 32, 48, 64]) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = String(br * 1000);
    opt.textContent = `${br} kbps${br === 48 ? ' — recomendado' : br === 64 ? ' — máxima clareza' : ''}`;
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
  const hasSelectedOutput = outputDevices.some((device) => device.deviceId === client.outputDeviceId);
  const defaultOpt = $('option') as HTMLOptionElement;
  defaultOpt.value = '';
  defaultOpt.textContent = 'padrão do sistema';
  defaultOpt.selected = client.outputDeviceId === '' || !hasSelectedOutput;
  devSelect.append(defaultOpt);
  for (const d of outputDevices) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = d.deviceId;
    opt.textContent = deviceOptionLabel(d, 'saída');
    if (d.deviceId === client.outputDeviceId) opt.selected = true;
    devSelect.append(opt);
  }
  devSelect.addEventListener('change', () => {
    void client.setOutputDevice(devSelect.value).catch(() => {
      audioDevicesMessage = 'não foi possível selecionar essa saída de áudio';
      refreshVisibleSettings?.();
    });
  });
  devLabel.append(devSelect);
  devRow.append(devLabel);
  body.append(devRow);
  appendAudioDeviceRefresh(body, 'output');

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

  // Sound pack
  body.append($('hr'));
  body.append(text('h3', '', 'AVISOS SONOROS'));
  body.append(text('span', 'settings-note', 'Escolha tons ou uma voz masculina/feminina em português ou inglês. A voz disponível depende do sistema.'));

  const sndRow = $('div', 'settings-toggle');
  const sndCheck = $('input') as HTMLInputElement;
  sndCheck.type = 'checkbox';
  sndCheck.checked = client.soundsEnabled;
  sndCheck.addEventListener('change', () => client.setSoundsEnabled(sndCheck.checked));
  sndRow.append(sndCheck, text('span', '', 'Ativar avisos sonoros'));
  body.append(sndRow);

  const packRow = $('div', 'settings-row');
  const packLabel = $('label');
  packLabel.append(text('span', '', 'Pacote de sons'));
  const packSelect = $('select') as HTMLSelectElement;
  for (const [id, label] of Object.entries(SOUND_PACK_LABELS)) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = id;
    opt.textContent = label;
    opt.selected = id === client.soundPack;
    packSelect.append(opt);
  }
  packSelect.addEventListener('change', () => client.setSoundPack(packSelect.value as SoundPackId));
  packLabel.append(packSelect);
  packRow.append(packLabel);
  body.append(packRow);

  const soundVolumeRow = $('div', 'settings-row');
  const soundVolumeLabel = $('label');
  soundVolumeLabel.append(text('span', '', 'Volume dos avisos'));
  const soundVolumeSlider = $('div', 'settings-slider');
  const soundVolumeRange = $('input') as HTMLInputElement;
  soundVolumeRange.type = 'range';
  soundVolumeRange.min = '0';
  soundVolumeRange.max = '1';
  soundVolumeRange.step = '0.05';
  soundVolumeRange.value = String(client.soundVolume);
  const soundVolumeValue = text('span', 'val', `${Math.round(client.soundVolume * 100)}%`);
  soundVolumeRange.addEventListener('input', () => {
    const value = Number(soundVolumeRange.value);
    client.setSoundVolumeDirect(value);
    soundVolumeValue.textContent = `${Math.round(value * 100)}%`;
  });
  soundVolumeSlider.append(soundVolumeRange, soundVolumeValue);
  soundVolumeLabel.append(soundVolumeSlider);
  soundVolumeRow.append(soundVolumeLabel);
  body.append(soundVolumeRow);

  const eventList = $('div', 'sound-event-list');
  for (const [name, label] of Object.entries(SOUND_EVENT_LABELS) as [SoundName, string][]) {
    // Entrada no servidor nao gera mais aviso: evita interromper o usuario
    // quando o canal recebe varias pessoas ao mesmo tempo. Mantemos o campo
    // antigo nas preferencias para nao invalidar configuracoes ja salvas.
    if (name === 'join') continue;
    const eventRow = $('div', 'sound-event-row');
    const eventToggle = $('label', 'settings-toggle');
    const eventCheck = $('input') as HTMLInputElement;
    eventCheck.type = 'checkbox';
    eventCheck.checked = client.soundEvents[name];
    eventCheck.addEventListener('change', () => client.setSoundEventEnabled(name, eventCheck.checked));
    eventToggle.append(eventCheck, text('span', '', label));
    const eventTest = $('button', 'ghost');
    eventTest.type = 'button';
    eventTest.textContent = '▶';
    eventTest.title = `testar: ${label}`;
    eventTest.setAttribute('aria-label', `testar ${label}`);
    eventTest.addEventListener('click', () => client.previewSound(name));
    eventRow.append(eventToggle, eventTest);
    eventList.append(eventRow);
  }
  body.append(eventList);

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
      await notify({ title: 'v0x', body: 'Notificação de teste funcionando!', tag: 'test' });
    })();
  });
  testRow.append(testBtn);
  body.append(testRow);
}

/** Procura canal por nome exato (case-insensitive) e parent opcional. */
function findChannelByName(name: string, parentId: number | null = null): ChannelInfo | undefined {
  const lower = name.toLowerCase();
  return [...client.channels.values()].find((c) => {
    if (c.name.toLowerCase() !== lower) return false;
    if (parentId === null) return true;
    return c.parentId === parentId;
  });
}

/**
 * Cria um canal e aguarda o ChannelAdd do server chegar para conhecer o id.
 * Se ja existe (mesmo nome + mesmo pai), reaproveita.
 */
async function ensureChannel(name: string, parentId = NO_CHANNEL): Promise<number> {
  const already = findChannelByName(name, parentId);
  if (already) return already.id;
  client.createChannel(name, '', parentId);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const ch = findChannelByName(name, parentId);
    if (ch) return ch.id;
    await new Promise<void>((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout criando canal "${name}"`);
}

/** Normaliza nome do grupo para slug de arquivo: minusculo, sem acento, sem espaco. */
function iconSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** URL do icone esperada em /root/icons/<slug>.png (servido em /icons/<slug>.png). */
function defaultGroupIconUrl(groupName: string): string {
  const slug = iconSlug(groupName);
  return `/icons/${slug === 'dono' ? 'leader' : slug}.png`;
}

/**
 * Aplica o template Tibia: renomeia os 8 grupos, seta URLs de icones em
 * /icons/<slug>.png e monta a arvore de canais (categorias como canais-pai
 * com os canais reais dentro). Idempotente: canais ja existentes com o
 * mesmo pai sao reaproveitados. Se `wipeFirst`, apaga primeiro todos os
 * canais que o usuario pode remover (menos o default).
 */
/**
 * Le a arvore de canais que esta no ar e devolve no formato do preset. So
 * canais-raiz viram categoria; niveis mais fundos que dois nao existem no
 * formato, entao sao ignorados em vez de achatados.
 */
function channelTreeSnapshot(): TemplateCategory[] {
  const all = [...client.channels.values()].sort((a, b) => a.order - b.order);
  return all
    .filter((c) => c.parentId === NO_CHANNEL)
    .map((parent) => ({
      name: parent.name,
      topic: parent.topic,
      children: all
        .filter((c) => c.parentId === parent.id)
        .map((c) => ({ name: c.name, topic: c.topic })),
    }));
}

async function applyTibiaTemplate(wipeFirst = false): Promise<void> {
  if (wipeFirst) {
    // Apaga canais nao-default. O server pula o default e o AFK auto-criado.
    const toDelete = [...client.channels.values()]
      .filter((c) => (c.flags & ChannelFlags.Default) === 0)
      .sort((a, b) => (a.parentId === NO_CHANNEL ? 1 : 0) - (b.parentId === NO_CHANNEL ? 1 : 0));
    for (const c of toDelete) {
      client.deleteChannel(c.id);
      await new Promise<void>((r) => setTimeout(r, 30));
    }
    // Espera as remocoes propagarem antes de comecar a criar.
    await new Promise<void>((r) => setTimeout(r, 300));
  }

  // 1) Grupos: vem do preset (que cai em DEFAULT_GROUP_DEFS) + icone de /icons.
  for (const def of presetGroups(client.preset)) {
    const icon = def.icon || defaultGroupIconUrl(def.name);
    client.setGroupDef(def.id, def.name, icon, def.color);
  }

  // 2) Categorias como canais-pai; canais reais como filhos.
  for (const cat of client.preset.channels) {
    let parentId: number;
    try {
      parentId = await ensureChannel(cat.name, NO_CHANNEL);
    } catch (err) {
      console.error(err);
      continue;
    }
    for (const child of cat.children) {
      try {
        await ensureChannel(child.name, parentId);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

function buildPermissionsSection(body: HTMLElement): void {
  body.append(text('h3', '', 'PERMISSÕES DO SERVIDOR'));
  body.append(text('span', 'settings-hint', 'Grupo mínimo pra cada ação. Envio direto ao clicar no dropdown.'));

  // Agrupa por categoria pra ficar organizado.
  const groupings: { title: string; actions: PermissionAction[] }[] = [
    {
      title: 'CANAIS',
      actions: [
        PermissionAction.ViewChannels,
        PermissionAction.JoinChannel,
        PermissionAction.CreateTempChannel,
        PermissionAction.CreatePermanentChannel,
        PermissionAction.EditChannel,
        PermissionAction.DeleteChannel,
        PermissionAction.MoveChannel,
      ],
    },
    {
      title: 'MODERAÇÃO',
      actions: [
        PermissionAction.Kick,
        PermissionAction.Move,
        PermissionAction.Ban,
        PermissionAction.SetGroup,
        PermissionAction.SetOtherDescription,
      ],
    },
    {
      title: 'COMANDOS DO BOT',
      actions: [
        PermissionAction.BotPoke,
        PermissionAction.BotMassPoke,
        PermissionAction.BotPush,
        PermissionAction.BotMassPush,
        PermissionAction.BotKick,
        PermissionAction.BotMassKick,
        PermissionAction.BotBan,
        PermissionAction.BotBanList,
        PermissionAction.BotUnban,
        PermissionAction.BotAfk,
        PermissionAction.BotMute,
        PermissionAction.BotUnmute,
        PermissionAction.BotModerate,
        PermissionAction.BotVoice,
        PermissionAction.BotDevoice,
        PermissionAction.BotHunt,
        PermissionAction.BotUnhunt,
        PermissionAction.BotHunted,
      ],
    },
  ];

  const groupOptions = [
    { value: Group.Guest, label: 'Visitante' },
    { value: Group.Spy, label: 'Spy' },
    { value: Group.Member, label: 'Membro' },
    { value: Group.Elite, label: 'Elite' },
    { value: Group.Support, label: 'Suporte' },
    { value: Group.Moderator, label: 'Moderador' },
    { value: Group.Admin, label: 'Admin' },
    { value: Group.Owner, label: 'Leader' },
    { value: Group.Dono, label: 'Dono' },
  ];

  for (const g of groupings) {
    const h = text('h4', '', g.title);
    h.style.cssText = 'margin:14px 0 4px;font-size:11px;color:var(--text-dim);letter-spacing:0.05em;';
    body.append(h);
    const table = $('div', 'perm-table');
    for (const action of g.actions) {
      const row = $('div', 'perm-row');
      const label = text('span', 'perm-label', PERMISSION_LABELS[action]);
      const select = $('select') as HTMLSelectElement;
      const current = client.permissionFor(action);
      for (const opt of groupOptions) {
        const o = $('option') as HTMLOptionElement;
        o.value = String(opt.value);
        const isDefault = opt.value === DEFAULT_PERMISSIONS[action];
        o.textContent = isDefault ? `${opt.label} (padrão)` : opt.label;
        if (opt.value === current) o.selected = true;
        select.append(o);
      }
      select.addEventListener('change', () => {
        client.setPermission(action, Number(select.value) as Group);
      });
      row.append(label, select);
      table.append(row);
    }
    body.append(table);
  }

  const resetRow = $('div', '');
  resetRow.style.cssText = 'margin-top:16px;';
  const resetBtn = $('button', 'ghost');
  resetBtn.textContent = 'restaurar padrões';
  resetBtn.addEventListener('click', () => {
    if (!confirm('reset TODAS as permissões aos padrões?')) return;
    for (const action of Object.keys(DEFAULT_PERMISSIONS)) {
      const a = Number(action) as PermissionAction;
      client.setPermission(a, DEFAULT_PERMISSIONS[a]);
    }
  });
  resetRow.append(resetBtn);
  body.append(resetRow);
}

function buildGroupsSection(body: HTMLElement, rebuild: () => void): void {
  body.append(text('h3', '', 'GRUPOS DO SERVIDOR'));
  body.append(text('span', '', 'Configure nome, cor e ícone dos grupos. As alterações só valem depois de salvar.'));

  // Bloco de preset: escolhe o conjunto (canais + respawns + bot) e aplica.
  const tplBox = $('div', 'tibia-template');
  tplBox.append(text('h4', '', 'PRESET DO SERVIDOR'));
  tplBox.append(text('span', 'settings-hint', 'o preset define a árvore de canais, o catálogo de respawns dos claims e de onde o bot puxa dados. aplicar renomeia os grupos e cria as categorias. idempotente: mesmo nome + mesmo pai é reaproveitado.'));

  // Lista embutidos + o preset ativo quando ele veio de importacao (que nao
  // esta em SERVER_PRESETS e sumiria do seletor).
  const options = [...SERVER_PRESETS];
  if (!options.some((p) => p.id === client.preset.id)) options.unshift(client.preset);

  const picker = $('select', 'preset-picker') as HTMLSelectElement;
  for (const preset of options) {
    const opt = $('option') as HTMLOptionElement;
    opt.value = preset.id;
    opt.textContent = preset.name;
    picker.append(opt);
  }
  picker.value = client.preset.id;

  const describe = (): void => {
    const preset = options.find((p) => p.id === picker.value) ?? client.preset;
    const respawns = preset.respawns.reduce((n, g) => n + g.items.length, 0);
    const channels = preset.channels.reduce((n, c) => n + c.children.length, 0);
    const bot = preset.bot.provider === 'none' ? 'sem bot' : `bot: ${preset.bot.provider}`;
    presetInfo.textContent = `${preset.description} — ${channels} canais, ${respawns} respawns, ${bot}.`;
  };
  const presetInfo = text('span', 'settings-hint', '');
  picker.addEventListener('change', describe);

  const tplRow = $('div', 'tibia-template-row');

  /**
   * Aplica um preset: primeiro avisa o servidor (que troca o catalogo de
   * claims), so depois monta os canais. Na ordem inversa a arvore nova
   * conviveria por alguns segundos com os claims do preset antigo.
   */
  const runTemplate = async (btn: HTMLButtonElement, wipe: boolean, label: string): Promise<void> => {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = wipe ? 'apagando + criando...' : 'aplicando...';
    try {
      if (picker.value !== client.preset.id) {
        client.setPreset(picker.value);
        await new Promise<void>((r) => setTimeout(r, 300));
      }
      await applyTibiaTemplate(wipe);
      // Aguarda o server ecoar Op.GroupDefs antes de reconstruir a tela,
      // e limpa o buffer local pra a re-render reseedar com os defs novos —
      // senao edicoes antigas em cache mostram nomes/icones desatualizados.
      await new Promise<void>((r) => setTimeout(r, 500));
      groupEdits.clear();
    } catch (err) {
      console.error(err);
      alert(`falha: ${String(err)}`);
    } finally {
      btn.disabled = false;
      btn.textContent = prev ?? label;
      rebuild();
    }
  };

  const applyBtn = $('button', 'primary') as HTMLButtonElement;
  applyBtn.textContent = 'aplicar preset';
  applyBtn.addEventListener('click', () => {
    const preset = options.find((p) => p.id === picker.value) ?? client.preset;
    if (!confirm(`isso vai aplicar o preset "${preset.name}": renomear os grupos, setar ícones em /icons/<nome>.png e criar as categorias com os canais dentro. continuar?`)) return;
    void runTemplate(applyBtn, false, 'aplicar preset');
  });

  const wipeBtn = $('button', 'ghost danger') as HTMLButtonElement;
  wipeBtn.textContent = 'recriar do zero';
  wipeBtn.title = 'apaga todos os canais não-padrão antes de recriar tudo';
  wipeBtn.addEventListener('click', () => {
    if (!confirm('DESTRUTIVO: isso vai APAGAR todos os canais (menos o default) e recriar a árvore do preset do zero. tem certeza?')) return;
    void runTemplate(wipeBtn, true, 'recriar do zero');
  });

  tplRow.append(picker, applyBtn, wipeBtn);
  tplBox.append(presetInfo, tplRow);

  // --- exportar / importar ---------------------------------------------
  // O caminho pra montar um preset novo: aplicar o "em branco", ajustar os
  // canais na interface, exportar, preencher os respawns no JSON e reimportar.
  const ioRow = $('div', 'tibia-template-row');

  const exportBtn = $('button', 'ghost') as HTMLButtonElement;
  exportBtn.textContent = 'exportar preset';
  exportBtn.title = 'baixa o preset ativo como JSON, pronto pra editar e reimportar';
  exportBtn.addEventListener('click', () => {
    // Exporta a arvore de canais que esta no ar, nao a do preset original —
    // e o que faz "ajuste na interface e exporte" funcionar.
    const snapshot = { ...client.preset, channels: channelTreeSnapshot() };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = $('a') as HTMLAnchorElement;
    a.href = url;
    a.download = `preset-${client.preset.id.replace(/[^a-z0-9._-]+/gi, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const importInput = $('input') as HTMLInputElement;
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.hidden = true;
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    void file.text().then((raw) => {
      // Valida no cliente pra dar erro legivel; o servidor revalida de qualquer jeito.
      let parsed;
      try {
        parsed = parsePreset(JSON.parse(raw));
      } catch {
        parsed = null;
      }
      if (!parsed) {
        alert('preset inválido: JSON malformado, sem id/nome, ou grande demais (limite 48KB).');
        return;
      }
      if (!confirm(`importar o preset "${parsed.name}"? isso troca o catálogo de respawns do servidor. os canais só mudam quando você clicar em aplicar.`)) return;
      client.setPreset(parsed.id, JSON.stringify(parsed));
    });
  });

  const importBtn = $('button', 'ghost') as HTMLButtonElement;
  importBtn.textContent = 'importar preset';
  importBtn.addEventListener('click', () => importInput.click());

  ioRow.append(exportBtn, importBtn, importInput);
  tplBox.append(ioRow);

  describe();
  body.append(tplBox);
  body.append($('hr'));

  // Seed a partir do server para cada def que ainda nao tem edicao local,
  // e purga edicoes de defs que sumiram (grupo removido).
  const knownIds = new Set(client.groupDefs.map((d) => d.id));
  for (const id of [...groupEdits.keys()]) if (!knownIds.has(id)) groupEdits.delete(id);
  for (const def of client.groupDefs) {
    if (!groupEdits.has(def.id)) {
      groupEdits.set(def.id, { name: def.name, color: def.color, icon: def.icon });
    }
  }

  const isDirty = (def: GroupDef): boolean => {
    const e = groupEdits.get(def.id);
    if (!e) return false;
    return e.name !== def.name || e.color !== def.color || e.icon !== def.icon;
  };
  const dirtyCount = (): number => client.groupDefs.reduce((n, d) => n + (isDirty(d) ? 1 : 0), 0);

  // --- toolbar (topo, sticky visual) -----------------------------------
  const toolbar = $('div', 'groups-toolbar');
  const status = text('span', 'groups-status', '');
  const saveAll = $('button', 'primary') as HTMLButtonElement;
  saveAll.textContent = 'salvar alterações';
  const discard = $('button', 'ghost') as HTMLButtonElement;
  discard.textContent = 'descartar';

  const refreshToolbar = (): void => {
    const n = dirtyCount();
    saveAll.disabled = n === 0;
    discard.disabled = n === 0;
    status.textContent = n === 0
      ? 'sem alterações pendentes'
      : n === 1
        ? '1 grupo alterado'
        : `${n} grupos alterados`;
    status.classList.toggle('dirty', n > 0);
  };

  saveAll.addEventListener('click', () => {
    for (const def of client.groupDefs) {
      if (!isDirty(def)) continue;
      const e = groupEdits.get(def.id)!;
      const name = e.name.trim() || def.name;
      client.setGroupDef(def.id, name, e.icon, e.color);
    }
    groupEdits.clear();
    setTimeout(rebuild, 250);
  });

  discard.addEventListener('click', () => {
    groupEdits.clear();
    rebuild();
  });

  toolbar.append(status, discard, saveAll);
  body.append(toolbar);
  refreshToolbar();

  // --- cards -----------------------------------------------------------
  for (const def of client.groupDefs) {
    const edit = groupEdits.get(def.id)!;
    const card = $('div', 'group-card');
    const markDirty = (): void => {
      card.classList.toggle('dirty', isDirty(def));
      refreshToolbar();
    };
    if (isDirty(def)) card.classList.add('dirty');

    // ---- icon area ---------------------------------------------------
    const iconArea = $('div', 'group-icon-area');
    if (edit.icon) {
      const img = $('img') as HTMLImageElement;
      img.src = serverAssetUrl(edit.icon);
      img.onerror = () => img.remove();
      img.style.cssText = 'width:32px;height:32px;object-fit:contain;border-radius:var(--r);';
      iconArea.append(img);
    } else {
      const placeholder = $('div', 'group-icon-placeholder');
      placeholder.textContent = (edit.name || def.name).charAt(0).toUpperCase();
      iconArea.append(placeholder);
    }

    const iconBtn = $('button', 'ghost');
    iconBtn.textContent = edit.icon ? 'trocar' : 'ícone';
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
          edit.icon = reader.result as string;
          rebuild();
        };
        reader.readAsDataURL(file);
      });
      input.click();
    });

    const removeIconBtn = $('button', 'ghost danger');
    removeIconBtn.textContent = '✕';
    removeIconBtn.style.cssText = 'padding:2px 6px;font-size:10px;min-width:unset;';
    removeIconBtn.addEventListener('click', () => {
      edit.icon = '';
      rebuild();
    });

    const urlBtn = $('button', 'ghost');
    urlBtn.textContent = 'URL';
    urlBtn.title = 'colar URL de imagem (ex: /icons/leader.png)';
    urlBtn.style.cssText = 'padding:2px 8px;font-size:11px;';
    urlBtn.addEventListener('click', () => {
      const url = prompt('URL da imagem (ex: /icons/leader.png):', edit.icon.startsWith('http') || edit.icon.startsWith('/') ? edit.icon : '');
      if (url === null) return;
      edit.icon = url.trim();
      markDirty();
      rebuild();
    });

    const iconBtns = $('div', '');
    iconBtns.style.cssText = 'display:flex;gap:4px;';
    iconBtns.append(iconBtn, urlBtn);
    if (edit.icon) iconBtns.append(removeIconBtn);
    iconArea.append(iconBtns);
    card.append(iconArea);

    // ---- info area ---------------------------------------------------
    const infoArea = $('div', 'group-info-area');

    const preview = text('span', 'group-preview', edit.name || def.name);
    preview.style.color = edit.color || 'var(--text)';

    const nameRow = $('div', 'settings-row');
    const nameLabel = $('label');
    nameLabel.append(text('span', '', 'Nome'));
    const nameInput = $('input') as HTMLInputElement;
    nameInput.value = edit.name;
    nameInput.placeholder = 'Nome do grupo';
    nameInput.addEventListener('input', () => {
      edit.name = nameInput.value;
      preview.textContent = edit.name || def.name;
      markDirty();
    });
    nameLabel.append(nameInput);
    nameRow.append(nameLabel);
    infoArea.append(nameRow);

    const colorRow = $('div', '');
    colorRow.style.cssText = 'display:flex;align-items:center;gap:10px;';
    const colorLabel = text('span', '', 'Cor');
    colorLabel.style.cssText = 'font-size:12px;color:var(--text-dim);';
    const colorInput = $('input') as HTMLInputElement;
    colorInput.type = 'color';
    colorInput.value = edit.color || '#ebe5dc';
    colorInput.style.cssText = 'width:32px;height:28px;padding:2px;border:1px solid var(--line);background:var(--ink-900);border-radius:var(--r);cursor:pointer;';
    colorInput.addEventListener('input', () => {
      edit.color = colorInput.value === '#ebe5dc' ? '' : colorInput.value;
      preview.style.color = edit.color || 'var(--text)';
      markDirty();
    });

    const colorClear = $('button', 'ghost');
    colorClear.textContent = 'padrão';
    colorClear.style.cssText = 'padding:2px 8px;font-size:11px;';
    colorClear.addEventListener('click', () => {
      edit.color = '';
      colorInput.value = '#ebe5dc';
      preview.style.color = 'var(--text)';
      markDirty();
    });

    colorRow.append(colorLabel, colorInput, colorClear, preview);
    infoArea.append(colorRow);

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
      iconImg.src = serverAssetUrl(tgdef.icon);
      iconImg.onerror = () => iconImg.remove();
      iconImg.title = tgdef.name;
      iconImg.style.cssText = 'width:16px;height:16px;object-fit:contain;';
      nickRow.append(iconImg);
    } else {
      const icons: Record<number, string> = { [Group.Moderator]: '⚔', [Group.Admin]: '★', [Group.Owner]: '♛', [Group.Dono]: '♛' };
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

    // ---- group assignment: somente Dono -------------------------------
    if (client.myGroup >= Group.Dono) {
      const { toggle, sub } = collapsible('grupo');
      items.push(toggle);

      // Somente Dono pode administrar cargos e criar outro Dono.
      const groups = client.groupDefs.filter((g) =>
        g.id < client.myGroup || (g.id === Group.Dono && client.myGroup >= Group.Dono),
      );
      for (const g of groups) {
        const gBtn = $('button');
        const isCurrent = target.group === g.id;
        const isPromoteToDono = g.id === Group.Dono && target.group !== Group.Dono;
        if (g.icon) {
          const gIcon = $('img') as HTMLImageElement;
          gIcon.src = serverAssetUrl(g.icon);
          gIcon.onerror = () => gIcon.remove();
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
          if (isPromoteToDono) {
            const ok = window.confirm(
              `promover ${target.nickname} a Dono? donos podem editar tudo, inclusive rebaixar voce.`,
            );
            if (!ok) return;
          }
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

function channelPath(ch: ChannelInfo): string {
  const names = [ch.name];
  const seen = new Set<number>([ch.id]);
  let parent = ch.parentId === NO_CHANNEL ? undefined : client.channels.get(ch.parentId);
  while (parent && !seen.has(parent.id)) {
    names.unshift(parent.name);
    seen.add(parent.id);
    parent = parent.parentId === NO_CHANNEL ? undefined : client.channels.get(parent.parentId);
  }
  return names.join(' / ');
}

function movableChannelTargets(source: ChannelInfo): ChannelInfo[] {
  return [...client.channels.values()]
    .filter((candidate) => candidate.id !== source.id && !isChannelDescendant(candidate.id, source.id))
    .sort((a, b) => channelPath(a).localeCompare(channelPath(b), undefined, { sensitivity: 'base' }));
}

function addChannelMoveMenu(items: HTMLElement[], ch: ChannelInfo): void {
  if (!client.canMoveChannel(ch)) return;

  items.push($('hr'));

  const rootBtn = $('button');
  rootBtn.textContent = t('mover para raiz (fim)');
  rootBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    client.moveChannel(ch.id, NO_CHANNEL, NO_CHANNEL);
    closeMenu();
  });
  items.push(rootBtn);

  const targets = movableChannelTargets(ch);
  if (targets.length === 0) return;

  const after = collapsible(t('mover depois de'));
  for (const target of targets) {
    const targetBtn = $('button');
    targetBtn.textContent = `# ${channelPath(target)}`;
    targetBtn.title = `${t('mover depois de')} ${channelPath(target)}`;
    targetBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      client.moveChannel(ch.id, target.parentId, getNextSiblingChannelId(target.id, ch.id));
      closeMenu();
    });
    after.sub.firstElementChild!.append(targetBtn);
  }
  items.push(after.toggle, after.sub);

  const inside = collapsible(t('mover para dentro de'));
  for (const target of targets) {
    const targetBtn = $('button');
    targetBtn.textContent = `# ${channelPath(target)}`;
    targetBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      client.moveChannel(ch.id, target.id, NO_CHANNEL);
      closeMenu();
    });
    inside.sub.firstElementChild!.append(targetBtn);
  }
  items.push(inside.toggle, inside.sub);
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
  if (ch.flags & ChannelFlags.VoiceDisabled) flags.push('sem voz');
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

  addChannelMoveMenu(items, ch);

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
  if (ch.flags & ChannelFlags.VoiceDisabled) flagParts.push('Sem voz (todos ficam mutados)');
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

function showEditServerOverlay(): void {
  const overlay = $('div', 'settings-overlay');
  overlay.addEventListener('click', (ev) => {
    if (ev.target === overlay) overlay.remove();
  });

  const panel = $('div', 'settings');
  panel.style.width = '460px';
  panel.style.gridTemplateColumns = '1fr';

  const body = $('div', 'settings-body');
  body.append(text('h3', '', 'EDITAR SERVIDOR'));
  body.append(text('span', 'settings-hint', 'Atualize o nome, a mensagem de entrada e a capacidade do servidor.'));

  const summary = $('div', 'server-edit-summary');
  summary.append(
    text('div', 'server-edit-stat', `${client.clients.size} / ${client.maxClients} usuários`),
    text('div', 'server-edit-meta', `ID ${client.serverId} · preset ${client.presetId || 'rubinot'}`),
  );
  body.append(summary);

  const nameRow = $('div', 'settings-row');
  const nameLabel = $('label');
  nameLabel.append(text('span', '', 'Nome do servidor'));
  const nameInput = $('input') as HTMLInputElement;
  nameInput.value = client.serverName;
  nameInput.maxLength = 64;
  nameLabel.append(nameInput);
  nameRow.append(nameLabel);
  body.append(nameRow);

  const motdRow = $('div', 'settings-row');
  const motdLabel = $('label');
  motdLabel.append(text('span', '', 'Mensagem de entrada'));
  const motdInput = $('textarea') as HTMLTextAreaElement;
  motdInput.value = client.motd;
  motdInput.maxLength = 256;
  motdInput.rows = 3;
  motdInput.placeholder = 'bem-vindo ao seu servidor Vox';
  motdLabel.append(motdInput);
  motdRow.append(motdLabel);
  body.append(motdRow);

  const maxRow = $('div', 'settings-row');
  const maxLabel = $('label');
  maxLabel.append(text('span', '', 'Quantidade máxima de usuários'));
  const maxInput = $('input') as HTMLInputElement;
  maxInput.type = 'number';
  maxInput.min = String(Math.max(1, client.clients.size));
  maxInput.max = '4096';
  maxInput.value = String(Math.max(client.maxClients, client.clients.size));
  maxInput.readOnly = true;
  maxInput.disabled = true;
  maxInput.title = 'A capacidade é definida pelo plano contratado';
  maxLabel.append(maxInput);
  maxRow.append(maxLabel);
  body.append(maxRow);

  const address = client.favorite?.address;
  if (address) {
    const addressInfo = text('div', 'settings-hint', `Endereço de acesso: ${address}`);
    body.append(addressInfo);
  }

  const footer = $('div', 'settings-footer');
  const saveBtn = $('button', 'primary');
  saveBtn.textContent = 'salvar alterações';
  saveBtn.addEventListener('click', () => {
    client.editServer(
      nameInput.value.trim() || client.serverName,
      motdInput.value.trim(),
      client.maxClients,
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
  requestAnimationFrame(() => nameInput.focus());
}

function showTreeMenu(e: MouseEvent): void {
  const items: HTMLElement[] = [];

  // header
  const head = $('div', 'head');
  head.append(text('div', 'nick', client.serverName || 'v0x'));
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

  // edit server (owner)
  if (client.myGroup >= Group.Dono) {
    const editBtn = $('button');
    editBtn.textContent = 'editar servidor';
    editBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      showEditServerOverlay();
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
  if (client.myGroup >= Group.Dono) {
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
  const run = ++connectionRun;
  clearConnectionModalTimer();
  connectionModal = {
    run,
    favorite: fav,
    stage: 'preparing',
    failedAt: 'preparing',
    detail: 'validando sua identidade e preparando o áudio…',
    started: false,
    channelsLoaded: false,
  };
  connectionBackgroundRun = 0;
  view = 'shell';
  render();
  // Marca a tentativa antes de chamar connect: erros imediatos (por exemplo,
  // endereço inválido) também precisam aparecer no modal.
  if (connectionModal?.run === run) connectionModal.started = true;
  try {
    await client.connect(fav);
  } catch (err) {
    if (connectionModal?.run !== run) return;
    connectionModal.failedAt = connectionModal.stage === 'error' ? 'preparing' : connectionModal.stage;
    connectionModal.stage = 'error';
    connectionModal.detail = describeConnectionError(err);
    render();
  }
}

function describeConnectionError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return 'permissão do navegador não concedida';
    if (err.name === 'NotFoundError') return 'nenhum dispositivo de áudio disponível';
    return err.name;
  }
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function directServerFromUrl(): string {
  const address = new URLSearchParams(location.search).get('server')?.trim() ?? '';
  return address;
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

client = new VoxClient(
  () => {
    if (view === 'shell') render();
  },
  updateLiveConnectionStatus,
);
client.onBotStateChange = () => refreshVisibleSettings?.();

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

const directServer = directServerFromUrl();
if (directServer) {
  void connectTo({
    id: `direct-${Date.now().toString(36)}`,
    label: directServer,
    address: directServer,
    serverId: 0,
    nickname: 'eu',
    password: '',
    lastUsed: Date.now(),
  });
}

// Probe known servers for occupancy
if (!directServer) void refreshServers();

// A lista pode mudar quando o usuário conecta um headset ou troca o dispositivo
// padrão no Windows. O botão nas configurações também força uma atualização
// com a permissão apropriada.
if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  let deviceChangeTimer: ReturnType<typeof setTimeout> | null = null;
  navigator.mediaDevices.addEventListener?.('devicechange', () => {
    if (deviceChangeTimer) clearTimeout(deviceChangeTimer);
    deviceChangeTimer = setTimeout(() => {
      deviceChangeTimer = null;
      void enumerateDevices();
    }, 250);
  });
  void enumerateDevices();
}

// ------------------------------------------------- animation loop --

function tick(): void {
  const recordingTimer = document.querySelector('[data-recording-timer]') as HTMLElement | null;
  if (recordingTimer && client.isVoiceRecording) {
    recordingTimer.textContent = formatRecordingDuration(client.recordingElapsedMs);
  }

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
