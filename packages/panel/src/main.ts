import './style.css';
import { Group, GROUP_NAMES } from '@vox/protocol';

type ServerSummary = {
  id: number;
  slug: string;
  name: string;
  motd: string;
  clients: number;
  maxClients: number;
  channels: number;
  protected: boolean;
  admins: number;
};

type Overview = {
  servers: ServerSummary[];
  totals: { clients: number; servers: number };
  role: 'master' | 'owner';
  stamp: number;
};

type ChannelInfo = {
  id: number;
  parentId: number;
  order: number;
  name: string;
  topic: string;
  maxClients: number;
  flags: number;
};

type ClientInfo = {
  id: number;
  channelId: number;
  nickname: string;
  flags: number;
  group: Group;
  fingerprint: string;
  connectedAt: number;
  platform: string;
};

type Ban = { fingerprint: string; until: number; reason: string };

type BotState = {
  config: {
    world: string;
    guildName: string;
    huntedNames: string[];
    intervalMs: number;
    channelName: string;
    enabled: boolean;
  };
  running: boolean;
  hunted: string[];
};

type ServerDetail = {
  id: number;
  slug: string;
  url: string;
  name: string;
  motd: string;
  password: string;
  maxClients: number;
  channels: ChannelInfo[];
  clients: ClientInfo[];
  bans: Ban[];
  groups: Record<string, Group>;
};

const TOKEN_KEY = 'vox.admin.token';
const app = document.getElementById('app')!;

let token = sessionStorage.getItem(TOKEN_KEY) ?? '';
let overview: Overview | null = null;
let selectedId = 0;
let detail: ServerDetail | null = null;
let botState: BotState | null = null;
let botDraft: Partial<{ world: string; guildName: string; channelName: string; intervalSec: string }> = {};
let stream: EventSource | null = null;
let notice = '';

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
};

function text(tag: string, cls: string, content: string): HTMLElement {
  const el = $(tag as keyof HTMLElementTagNameMap, cls);
  el.textContent = content;
  return el;
}

function render(): void {
  app.replaceChildren(token ? renderAdmin() : renderLogin());
}

function renderLogin(): HTMLElement {
  const root = $('div', 'login');
  const panel = $('form', 'panel form');
  panel.append(text('h1', '', 'v0x admin'));
  panel.append(text('p', 'subtle', 'Entre com sua conta ou com a senha master.'));

  const email = input('email do cliente (opcional)', '', 'email', 'cliente@exemplo.com');

  const label = $('label', 'form');
  label.append(text('span', 'label', 'senha'));
  const passwordInput = $('input') as HTMLInputElement;
  passwordInput.type = 'password';
  passwordInput.autocomplete = 'current-password';
  label.append(passwordInput);

  const error = text('div', 'error', notice);
  const submit = $('button', 'primary');
  submit.textContent = 'entrar';

  panel.append(email.wrap, label, error, submit);
  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    void login(passwordInput.value, email.input.value.trim());
  });

  root.append(panel);
  requestAnimationFrame(() => (email.input.value ? passwordInput : email.input).focus());
  return root;
}

function renderAdmin(): HTMLElement {
  const root = $('div', 'admin');
  root.append(renderSidebar(), renderMain());
  return root;
}

function renderSidebar(): HTMLElement {
  const side = $('aside', 'sidebar');
  const brand = $('div', 'brand');
  brand.append(text('h1', '', 'v0x'), text('span', 'label', 'admin'));
  side.append(brand);

  const totals = overview?.totals;
  side.append(text('div', 'mono subtle', totals ? `${totals.servers} servidores · ${totals.clients} clientes` : 'carregando...'));

  const list = $('div', 'server-list');
  for (const server of overview?.servers ?? []) {
    const btn = $('button', `server-button${server.id === selectedId ? ' active' : ''}`);
    const label = $('div', '');
    label.append(text('strong', '', server.name));
    label.append(text('div', 'mono subtle', `${server.slug} · ${server.clients}/${server.maxClients}`));
    btn.append(label, text('span', 'mono', String(server.channels)));
    btn.addEventListener('click', () => {
      selectedId = server.id;
      void loadDetail(server.id);
    });
    list.append(btn);
  }
  side.append(list);

  const create = $('button', 'ghost');
  create.textContent = '+ servidor virtual';
  create.addEventListener('click', () => void createServer());
  const logout = $('button', 'danger');
  logout.textContent = 'sair';
  logout.addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_KEY);
    token = '';
    stream?.close();
    render();
  });
  if (overview?.role === 'master') side.append(create);
  side.append(logout);
  return side;
}

