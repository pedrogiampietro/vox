/**
 * Interface do cliente web.
 *
 * DOM puro, sem framework: o cliente inteiro (protocolo + audio + UI) fecha em
 * poucas dezenas de KB, que e o ponto do projeto. Nada aqui usa innerHTML com
 * conteudo vindo da rede - apelido e mensagem vao sempre por textContent.
 */

import { ChatScope, ClientFlags, NO_CHANNEL } from '@vox/protocol';
import type { ChannelInfo } from '@vox/protocol';
import { VoxClient } from './client.js';
import { isDesktopShell } from './net/connection.js';
import { Microphone } from './audio/microphone.js';
import { VoiceMixer } from './audio/mixer.js';

// ------------------------------------------------------------ preferencias --

interface Prefs {
  nickname: string;
  address: string;
  pttCode: string;
  activation: 'voice' | 'ptt';
  bitrate: number;
  threshold: number;
  volume: number;
  deviceId: string;
}

const DEFAULT_PREFS: Prefs = {
  nickname: '',
  address: '',
  pttCode: 'ControlLeft',
  activation: 'voice',
  bitrate: 32_000,
  threshold: 0.02,
  volume: 1,
  deviceId: '',
};

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('vox.prefs') ?? '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem('vox.prefs', JSON.stringify(prefs));
  } catch {
    // modo privado: seguimos sem persistir
  }
}

const prefs = loadPrefs();

// ------------------------------------------------------------------ util --

type Attrs = Record<string, string | number | boolean | EventListener>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener);
    else if (value === false || value === undefined) continue;
    else if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}

const hhmm = (stamp: number) =>
  new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ----------------------------------------------------------------- estado --

const root = document.getElementById('app')!;
const client = new VoxClient(schedule);

let mode: 'login' | 'app' | null = null;
let pending = 0;
/** Elementos de usuario por id, para o pisca-pisca de quem fala sem redesenhar. */
let userNodes = new Map<number, HTMLElement>();
let chatShown = 0;

function schedule(): void {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    render();
  });
}

function render(): void {
  const want = client.link === 'offline' ? 'login' : 'app';
  if (want !== mode) {
    mode = want;
    root.replaceChildren(want === 'login' ? buildLogin() : buildApp());
    chatShown = 0;
  }
  if (mode === 'app') {
    updateHeader();
    updateTree();
    updateChat();
    updateControls();
  }
  updateNotice();
}

// ----------------------------------------------------------------- login --

function buildLogin(): HTMLElement {
  const nickname = el('input', { value: prefs.nickname, maxlength: 32, placeholder: 'seu apelido' });
  const address = el('input', {
    value: prefs.address,
    // Na web, vazio herda a origem da pagina; no desktop nao ha o que herdar.
    placeholder: isDesktopShell ? 'servidor.com:9987' : 'servidor.com:9987 (vazio = este)',
  });
  const password = el('input', { type: 'password', placeholder: 'senha do servidor (opcional)' });

  const submit = el('button', { class: 'primary', type: 'submit', text: 'Conectar' });

  const form = el(
    'form',
    {
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        const nick = nickname.value.trim();
        if (!nick) return nickname.focus();
        prefs.nickname = nick;
        prefs.address = address.value.trim();
        savePrefs();
        submit.textContent = 'Conectando...';
        void client.connect(prefs.address, nick, password.value);
      },
    },
    el('div', { class: 'brand' }, el('h1', { text: 'Vox' }), el('span', { text: 'voz em canais' })),
    el('label', {}, 'Apelido', nickname),
    el('label', {}, 'Servidor', address),
    el('label', {}, 'Senha', password),
    submit,
    el('div', {
      class: 'stat',
      text: supportSummary(),
    }),
  );

  queueMicrotask(() => nickname.focus());
  return el('div', { class: 'login' }, form);
}

function supportSummary(): string {
  if (!Microphone.supported || !VoiceMixer.supported) {
    return 'Este navegador nao tem WebCodecs de audio: a voz nao vai funcionar. Use Chrome, Edge ou Firefox recentes.';
  }
  return 'Opus 48 kHz mono - codec nativo do navegador, sem plugins.';
}

// ------------------------------------------------------------------- app --

let headerName: HTMLElement;
let headerMotd: HTMLElement;
let headerStat: HTMLElement;
let treeBox: HTMLElement;
let logBox: HTMLElement;
let composerInput: HTMLInputElement;
let micButton: HTMLButtonElement;
let spkButton: HTMLButtonElement;
let meterFill: HTMLElement;
let deviceSelect: HTMLSelectElement;
let pttButton: HTMLButtonElement;

function buildApp(): HTMLElement {
  headerName = el('div', { class: 'name', text: client.serverName || 'conectando...' });
  headerMotd = el('div', { class: 'motd' });
  headerStat = el('div', { class: 'stat' });

  const header = el(
    'header',
    {},
    headerName,
    headerMotd,
    el('div', { class: 'spacer' }),
    headerStat,
    el('button', {
      text: 'Sair',
      onclick: () => client.disconnect(),
    }),
  );

  treeBox = el('div', { class: 'tree' });
  logBox = el('div', { class: 'log' });

  composerInput = el('input', {
    placeholder: 'mensagem para o canal',
    maxlength: 1024,
    // Enter envia mesmo onde o submit implicito do formulario nao dispara.
    onkeydown: (ev: Event) => {
      const key = ev as KeyboardEvent;
      if (key.key !== 'Enter' || key.shiftKey) return;
      key.preventDefault();
      client.say(composerInput.value, ChatScope.Channel);
      composerInput.value = '';
    },
  });
  const composer = el(
    'form',
    {
      class: 'composer',
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        client.say(composerInput.value, ChatScope.Channel);
        composerInput.value = '';
      },
    },
    composerInput,
    el('button', { class: 'primary', type: 'submit', text: 'Enviar' }),
  );

  return el(
    'div',
    { class: 'app' },
    header,
    el('main', {}, treeBox, el('div', { class: 'chat' }, logBox, composer)),
    buildFooter(),
  );
}

function buildFooter(): HTMLElement {
  micButton = el('button', { text: 'Microfone', onclick: () => client.toggleMic() });
  spkButton = el('button', { text: 'Som', onclick: () => client.toggleSpeakers() });
  meterFill = el('i');

  deviceSelect = el('select', {
    onchange: () => {
      prefs.deviceId = deviceSelect.value;
      savePrefs();
      void client.applyMicSettings({ deviceId: prefs.deviceId });
    },
  });
  void fillDevices();

  const activation = el(
    'select',
    {
      onchange: (ev: Event) => {
        prefs.activation = (ev.target as HTMLSelectElement).value as 'voice' | 'ptt';
        savePrefs();
        void client.applyMicSettings({ activation: prefs.activation });
      },
    },
    el('option', { value: 'voice', text: 'Por voz' }),
    el('option', { value: 'ptt', text: 'Push-to-talk' }),
  );
  activation.value = prefs.activation;

  pttButton = el('button', {
    text: `Tecla: ${keyLabel(prefs.pttCode)}`,
    onclick: () => captureKey(),
  });

  const volume = el('input', {
    type: 'range',
    min: 0,
    max: 1.5,
    step: 0.05,
    value: prefs.volume,
    oninput: (ev: Event) => {
      prefs.volume = Number((ev.target as HTMLInputElement).value);
      savePrefs();
      client.setOutputVolume(prefs.volume);
    },
  });
  volume.style.width = '110px';

  return el(
    'footer',
    {},
    micButton,
    spkButton,
    el('div', { class: 'meter' }, meterFill),
    el('label', {}, 'Entrada', deviceSelect),
    el('label', {}, 'Ativacao', activation),
    pttButton,
    el('label', {}, 'Volume', volume),
  );
}

async function fillDevices(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    deviceSelect.replaceChildren(el('option', { value: '', text: 'Padrao do sistema' }));
    for (const d of devices) {
      if (d.kind !== 'audioinput') continue;
      deviceSelect.append(el('option', { value: d.deviceId, text: d.label || 'Microfone' }));
    }
    deviceSelect.value = prefs.deviceId;
  } catch {
    // sem permissao ainda: a lista vem depois do primeiro getUserMedia
  }
}

// -------------------------------------------------------------- updates --

function updateHeader(): void {
  const online = client.link === 'online';
  headerName.textContent = client.serverName || 'Vox';
  // Fora do ar o recado do servidor da lugar ao motivo, no mesmo lugar.
  headerMotd.textContent = online ? client.motd : client.detail;
  headerMotd.classList.toggle('warn', !online);

  const dropped = client.connection.droppedVoice;
  headerStat.textContent = online
    ? `${client.clients.size} online - ${client.connection.rtt} ms` +
      (dropped > 0 ? ` - ${dropped} descartados` : '')
    : '';
}

function updateTree(): void {
  userNodes = new Map();
  const frag = document.createDocumentFragment();
  for (const channel of client.childrenOf(NO_CHANNEL)) renderChannel(channel, frag, 0);

  frag.append(
    el('div', { style: 'padding:10px 8px' },
      el('button', {
        text: '+ Criar canal',
        onclick: () => {
          const name = prompt('Nome do canal');
          if (name) client.createChannel(name);
        },
      }),
    ),
  );
  treeBox.replaceChildren(frag);
}