function renderMain(): HTMLElement {
  const main = $('main', 'main');
  const server = currentSummary();

  const top = $('div', 'topline');
  top.append(text('h2', '', server?.name ?? 'Painel'));
  const refresh = $('button', 'ghost');
  refresh.textContent = 'atualizar';
  refresh.addEventListener('click', () => void refreshAll());
  top.append(refresh);
  main.append(top);

  if (notice) main.append(text('div', notice.startsWith('erro') ? 'error' : 'subtle', notice));
  if (!server) {
    main.append(text('p', 'subtle', 'Nenhum servidor selecionado.'));
    return main;
  }

  const grid = $('div', 'grid');
  grid.append(stat('clientes', String(server.clients), `limite ${server.maxClients}`, 'span-3'));
  grid.append(stat('canais', String(server.channels), server.protected ? 'com senha' : 'aberto', 'span-3'));
  grid.append(stat('admins', String(server.admins), `servidor #${server.id}`, 'span-3'));
  grid.append(stat('atualizado', overview ? new Date(overview.stamp).toLocaleTimeString() : '--', 'SSE ativo', 'span-3'));

  if (detail) {
    grid.append(renderServerSettings(detail));
    grid.append(renderClients(detail));
    grid.append(renderChannels(detail));
    grid.append(renderBans(detail));
    grid.append(renderAnnouncement(detail));
    if (botState) grid.append(renderBot(detail, botState));
  } else {
    grid.append(text('div', 'panel span-12 subtle', 'carregando detalhes...'));
  }

  main.append(grid);
  return main;
}

function stat(label: string, value: string, hint: string, cls: string): HTMLElement {
  const box = $('div', `panel stat ${cls}`);
  box.append(text('span', 'label', label), text('strong', '', value), text('span', 'mono subtle', hint));
  return box;
}

function renderServerSettings(server: ServerDetail): HTMLElement {
  const box = $('section', 'panel span-6');
  box.append(text('h3', '', 'Servidor'));
  const link = $('a', 'public-link') as HTMLAnchorElement;
  link.href = server.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = server.url;
  box.append(link);
  const form = $('div', 'form two');
  const slug = input('slug publico', server.slug, 'text', 'manowar');
  const name = input('nome', server.name);
  const motd = input('motd', server.motd);
  const max = input('max clientes', String(server.maxClients), 'number');
  if (overview?.role === 'owner') {
    max.input.disabled = true;
    max.input.title = 'Definido pelo plano contratado';
  }
  const pass = input('senha', '', 'password', server.password ? 'definida; preencha para trocar' : 'vazio = aberto');
  const save = $('button', 'primary');
  save.textContent = 'salvar';
  save.addEventListener('click', () => {
    void api(`/api/servers/${server.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: name.input.value,
        slug: slug.input.value.trim(),
        motd: motd.input.value,
        ...(overview?.role === 'master'
          ? { maxClients: Number(max.input.value) || server.maxClients }
          : {}),
        ...(pass.input.value ? { password: pass.input.value } : {}),
      }),
    }).then(() => refreshAll());
  });
  const remove = $('button', 'danger');
  remove.textContent = 'remover';
  remove.addEventListener('click', () => void removeServer(server.id));
  form.append(slug.wrap, name.wrap, motd.wrap, max.wrap, pass.wrap, save, remove);
  box.append(form);
  return box;
}

function renderClients(server: ServerDetail): HTMLElement {
  const box = $('section', 'panel span-6');
  box.append(text('h3', '', 'Clientes online'));
  const rows = $('div', 'table');
  if (server.clients.length === 0) rows.append(text('div', 'subtle', 'ninguém online'));
  for (const client of server.clients) {
    const row = $('div', 'rowline');
    const channel = server.channels.find((c) => c.id === client.channelId);
    const info = $('div', '');
    info.append(text('strong', '', client.nickname));
    info.append(text('div', 'mono subtle', `${GROUP_NAMES[client.group]} · ${channel?.name ?? 'sem canal'} · ${client.platform || 'Web'}`));

    const actions = $('div', 'actions');
    actions.append(action('mover', () => moveClient(server, client)));
    actions.append(action('grupo', () => setGroup(server, client)));
    actions.append(action('kick', () => kick(server, client)));
    actions.append(action('ban', () => ban(server, client), 'danger'));
    row.append(info, actions);
    rows.append(row);
  }
  box.append(rows);
  return box;
}

function renderChannels(server: ServerDetail): HTMLElement {
  const box = $('section', 'panel span-5');
  box.append(text('h3', '', 'Canais'));
  const rows = $('div', 'table');
  for (const channel of [...server.channels].sort((a, b) => a.order - b.order || a.id - b.id)) {
    const members = server.clients.filter((c) => c.channelId === channel.id).length;
    const row = $('div', 'rowline');
    row.append(text('strong', '', channel.name), text('span', 'mono subtle', `${members}/${channel.maxClients || '∞'}`));
    rows.append(row);
  }
  box.append(rows);
  return box;
}

function renderBans(server: ServerDetail): HTMLElement {
  const box = $('section', 'panel span-7');
  box.append(text('h3', '', 'Banimentos'));
  const rows = $('div', 'table');
  if (server.bans.length === 0) rows.append(text('div', 'subtle', 'nenhum ban ativo'));
  for (const ban of server.bans) {
    const row = $('div', 'rowline');
    const until = ban.until === 0 ? 'permanente' : new Date(ban.until).toLocaleString();
    const info = $('div', '');
    info.append(text('strong', 'mono', ban.fingerprint.slice(0, 16)));
    info.append(text('div', 'subtle', `${until} · ${ban.reason}`));
    row.append(info, action('remover', () => unban(server, ban), 'danger'));
    rows.append(row);
  }
  box.append(rows);
  return box;
}

function renderAnnouncement(server: ServerDetail): HTMLElement {
  const box = $('section', 'panel span-12');
  box.append(text('h3', '', 'Anúncio'));
  const form = $('div', 'toolbar');
  const msg = $('input') as HTMLInputElement;
  msg.placeholder = 'mensagem para todos neste servidor';
  const send = $('button', 'primary');
  send.textContent = 'enviar';
  send.addEventListener('click', () => {
    if (!msg.value.trim()) return;
    void api(`/api/servers/${server.id}/announce`, {
      method: 'POST',
      body: JSON.stringify({ text: msg.value.trim() }),
    }).then(() => {
      msg.value = '';
      notice = 'anúncio enviado';
      render();
    });
  });
  form.append(msg, send);
  box.append(form);
  return box;
}

function renderBot(server: ServerDetail, bot: BotState): HTMLElement {
  const box = $('section', 'panel span-12');
  box.append(text('h3', '', 'Bot Rubinot'));

  const statusLine = $('div', 'toolbar');
  const statusLabel = text('span', bot.running ? 'bot-status bot-on' : 'bot-status bot-off', bot.running ? 'ativo' : 'parado');
  statusLine.append(statusLabel);
  const toggle = $('button', bot.running ? 'danger' : 'primary');
  toggle.textContent = bot.running ? 'parar' : 'iniciar';
  toggle.addEventListener('click', () => {
    void api(`/api/servers/${server.id}/bot/${bot.running ? 'stop' : 'start'}`, { method: 'POST' })
      .then(() => loadDetail(server.id));
  });
  statusLine.append(toggle);
  const test = $('button', 'ghost');
  test.textContent = 'testar alerta';
  test.addEventListener('click', () => {
    void api(`/api/servers/${server.id}/bot/test`, { method: 'POST' })
      .then(() => {
        notice = 'alerta de teste enviado';
        render();
      });
  });
  statusLine.append(test);
  box.append(statusLine);

  const form = $('div', 'form two');
  const world = input('world', botDraft.world ?? bot.config.world, 'text', 'ex: Vesperia');
  const guild = input('guild', botDraft.guildName ?? bot.config.guildName, 'text', 'nome da guild (opcional)');
  const channel = input('canal de notificacao', botDraft.channelName ?? bot.config.channelName, 'text', 'bot');
  const interval = input('intervalo (segundos)', botDraft.intervalSec ?? String(bot.config.intervalMs / 1000), 'number');

  world.input.addEventListener('input', () => { botDraft.world = world.input.value; });
  guild.input.addEventListener('input', () => { botDraft.guildName = guild.input.value; });
  channel.input.addEventListener('input', () => { botDraft.channelName = channel.input.value; });
  interval.input.addEventListener('input', () => { botDraft.intervalSec = interval.input.value; });

  const save = $('button', 'primary');
  save.textContent = 'salvar config';
  save.addEventListener('click', () => {
    void api(`/api/servers/${server.id}/bot`, {
      method: 'PATCH',
      body: JSON.stringify({
        world: world.input.value.trim(),
        guildName: guild.input.value.trim(),
        channelName: channel.input.value.trim() || 'bot',
        intervalMs: (Number(interval.input.value) || 60) * 1000,
        enabled: bot.config.enabled,
      }),
    }).then(() => {
      botDraft = {};
      void loadDetail(server.id);
    });
  });

  form.append(world.wrap, guild.wrap, channel.wrap, interval.wrap, save);
  box.append(form);

  // hunted list
  const huntedSection = $('div', 'bot-hunted');
  huntedSection.append(text('h4', '', `Hunted List (${bot.hunted.length})`));

  const addRow = $('div', 'toolbar');
  const addInput = $('input') as HTMLInputElement;
  addInput.placeholder = 'adicionar jogador';
  const addBtn = $('button', 'ghost');
  addBtn.textContent = '+ adicionar';
  addBtn.addEventListener('click', () => {
    const name = addInput.value.trim();
    if (!name) return;
    void api(`/api/servers/${server.id}/bot/hunted`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then(() => {
      addInput.value = '';
      void loadDetail(server.id);
    });
  });
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBtn.click();
  });
  addRow.append(addInput, addBtn);
  huntedSection.append(addRow);

  const list = $('div', 'table');
  if (bot.hunted.length === 0) {
    list.append(text('div', 'subtle', 'nenhum jogador na hunted list'));
  }
  for (const name of bot.hunted.sort()) {
    const row = $('div', 'rowline');
    row.append(text('span', 'mono', name));
    const del = $('button', 'danger');
    del.textContent = 'remover';
    del.addEventListener('click', () => {
      void api(`/api/servers/${server.id}/bot/hunted/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }).then(() => loadDetail(server.id));
    });
    row.append(del);
    list.append(row);
  }
  huntedSection.append(list);
  box.append(huntedSection);

  return box;
}