function renderChannel(channel: ChannelInfo, into: ParentNode, depth: number): void {
  const members = client.membersOf(channel.id);
  const here = client.self?.channelId === channel.id;

  const row = el(
    'div',
    {
      class: `channel${here ? ' here' : ''}`,
      title: channel.topic,
      ondblclick: () => client.join(channel.id),
      onclick: () => client.join(channel.id),
    },
    el('span', { text: channel.name }),
    el('span', { class: 'count', text: members.length ? String(members.length) : '' }),
  );
  row.style.marginLeft = `${depth * 12}px`;
  into.append(row);

  for (const member of members) {
    const node = el(
      'div',
      { class: `user${member.id === client.selfId ? ' me' : ''}` },
      el('span', { class: 'dot' }),
      el('span', { text: member.nickname }),
    );
    node.style.marginLeft = `${depth * 12}px`;
    if (member.flags & ClientFlags.MutedSpeakers) {
      node.append(el('span', { class: 'tag off', text: 'sem som' }));
    } else if (member.flags & ClientFlags.MutedMic) {
      node.append(el('span', { class: 'tag off', text: 'mudo' }));
    }
    userNodes.set(member.id, node);
    into.append(node);
  }

  for (const child of client.childrenOf(channel.id)) renderChannel(child, into, depth + 1);
}

function updateChat(): void {
  const atBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 40;
  for (; chatShown < client.chat.length; chatShown++) {
    const line = client.chat[chatShown]!;
    logBox.append(
      el(
        'div',
        { class: 'line' },
        el('time', { text: hhmm(line.stamp) }),
        el('b', { text: line.senderName }),
        document.createTextNode(': ' + line.text),
      ),
    );
  }
  if (atBottom) logBox.scrollTop = logBox.scrollHeight;
}

function updateControls(): void {
  const flags = client.flags;
  micButton.classList.toggle('on', (flags & ClientFlags.MutedMic) !== 0);
  spkButton.classList.toggle('on', (flags & ClientFlags.MutedSpeakers) !== 0);
  micButton.textContent = flags & ClientFlags.MutedMic ? 'Mic mudo' : 'Microfone';
  spkButton.textContent = flags & ClientFlags.MutedSpeakers ? 'Som desligado' : 'Som';
  pttButton.hidden = client.mic.activation !== 'ptt';
}

let noticeNode: HTMLElement | null = null;

function updateNotice(): void {
  const notice = client.notice;
  noticeNode?.remove();
  noticeNode = null;
  if (!notice || Date.now() - notice.stamp > 6000) return;
  noticeNode = el('div', { class: 'notice', text: notice.text });
  document.body.append(noticeNode);
  setTimeout(() => {
    if (client.notice === notice) {
      client.notice = null;
      schedule();
    }
  }, 6000);
}

// --------------------------------------------------------------- ticker --

/**
 * Indicador de fala e medidor rodam num timer proprio a 12 Hz: sao a unica
 * parte da tela que muda o tempo todo, e nao vale redesenhar a arvore por isso.
 */
setInterval(() => {
  if (mode !== 'app') return;
  for (const [id, node] of userNodes) node.classList.toggle('talking', client.isTalking(id));
  meterFill.style.width = `${Math.round(client.microphone.level * 100)}%`;
  updateHeader();
}, 80);

// -------------------------------------------------------------- teclado --

let capturing = false;

function keyLabel(code: string): string {
  return code.replace(/^Key|^Digit/, '').replace(/Left$|Right$/, '');
}

function captureKey(): void {
  capturing = true;
  pttButton.textContent = 'pressione uma tecla...';
}

addEventListener('keydown', (ev) => {
  if (capturing) {
    ev.preventDefault();
    capturing = false;
    prefs.pttCode = ev.code;
    savePrefs();
    pttButton.textContent = `Tecla: ${keyLabel(ev.code)}`;
    return;
  }
  if (isTyping(ev.target)) return;
  if (ev.code === prefs.pttCode) client.setPtt(true);
});

addEventListener('keyup', (ev) => {
  if (ev.code === prefs.pttCode) client.setPtt(false);
});

// Soltar a tecla fora da janela nao dispara keyup: corta a transmissao.
addEventListener('blur', () => client.setPtt(false));

function isTyping(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA');
}

// ----------------------------------------------------------------- boot --

void client.applyMicSettings({
  activation: prefs.activation,
  bitrate: prefs.bitrate,
  threshold: prefs.threshold,
  deviceId: prefs.deviceId,
});
client.setOutputVolume(prefs.volume);
render();