function input(label: string, value: string, type = 'text', placeholder = ''): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = $('label', 'form');
  wrap.append(text('span', 'label', label));
  const field = $('input') as HTMLInputElement;
  field.type = type;
  field.value = value;
  field.placeholder = placeholder;
  wrap.append(field);
  return { wrap, input: field };
}

function action(label: string, run: () => void, cls = 'ghost'): HTMLButtonElement {
  const btn = $('button', cls);
  btn.textContent = label;
  btn.addEventListener('click', run);
  return btn;
}

async function login(password: string, email = ''): Promise<void> {
  try {
    const res = await fetch(email ? '/api/account/login' : '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(email ? { email, password } : { password }),
    });
    const body = (await res.json()) as { token?: string; error?: string };
    if (!res.ok || !body.token) throw new Error(body.error || 'login recusado');
    token = body.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    notice = '';
    await refreshAll();
    openStream();
  } catch (err) {
    notice = err instanceof Error ? err.message : String(err);
    render();
  }
}

async function refreshAll(): Promise<void> {
  await loadOverview();
  if (!selectedId) selectedId = overview?.servers[0]?.id ?? 0;
  if (selectedId) await loadDetail(selectedId);
  render();
}

async function loadOverview(): Promise<void> {
  overview = await api<Overview>('/api/overview');
  if (selectedId && !overview.servers.some((s) => s.id === selectedId)) {
    selectedId = overview.servers[0]?.id ?? 0;
    detail = null;
  }
}

async function loadDetail(id: number): Promise<void> {
  detail = await api<ServerDetail>(`/api/servers/${id}`);
  try {
    botState = await api<BotState>(`/api/servers/${id}/bot`);
  } catch {
    botState = null;
  }
  render();
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body as T;
}

function openStream(): void {
  stream?.close();
  stream = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
  stream.onmessage = (ev) => {
    overview = JSON.parse(ev.data) as Overview;
    if (!selectedId) selectedId = overview.servers[0]?.id ?? 0;
    render();
  };
}

function currentSummary(): ServerSummary | undefined {
  return overview?.servers.find((s) => s.id === selectedId) ?? overview?.servers[0];
}

async function createServer(): Promise<void> {
  const name = prompt('Nome do servidor virtual', `Servidor ${(overview?.totals.servers ?? 0) + 1}`);
  if (!name) return;
  const slug = prompt('Slug publico (ex: manowar)', name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  if (!slug) return;
  const ownerEmail = prompt('Email do dono (vazio = somente master)', '')?.trim() ?? '';
  let ownerId: number | null = null;
  if (ownerEmail) {
    const ownerPassword = prompt('Senha inicial do dono (minimo 8 caracteres)', '') ?? '';
    const account = await api<{ id: number }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    });
    ownerId = account.id;
  }
  const created = await api<{ id: number; url: string }>('/api/servers', {
    method: 'POST',
    body: JSON.stringify({ name, slug, ownerId, maxClients: 128 }),
  });
  notice = `servidor criado: ${created.url}`;
  selectedId = created.id;
  await refreshAll();
}

async function removeServer(id: number): Promise<void> {
  if (!confirm('Remover este servidor virtual?')) return;
  await api(`/api/servers/${id}`, { method: 'DELETE' });
  selectedId = 0;
  detail = null;
  await refreshAll();
}

function moveClient(server: ServerDetail, client: ClientInfo): void {
  const choices = server.channels.map((c) => `${c.id}: ${c.name}`).join('\n');
  const raw = prompt(`Mover ${client.nickname} para qual canal?\n${choices}`, String(client.channelId));
  const channelId = Number(raw);
  if (!channelId) return;
  void api(`/api/servers/${server.id}/move`, {
    method: 'POST',
    body: JSON.stringify({ clientId: client.id, channelId }),
  }).then(() => refreshAll());
}

function setGroup(server: ServerDetail, client: ClientInfo): void {
  const raw = prompt('Grupo: 0 convidado, 1 moderador, 2 admin, 3 dono', String(client.group));
  const group = Number(raw);
  if (!Number.isInteger(group) || group < Group.Guest || group > Group.Owner) return;
  void api(`/api/servers/${server.id}/group`, {
    method: 'POST',
    body: JSON.stringify({ fingerprint: client.fingerprint, group }),
  }).then(() => refreshAll());
}

function kick(server: ServerDetail, client: ClientInfo): void {
  const reason = prompt(`Motivo para expulsar ${client.nickname}`, 'expulso pelo painel') ?? '';
  void api(`/api/servers/${server.id}/kick`, {
    method: 'POST',
    body: JSON.stringify({ clientId: client.id, reason }),
  }).then(() => refreshAll());
}

function ban(server: ServerDetail, client: ClientInfo): void {
  const minutes = Number(prompt(`Minutos de ban para ${client.nickname}`, '60') ?? '0');
  const reason = prompt('Motivo', 'banido pelo painel') ?? '';
  void api(`/api/servers/${server.id}/ban`, {
    method: 'POST',
    body: JSON.stringify({ clientId: client.id, minutes, reason }),
  }).then(() => refreshAll());
}

function unban(server: ServerDetail, ban: Ban): void {
  void api(`/api/servers/${server.id}/bans/${encodeURIComponent(ban.fingerprint)}`, {
    method: 'DELETE',
  }).then(() => refreshAll());
}

if (token) {
  void refreshAll().catch((err) => {
    notice = err instanceof Error ? `erro: ${err.message}` : 'erro ao carregar';
    sessionStorage.removeItem(TOKEN_KEY);
    token = '';
    render();
  });
  openStream();
}

render();
