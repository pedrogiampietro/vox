import './style.css';
import { Group, GROUP_NAMES, SERVER_PRESETS } from '@vox/protocol';

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
  orders: AccountOrder[];
  totals: { clients: number; servers: number };
  role: 'master' | 'owner';
  stamp: number;
};

type AccountOrder = {
  id: string;
  plan: string;
  kind: 'initial' | 'renewal';
  amountCents: number;
  status: 'pending' | 'approved' | 'failed';
  paidAt: number | null;
  expiresAt: number | null;
  paymentMethodId: string;
  paymentTypeId: string;
  createdAt: number;
  server?: { id: number; name: string; slug: string; maxClients: number; url: string };
};

type AdminTab = 'overview' | 'server' | 'users' | 'channels' | 'bans' | 'bot' | 'billing' | 'tickets' | 'audit';

type AuditEntry = {
  id: number;
  at: number;
  actor: 'master' | 'owner' | 'anon' | 'system';
  actorAccountId: number | null;
  ip: string;
  action: string;
  serverId: number | null;
  detail: Record<string, unknown>;
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
type TicketStatus = 'open' | 'waiting' | 'resolved' | 'closed';
type TicketMessage = {
  id: number;
  authorRole: 'owner' | 'master';
  authorAccountId: number | null;
  body: string;
  createdAt: number;
};
type Ticket = {
  id: string;
  accountId: number;
  serverId: number | null;
  serverName: string;
  subject: string;
  status: TicketStatus;
  createdAt: number;
  updatedAt: number;
  messages: TicketMessage[];
};

type BotState = {
  provider: string;
  providerLabel: string;
  config: {
    world: string;
    guildName: string;
    huntedNames: string[];
    friendGuilds: string[];
    enemyGuilds: string[];
    intervalMs: number;
    channelName: string;
    enabled: boolean;
    globalDeaths: boolean;
    globalKills: boolean;
    globalLevelMin: number;
    summarizePresence: boolean;
    presenceSummaryMs: number;
    alertEnemyDeath: boolean;
    alertFriendDeath: boolean;
    alertFriendLevelUp: boolean;
    alertEnemyLevelUp: boolean;
    alertEnemyOnline: boolean;
    alertEnemyOffline: boolean;
  };
  running: boolean;
  starting: boolean;
  error: string;
  hunted: string[];
  friends: string[];
  friendGuilds: string[];
  enemyGuilds: string[];
};

type ServerDetail = {
  id: number;
  slug: string;
  url: string;
  name: string;
  motd: string;
  password: string;
  maxClients: number;
  presetId: string;
  provider: string;
  providerLabel: string;
  channels: ChannelInfo[];
  clients: ClientInfo[];
  bans: Ban[];
  groups: Record<string, Group>;
};

const TOKEN_KEY = 'vox.admin.token';
const app = document.getElementById('app')!;

let token = sessionStorage.getItem(TOKEN_KEY) ?? '';
let overview: Overview | null = null;
let selectedId = Number(new URLSearchParams(location.search).get('server') ?? 0) || 0;
let detail: ServerDetail | null = null;
let botState: BotState | null = null;
let tickets: Ticket[] = [];
let audit: AuditEntry[] = [];
let ticketDraft = { subject: '', message: '' };
const ticketReplyDrafts = new Map<string, string>();
let botDraft: Partial<{
  world: string;
  guildName: string;
  channelName: string;
  intervalSec: string;
  globalLevelMin: string;
  presenceSummarySec: string;
}> = {};
let stream: EventSource | null = null;
let notice = '';
let activeTab: AdminTab = 'overview';
let renewingServerId = 0;
let loggingIn = false;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let botAction: { serverId: number; label: string } | null = null;

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

function showToast(message: string, kind: 'success' | 'error' | 'info' = 'info'): void {
  document.querySelector('.toast')?.remove();
  if (toastTimer !== null) clearTimeout(toastTimer);

  const toast = $('div', `toast toast-${kind}`);
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  toast.append(
    text('span', 'toast-mark', kind === 'success' ? '✓' : kind === 'error' ? '!' : 'i'),
    text('span', '', message),
  );
  document.body.append(toast);
  toastTimer = setTimeout(() => {
    toast.remove();
    toastTimer = null;
  }, 4200);
}

function render(): void {
  app.replaceChildren(token ? renderAdmin() : renderLogin());
}

function renderLogin(): HTMLElement {
  const root = $('div', 'login');
  const panel = $('form', 'panel form login-panel');
  const heading = $('div', 'login-heading');
  heading.append(
    text('span', 'login-kicker', 'CENTRAL DE GESTÃO'),
    text('h1', '', 'Vox Painel'),
    text('p', 'subtle', 'Entre com sua conta ou com a senha master.'),
  );
  panel.append(heading);

  const email = input('email do cliente (opcional)', '', 'email', 'cliente@exemplo.com');

  const label = $('label', 'form');
  label.append(text('span', 'label', 'senha'));
  const passwordInput = $('input') as HTMLInputElement;
  passwordInput.type = 'password';
  passwordInput.autocomplete = 'current-password';
  label.append(passwordInput);

  const error = text('div', 'error', notice);
  const submit = $('button', 'primary');
  submit.type = 'submit';
  submit.disabled = loggingIn;
  submit.setAttribute('aria-busy', String(loggingIn));
  if (loggingIn) {
    submit.append($('span', 'loading-spinner'), text('span', '', 'Entrando…'));
  } else {
    submit.textContent = 'Entrar';
  }

  email.input.disabled = loggingIn;
  passwordInput.disabled = loggingIn;

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
  brand.append(text('h1', '', 'v0x'), text('span', 'label', 'painel'));
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
  create.textContent = '+ Servidor Virtual';
  create.addEventListener('click', () => void createServer());
  const logout = $('button', 'danger');
  logout.textContent = 'Sair';
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
  refresh.textContent = 'Atualizar';
  refresh.addEventListener('click', () => void refreshAll());
  top.append(refresh);
  main.append(top, renderTabs());

  if (notice) main.append(text('div', notice.startsWith('erro') ? 'error' : 'subtle', notice));
  if (!server) {
    main.append(text('p', 'subtle', 'Nenhum servidor selecionado.'));
    return main;
  }

  const grid = $('div', 'grid');
  if (detail) {
    if (activeTab === 'overview') {
      grid.append(stat('clientes', String(server.clients), `limite ${server.maxClients}`, 'span-3'));
      grid.append(stat('canais', String(server.channels), server.protected ? 'com senha' : 'aberto', 'span-3'));
      grid.append(stat('admins', String(server.admins), `servidor #${server.id}`, 'span-3'));
      grid.append(stat('atualizado', overview ? new Date(overview.stamp).toLocaleTimeString() : '--', 'SSE ativo', 'span-3'));
      grid.append(renderServerSettings(detail), renderClients(detail), renderDownloads());
    } else if (activeTab === 'server') {
      grid.append(renderServerSettings(detail), renderAnnouncement(detail));
    } else if (activeTab === 'users') {
      grid.append(renderClients(detail));
    } else if (activeTab === 'channels') {
      grid.append(renderChannels(detail));
    } else if (activeTab === 'bans') {
      grid.append(renderBans(detail));
    } else if (activeTab === 'bot') {
      grid.append(botState
        ? renderBot(detail, botState)
        : emptyTab('Bot', 'Não foi possível carregar o estado do bot.'));
    } else if (activeTab === 'billing') {
      grid.append(renderBilling(detail));
    } else if (activeTab === 'tickets') {
      grid.append(renderTickets(server));
    } else if (activeTab === 'audit') {
      grid.append(renderAudit());
    }
  } else {
    grid.append(text('div', 'panel span-12 subtle', 'carregando detalhes...'));
  }

  main.append(grid);
  return main;
}

function renderTabs(): HTMLElement {
  const nav = $('nav', 'admin-tabs');
  nav.setAttribute('aria-label', 'Seções do painel');
  nav.setAttribute('role', 'tablist');
  const tabs: [AdminTab, string, string][] = [
    ['overview', 'Visão Geral', '⌂'],
    ['server', 'Servidor', '◈'],
    ['users', 'Usuários', '●'],
    ['channels', 'Canais', '⌗'],
    ['bans', 'Banimentos', '⊘'],
    ['bot', 'Bot', '✦'],
    ['billing', 'Faturamento', '◫'],
    ['tickets', 'Tickets', '◇'],
    ['audit', 'Auditoria', '⎈'],
  ];
  for (const [id, label, icon] of tabs) {
    const button = $('button', `tab-button${activeTab === id ? ' active' : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.append(text('span', 'tab-icon', icon), text('span', 'tab-label', label));
    button.setAttribute('aria-selected', String(activeTab === id));
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => {
      activeTab = id;
      render();
    });
    nav.append(button);
  }
  return nav;
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
  const preset = $('label', 'form');
  preset.append(text('span', 'label', 'provider do bot e preset'));
  preset.append(text('strong', '', server.providerLabel || 'Sem bot'));
  const save = $('button', 'primary');
  save.textContent = 'Salvar';
  save.addEventListener('click', () => {
    void api(`/api/servers/${server.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: name.input.value,
        slug: slug.input.value.trim(),
        motd: motd.input.value,
        ...(overview?.role === 'master'
          ? {
              maxClients: Number(max.input.value) || server.maxClients,
            }
          : {}),
        ...(pass.input.value ? { password: pass.input.value } : {}),
      }),
    }).then(() => {
      showToast('Configuração do servidor salva.', 'success');
      return refreshAll();
    }).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
  });
  const remove = $('button', 'danger');
  remove.textContent = 'Remover';
  remove.addEventListener('click', () => void removeServer(server.id));
  form.append(slug.wrap, name.wrap, motd.wrap, max.wrap, pass.wrap, preset, save, remove);
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
    actions.append(action('Mover', () => moveClient(server, client)));
    actions.append(action('Grupo', () => setGroup(server, client)));
    actions.append(action('Kick', () => kick(server, client)));
    actions.append(action('Banir', () => ban(server, client), 'danger'));
    row.append(info, actions);
    rows.append(row);
  }
  box.append(rows);
  return box;
}

/** Rotulos legiveis para as acoes gravadas pelo servidor. */
const AUDIT_LABELS: Record<string, string> = {
  'auth.master.ok': 'login master',
  'auth.master.fail': 'senha master incorreta',
  'auth.account.ok': 'login de cliente',
  'auth.account.fail': 'senha de cliente incorreta',
  'account.register': 'conta criada',
  'account.provision': 'servidor comunidade criado',
  'account.checkout': 'checkout iniciado',
  'account.renew': 'renovação iniciada',
  'billing.order.approved': 'pagamento aprovado',
  'billing.renewal.approved': 'renovação aprovada',
  'billing.webhook.reject': 'webhook recusado',
  'server.create': 'servidor criado',
  'server.update': 'servidor alterado',
  'server.delete': 'servidor removido',
  'server.announce': 'anúncio',
  'client.kick': 'kick',
  'client.ban': 'ban',
  'client.move': 'usuário movido',
  'client.group': 'grupo alterado',
  'ban.remove': 'ban removido',
  'bot.config': 'bot reconfigurado',
  'bot.start': 'bot ligado',
  'bot.stop': 'bot desligado',
  'bot.restart': 'bot reiniciado',
  'bot.test': 'alerta de teste',
  'ticket.status': 'status de ticket',
  'system.backup': 'backup do banco',
};

/** Acoes que merecem destaque visual quando aparecem na lista. */
const AUDIT_ALERTS = new Set([
  'auth.master.fail',
  'auth.account.fail',
  'billing.webhook.reject',
  'server.delete',
  'client.ban',
]);

function renderAudit(): HTMLElement {
  const box = $('section', 'panel span-12');
  box.append(text('h3', '', 'Auditoria'));
  box.append(text('p', 'subtle', overview?.role === 'master'
    ? 'Toda ação administrativa registrada, incluindo login e cobrança.'
    : 'Ações registradas na sua conta e nos seus servidores.'));

  const rows = $('div', 'table');
  if (audit.length === 0) {
    rows.append(text('div', 'subtle', 'nenhum registro ainda'));
  }
  for (const entry of audit) {
    const row = $('div', `rowline audit-row${AUDIT_ALERTS.has(entry.action) ? ' audit-alert' : ''}`);
    const info = $('div', '');
    info.append(text('strong', '', AUDIT_LABELS[entry.action] ?? entry.action));
    const who = entry.actor === 'master' || entry.actor === 'system'
      ? entry.actor
      : entry.actorAccountId === null ? 'anônimo' : `conta #${entry.actorAccountId}`;
    const detail = auditDetail(entry.detail);
    const where = entry.serverId === null ? 'conta' : serverLabel(entry.serverId);
    info.append(text('div', 'mono subtle', `${who} · ${where} · ${entry.ip || 'sem ip'}${detail ? ` · ${detail}` : ''}`));
    row.append(info, text('span', 'mono subtle', formatDateTime(entry.at)));
    rows.append(row);
  }
  box.append(rows);
  return box;
}

/** Nome do servidor quando ainda existe; o id sozinho quando ja foi removido. */
function serverLabel(serverId: number): string {
  const server = overview?.servers.find((candidate) => candidate.id === serverId);
  return server ? server.name : `servidor #${serverId}`;
}

/** `{alvo: "Fulano", motivo: "spam"}` -> `alvo=Fulano · motivo=spam`. */
function auditDetail(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join(' · ')
    .slice(0, 200);
}

/**
 * Instaladores do desktop, servidos pelas releases do GitHub. O `latest` deixa
 * o link fixo: a versao vive na tag e o nome do arquivo nao muda.
 */
const DESKTOP_LATEST = 'https://github.com/pedrogiampietro/v0x-desktop/releases/latest/download';

function renderDownloads(): HTMLElement {
  const box = $('section', 'panel span-12');
  box.append(text('h3', '', 'Aplicativo'));
  box.append(text('p', 'subtle', 'O cliente web abre direto no navegador. No Windows, o app dedicado entra com o mesmo login.'));
  const actions = $('div', 'actions');
  actions.append(
    action('Abrir versão web', () => window.open('/app', '_blank', 'noopener')),
    action('Baixar .EXE', () => window.open(`${DESKTOP_LATEST}/v0x-windows-x64-setup.exe`, '_blank', 'noopener')),
    action('Baixar .MSI', () => window.open(`${DESKTOP_LATEST}/v0x-windows-x64.msi`, '_blank', 'noopener')),
  );
  box.append(actions);
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
    row.append(info, action('Remover', () => unban(server, ban), 'danger'));
    rows.append(row);
  }
  box.append(rows);
  return box;
}

function renderBilling(server: ServerDetail): HTMLElement {
  const box = $('section', 'panel span-12');
  box.append(text('h3', '', 'Faturamento do servidor'));
  const orders = (overview?.orders ?? []).filter((order) => order.server?.id === server.id);
  if (orders.length === 0) {
    box.append(text('p', 'subtle', overview?.role === 'master'
      ? 'Entre com a conta do cliente para consultar pagamentos e renovações deste servidor.'
      : 'Nenhuma contratação financeira vinculada a este servidor.'));
    return box;
  }

  const current = orders.find((order) => order.status === 'approved' && order.expiresAt)
    ?? orders.find((order) => order.status === 'approved');
  if (current) {
    const days = daysRemaining(current.expiresAt);
    const summary = $('div', 'billing-summary');
    summary.append(
      billingMetric('plano', planLabel(current.plan)),
      billingMetric('último pagamento', `${paymentLabel(current)} · ${formatDate(current.paidAt)}`),
      billingMetric('vencimento', current.expiresAt
        ? `${formatDate(current.expiresAt)} · ${days > 0 ? `${days} dias restantes` : 'expirado'}`
        : 'não informado'),
    );
    box.append(summary);
    if (overview?.role === 'owner') {
      const renew = $('button', 'primary');
      renew.type = 'button';
      renew.disabled = renewingServerId === server.id;
      renew.textContent = renewingServerId === server.id ? 'Abrindo pagamento…' : 'Renovar por Pix ou Cartão';
      renew.addEventListener('click', () => { void renewServer(server.id); });
      box.append(renew);
    }
  }

  const rows = $('div', 'table');
  for (const order of orders.slice(0, 10)) {
    const row = $('div', 'rowline billing-row');
    const info = $('div', '');
    info.append(
      text('strong', '', `${order.kind === 'renewal' ? 'Renovação' : 'Contratação'} · ${planLabel(order.plan)}`),
      text('div', 'mono subtle', `${orderStatusLabel(order.status)} · ${paymentLabel(order)} · ${formatDate(order.paidAt ?? order.createdAt)}`),
    );
    row.append(info, text('strong', 'mono billing-amount', formatCents(order.amountCents)));
    rows.append(row);
  }
  box.append(rows);
  return box;
}

function renderTickets(server: ServerSummary): HTMLElement {
  const box = $('section', 'panel span-12 ticket-panel');
  box.append(text('h3', '', 'Tickets de suporte'));
  box.append(text('p', 'subtle', 'Central de atendimento para dúvidas, pagamentos e problemas do servidor.'));

  if (overview?.role === 'owner') {
    const compose = $('form', 'ticket-compose');
    const subject = input('assunto', ticketDraft.subject, 'text', 'Ex.: problema ao conectar no QUIC');
    const message = $('textarea') as HTMLTextAreaElement;
    message.value = ticketDraft.message;
    message.placeholder = 'Descreva o que aconteceu…';
    message.rows = 4;
    const send = $('button', 'primary');
    send.type = 'submit';
    send.textContent = 'Abrir Ticket';
    subject.input.addEventListener('input', () => { ticketDraft.subject = subject.input.value; });
    message.addEventListener('input', () => { ticketDraft.message = message.value; });
    compose.append(subject.wrap, message, send);
    compose.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!subject.input.value.trim() || !message.value.trim()) return;
      send.disabled = true;
      void api<{ ticket: Ticket }>('/api/tickets', {
        method: 'POST',
        body: JSON.stringify({ serverId: server.id, subject: subject.input.value, message: message.value }),
      }).then(() => {
        ticketDraft = { subject: '', message: '' };
        showToast('Ticket aberto com sucesso.', 'success');
        return loadTickets();
      }).then(() => render()).catch((error) => {
        send.disabled = false;
        showToast(error instanceof Error ? error.message : String(error), 'error');
      });
    });
    box.append(compose);
  }

  // A aba é central da conta: o servidor selecionado só define o vínculo do
  // novo chamado; tickets de outros servidores continuam visíveis aqui.
  const visible = tickets;
  const list = $('div', 'ticket-list');
  if (visible.length === 0) {
    const empty = $('div', 'ticket-empty');
    empty.append(text('strong', '', 'Nenhum ticket aberto'), text('p', 'subtle', 'Quando precisar de ajuda, abra um ticket acima.'));
    list.append(empty);
  }
  for (const ticket of visible) list.append(renderTicket(ticket));
  box.append(list);
  return box;
}

function renderTicket(ticket: Ticket): HTMLElement {
  const card = $('article', 'ticket-card');
  const header = $('div', 'ticket-header');
  const title = $('div', 'ticket-title');
  title.append(text('strong', '', ticket.subject), text('span', 'mono subtle', `${ticket.serverName} · ${formatDateTime(ticket.updatedAt)}`));
  const status = text('span', `ticket-status ticket-status-${ticket.status}`, ticketStatusLabel(ticket.status));
  header.append(title, status);
  card.append(header);

  const messages = $('div', 'ticket-messages');
  for (const message of ticket.messages) {
    const item = $('div', `ticket-message ticket-message-${message.authorRole}`);
    const meta = message.authorRole === 'master' ? 'Suporte Vox' : 'Você';
    item.append(text('span', 'ticket-message-meta', `${meta} · ${formatDateTime(message.createdAt)}`), text('p', '', message.body));
    messages.append(item);
  }
  card.append(messages);

  if (ticket.status !== 'closed') {
    const actions = $('div', 'ticket-actions');
    const reply = $('textarea') as HTMLTextAreaElement;
    reply.value = ticketReplyDrafts.get(ticket.id) ?? '';
    reply.placeholder = 'Responder ao ticket…';
    reply.rows = 2;
    reply.addEventListener('input', () => ticketReplyDrafts.set(ticket.id, reply.value));
    const replyButton = $('button', 'ghost');
    replyButton.type = 'button';
    replyButton.textContent = 'Responder';
    replyButton.addEventListener('click', () => {
      if (!reply.value.trim()) return;
      replyButton.disabled = true;
      void api<{ ticket: Ticket }>(`/api/tickets/${encodeURIComponent(ticket.id)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ message: reply.value }),
      }).then(() => {
        ticketReplyDrafts.delete(ticket.id);
        showToast('Resposta enviada.', 'success');
        return loadTickets();
      }).then(() => render()).catch((error) => {
        replyButton.disabled = false;
        showToast(error instanceof Error ? error.message : String(error), 'error');
      });
    });
    actions.append(reply, replyButton);
    if (overview?.role === 'master') {
      const select = $('select', 'ticket-status-select') as HTMLSelectElement;
      for (const value of ['open', 'waiting', 'resolved', 'closed'] as TicketStatus[]) {
        const option = $('option') as HTMLOptionElement;
        option.value = value;
        option.textContent = ticketStatusLabel(value);
        option.selected = value === ticket.status;
        select.append(option);
      }
      select.addEventListener('change', () => {
        void api<{ ticket: Ticket }>(`/api/tickets/${encodeURIComponent(ticket.id)}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: select.value }),
        }).then(() => {
          showToast('Status do ticket atualizado.', 'success');
          return loadTickets();
        }).then(() => render()).catch((error) => {
          showToast(error instanceof Error ? error.message : String(error), 'error');
        });
      });
      actions.append(select);
    } else {
      const close = $('button', 'ghost');
      close.type = 'button';
      close.textContent = 'Fechar Ticket';
      close.addEventListener('click', () => {
        void api(`/api/tickets/${encodeURIComponent(ticket.id)}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'closed' }),
        }).then(() => {
          showToast('Ticket fechado.', 'success');
          return loadTickets();
        }).then(() => render()).catch((error) => {
          showToast(error instanceof Error ? error.message : String(error), 'error');
        });
      });
      actions.append(close);
    }
    card.append(actions);
  }
  return card;
}

function ticketStatusLabel(status: TicketStatus): string {
  if (status === 'waiting') return 'Aguardando resposta';
  if (status === 'resolved') return 'Resolvido';
  if (status === 'closed') return 'Fechado';
  return 'Aberto';
}

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('pt-BR');
}

function emptyTab(title: string, message: string): HTMLElement {
  const box = $('section', 'panel span-12');
  box.append(text('h3', '', title), text('p', 'subtle', message));
  return box;
}

function billingMetric(label: string, value: string): HTMLElement {
  const item = $('div', 'billing-metric');
  item.append(text('span', 'label', label), text('strong', '', value));
  return item;
}

function formatCents(value: number): string {
  return (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDate(value: number | null): string {
  return value ? new Date(value).toLocaleDateString('pt-BR') : '—';
}

function daysRemaining(value: number | null): number {
  return value ? Math.ceil((value - Date.now()) / (24 * 60 * 60 * 1000)) : 0;
}

function planLabel(plan: string): string {
  const labels: Record<string, string> = {
    '50-basic': 'Vox 50 · sem bot',
    '50-bot': 'Vox 50 · Rubinot',
    '100-basic': 'Vox 100 · sem bot',
    '100-bot': 'Vox 100 · Rubinot',
    '254-basic': 'Vox 254 · sem bot',
    '254-bot': 'Vox 254 · Rubinot',
  };
  return labels[plan] ?? plan;
}

function paymentLabel(order: AccountOrder): string {
  if (order.paymentTypeId === 'bank_transfer' || order.paymentMethodId === 'pix') return 'Pix';
  if (order.paymentTypeId === 'credit_card' || order.paymentMethodId === 'credit_card') return 'Cartão';
  return order.paymentTypeId || order.paymentMethodId || 'Mercado Pago';
}

function orderStatusLabel(status: AccountOrder['status']): string {
  if (status === 'approved') return 'aprovado';
  if (status === 'failed') return 'falhou';
  return 'aguardando pagamento';
}

async function renewServer(serverId: number): Promise<void> {
  if (renewingServerId) return;
  renewingServerId = serverId;
  notice = '';
  render();
  try {
    const result = await api<{ initPoint?: string; error?: string }>(`/api/account/servers/${serverId}/renew`, { method: 'POST' });
    if (!result.initPoint) throw new Error(result.error || 'não foi possível iniciar a renovação');
    window.location.assign(result.initPoint);
  } catch (error) {
    renewingServerId = 0;
    notice = error instanceof Error ? error.message : String(error);
    showToast(notice, 'error');
    render();
  }
}

function renderAnnouncement(server: ServerDetail): HTMLElement {
  const box = $('section', 'panel span-12');
  box.append(text('h3', '', 'Anúncio'));
  const form = $('div', 'toolbar');
  const msg = $('input') as HTMLInputElement;
  msg.placeholder = 'mensagem para todos neste servidor';
  const send = $('button', 'primary');
  send.textContent = 'Enviar';
  send.addEventListener('click', () => {
    if (!msg.value.trim()) return;
    void api(`/api/servers/${server.id}/announce`, {
      method: 'POST',
      body: JSON.stringify({ text: msg.value.trim() }),
    }).then(() => {
      msg.value = '';
      notice = '';
      showToast('Anúncio enviado.', 'success');
      render();
    }).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
  });
  form.append(msg, send);
  box.append(form);
  return box;
}

function renderBot(server: ServerDetail, bot: BotState): HTMLElement {
  const box = $('section', 'panel span-12');
  box.append(text('h3', '', `Bot ${bot.providerLabel || server.providerLabel || 'Vox'}`));

  const providerField = $('label', 'form bot-provider-field');
  providerField.append(text('span', 'label', 'Provider do bot'));
  const providerSelect = $('select') as HTMLSelectElement;
  if (!SERVER_PRESETS.some((option) => option.id === server.presetId)) {
    const custom = $('option') as HTMLOptionElement;
    custom.value = server.presetId;
    custom.textContent = 'Personalizado (somente pelo cliente)';
    custom.selected = true;
    custom.disabled = true;
    providerSelect.append(custom);
  }
  for (const option of SERVER_PRESETS) {
    const item = $('option') as HTMLOptionElement;
    item.value = option.id;
    item.textContent = option.name;
    item.selected = option.id === server.presetId;
    providerSelect.append(item);
  }
  providerSelect.addEventListener('change', () => {
    const selectedPreset = providerSelect.value;
    providerSelect.disabled = true;
    void api(`/api/servers/${server.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ presetId: selectedPreset }),
    }).then(() => {
      botDraft = {};
      const label = SERVER_PRESETS.find((option) => option.id === selectedPreset)?.name ?? selectedPreset;
      showToast(`Provider alterado para ${label}. O bot foi parado; revise o world antes de iniciar.`, 'success');
      return loadDetail(server.id);
    }).catch((error) => {
      providerSelect.disabled = false;
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
  });
  providerField.append(providerSelect);
  box.append(providerField);

  if (bot.provider === 'none') {
    box.append(text('p', 'subtle', 'Este servidor está sem bot. Selecione Rubinot, DeusOT ou DeusOLD para habilitar um provider.'));
    return box;
  }

  box.append(text('h4', 'bot-section-title', 'CONEXÃO'));
  const statusLine = $('div', 'toolbar');
  const busy = botAction?.serverId === server.id || bot.starting;
  const statusLabel = text(
    'span',
    busy ? 'bot-status bot-pending' : bot.running ? 'bot-status bot-on' : 'bot-status bot-off',
    busy ? (botAction?.serverId === server.id ? botAction.label : 'sincronizando…') : bot.running ? 'ativo' : 'parado',
  );
  statusLine.append(statusLabel);
  if (busy) {
    statusLine.append(text('span', 'subtle', 'validando world, guilds e canais…'));
  }
  box.append(statusLine);
  if (bot.error && !busy) {
    box.append(text('p', 'error bot-error', `Última tentativa: ${bot.error}`));
  }

  if (bot.provider === 'deusold') {
    box.append(text(
      'p',
      'subtle bot-section-hint',
      'O DeusOLD publica mortes, guilds e fichas, mas não publica o roster de jogadores online. Alertas de online/offline ficam indisponíveis nesse provider.',
    ));
  }

  box.append(text('p', 'subtle bot-section-hint', 'Configure a conexão com o mundo e o canal que receberá os alertas.'));
  const connectionForm = $('div', 'form two');
  const world = input('world', botDraft.world ?? bot.config.world, 'text', 'ex: Vesperia');
  const channel = input('canal de notificacao', botDraft.channelName ?? bot.config.channelName, 'text', 'bot');
  const interval = input('intervalo (segundos)', botDraft.intervalSec ?? String(bot.config.intervalMs / 1000), 'number');

  world.input.addEventListener('input', () => { botDraft.world = world.input.value; });
  channel.input.addEventListener('input', () => { botDraft.channelName = channel.input.value; });
  interval.input.addEventListener('input', () => { botDraft.intervalSec = interval.input.value; });

  connectionForm.append(world.wrap, channel.wrap, interval.wrap);
  box.append(connectionForm);

  box.append(text('h4', 'bot-section-title', 'ALERTAS'));
  box.append(text('p', 'subtle bot-section-hint', 'Escolha o que o bot deve postar no canal.'));
  const alertEnemyDeath = checkbox('morte de inimigo', bot.config.alertEnemyDeath);
  const alertFriendDeath = checkbox('morte de amigo', bot.config.alertFriendDeath);
  const alertFriendLevelUp = checkbox('level up de amigo', bot.config.alertFriendLevelUp);
  const alertEnemyLevelUp = checkbox('level up de inimigo', bot.config.alertEnemyLevelUp);
  const alertEnemyOnline = checkbox('inimigo online', bot.config.alertEnemyOnline);
  const alertEnemyOffline = checkbox('inimigo offline', bot.config.alertEnemyOffline);
  const alerts = $('div', 'form two bot-check-grid');
  alerts.append(
    alertEnemyDeath.wrap,
    alertFriendDeath.wrap,
    alertFriendLevelUp.wrap,
    alertEnemyLevelUp.wrap,
    alertEnemyOnline.wrap,
    alertEnemyOffline.wrap,
  );
  box.append(alerts);

  box.append(text('h4', 'bot-section-title', 'BROADCAST'));
  box.append(text('p', 'subtle bot-section-hint', 'Envie também para quem está fora do canal do bot.'));
  const globalLevelMin = input('nivel minimo (levelup global)', botDraft.globalLevelMin ?? String(bot.config.globalLevelMin), 'number');
  const presenceSummaryMin = input(
    'resumo presenca (min)',
    botDraft.presenceSummarySec ? String(Number(botDraft.presenceSummarySec) / 60) : String(bot.config.presenceSummaryMs / 60_000),
    'number',
  );
  const globalDeaths = checkbox('mortes globais', bot.config.globalDeaths);
  const globalKills = checkbox('kills globais', bot.config.globalKills);
  const summarizePresence = checkbox('resumir login/logout', bot.config.summarizePresence);
  const enabled = checkbox('habilitar bot', bot.config.enabled);
  const broadcast = $('div', 'form two bot-check-grid');
  broadcast.append(
    globalLevelMin.wrap,
    presenceSummaryMin.wrap,
    globalDeaths.wrap,
    globalKills.wrap,
    summarizePresence.wrap,
    enabled.wrap,
  );
  box.append(broadcast);

  const actions = $('div', 'toolbar bot-actions');
  const save = $('button', 'primary');
  save.textContent = 'Salvar Configuração';
  save.disabled = busy;
  save.setAttribute('aria-busy', String(botAction?.serverId === server.id && botAction.label.startsWith('Salvando')));
  save.addEventListener('click', () => {
    if (botAction?.serverId === server.id || bot.starting) return;
    botAction = { serverId: server.id, label: 'Salvando e sincronizando…' };
    render();
    void api(`/api/servers/${server.id}/bot`, {
      method: 'PATCH',
      body: JSON.stringify({
        world: world.input.value.trim(),
        guildName: bot.config.guildName,
        channelName: channel.input.value.trim() || 'bot',
        intervalMs: (Number(interval.input.value) || 60) * 1000,
        globalDeaths: globalDeaths.input.checked,
        globalKills: globalKills.input.checked,
        globalLevelMin: Number(globalLevelMin.input.value) || 0,
        summarizePresence: summarizePresence.input.checked,
        presenceSummaryMs: (Number(presenceSummaryMin.input.value) || 5) * 60 * 1000,
        enabled: enabled.input.checked,
        alertEnemyDeath: alertEnemyDeath.input.checked,
        alertFriendDeath: alertFriendDeath.input.checked,
        alertFriendLevelUp: alertFriendLevelUp.input.checked,
        alertEnemyLevelUp: alertEnemyLevelUp.input.checked,
        alertEnemyOnline: alertEnemyOnline.input.checked,
        alertEnemyOffline: alertEnemyOffline.input.checked,
      }),
    }).then(() => {
      botDraft = {};
      showToast('Configuração salva e bot sincronizado.', 'success');
      return loadDetail(server.id);
    }).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), 'error');
      void loadDetail(server.id).catch(() => {});
    }).finally(() => {
      if (botAction?.serverId === server.id) botAction = null;
      render();
    });
  });
  actions.append(save);

  const run = $('button', bot.running ? 'ghost' : 'primary');
  run.textContent = busy ? (bot.running ? 'Reiniciando…' : 'Iniciando…') : bot.running ? 'Reiniciar' : 'Iniciar';
  run.disabled = busy;
  run.setAttribute('aria-busy', String(busy));
  run.addEventListener('click', () => {
    if (botAction?.serverId === server.id || bot.starting) return;
    const action = bot.running ? 'restart' : 'start';
    botAction = { serverId: server.id, label: bot.running ? 'Reiniciando…' : 'Iniciando…' };
    render();
    void api(`/api/servers/${server.id}/bot/${action}`, { method: 'POST' })
      .then(() => {
        showToast(bot.running ? 'Bot reiniciado.' : 'Bot iniciado.', 'success');
        return loadDetail(server.id);
      }).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 'error');
        void loadDetail(server.id).catch(() => {});
      }).finally(() => {
        if (botAction?.serverId === server.id) botAction = null;
        render();
      });
  });
  actions.append(run);

  if (bot.running) {
    const stop = $('button', 'danger');
    stop.textContent = 'Parar';
    stop.addEventListener('click', () => {
      void api(`/api/servers/${server.id}/bot/stop`, { method: 'POST' })
        .then(() => {
          showToast('Bot parado.', 'success');
          return loadDetail(server.id);
        }).catch((error) => {
          showToast(error instanceof Error ? error.message : String(error), 'error');
        });
    });
    actions.append(stop);
  }

  const test = $('button', 'ghost');
  test.textContent = 'Enviar Teste';
  test.addEventListener('click', () => {
    void api(`/api/servers/${server.id}/bot/test`, { method: 'POST' })
      .then(() => showToast('Alerta de teste enviado.', 'success'))
      .catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      });
  });
  actions.append(test);
  box.append(actions);

  box.append(renderBotGuildSection(
    server,
    `GUILDS AMIGAS (${bot.friendGuilds.length})`,
    'Membros viram amigos; a tag [GUILD] aparece nos alertas.',
    bot.friendGuilds,
    'friend',
  ));
  box.append(renderBotGuildSection(
    server,
    `GUILDS INIMIGAS (${bot.enemyGuilds.length})`,
    'Todos os membros são tratados como inimigos.',
    bot.enemyGuilds,
    'enemy',
  ));

  // inimigos manuais
  const huntedSection = $('div', 'bot-hunted');
  huntedSection.append(text('h4', 'bot-section-title', `INIMIGOS MANUAIS (${bot.hunted.length})`));
  huntedSection.append(text('p', 'subtle bot-section-hint', 'Nomes soltos, sem guild associada.'));

  const addRow = $('div', 'toolbar');
  const addInput = $('input') as HTMLInputElement;
  addInput.placeholder = 'adicionar jogador';
  const addBtn = $('button', 'ghost');
  addBtn.textContent = '+ Adicionar';
  addBtn.addEventListener('click', () => {
    const name = addInput.value.trim();
    if (!name) return;
    void api(`/api/servers/${server.id}/bot/hunted`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then(() => {
      addInput.value = '';
      showToast('Jogador adicionado à Hunted List.', 'success');
      return loadDetail(server.id);
    }).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
  });
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBtn.click();
  });
  addRow.append(addInput, addBtn);
  if (bot.hunted.length > 0) {
    const clearBtn = $('button', 'danger');
    clearBtn.textContent = 'Limpar Lista Manual';
    clearBtn.title = 'Remove os jogadores adicionados manualmente; guilds inimigas continuam configuradas.';
    clearBtn.addEventListener('click', () => {
      if (!window.confirm('Remover todos os jogadores adicionados manualmente? As guilds inimigas continuarão configuradas.')) return;
      clearBtn.disabled = true;
      void api(`/api/servers/${server.id}/bot/hunted`, { method: 'DELETE' })
        .then(() => {
          showToast('Lista manual limpa.', 'success');
          return loadDetail(server.id);
        }).catch((error) => {
          clearBtn.disabled = false;
          showToast(error instanceof Error ? error.message : String(error), 'error');
        });
    });
    addRow.append(clearBtn);
  }
  huntedSection.append(addRow);

  const list = $('div', 'table');
  if (bot.hunted.length === 0) {
    list.append(text('div', 'subtle', 'nenhum inimigo cadastrado'));
  }
  for (const name of [...bot.hunted].sort()) {
    const row = $('div', 'rowline');
    row.append(text('span', 'mono', name));
    const del = $('button', 'danger');
    del.textContent = 'Remover';
    del.addEventListener('click', () => {
      void api(`/api/servers/${server.id}/bot/hunted/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }).then(() => {
        showToast('Jogador removido da Hunted List.', 'success');
        return loadDetail(server.id);
      }).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      });
    });
    row.append(del);
    list.append(row);
  }
  huntedSection.append(list);
  box.append(huntedSection);

  if (bot.friends.length > 0) {
    const friendsSection = $('div', 'bot-hunted');
    friendsSection.append(text('h4', 'bot-section-title', `AMIGOS ONLINE-DB (${bot.friends.length})`));
    friendsSection.append(text('p', 'subtle bot-section-hint', 'Nomes carregados das guilds amigas.'));
    const friendsList = $('div', 'table');
    for (const name of [...bot.friends].sort()) friendsList.append(text('div', 'rowline', name));
    friendsSection.append(friendsList);
    box.append(friendsSection);
  }

  return box;
}

function renderBotGuildSection(
  server: ServerDetail,
  title: string,
  hint: string,
  guilds: string[],
  kind: 'friend' | 'enemy',
): HTMLElement {
  const section = $('div', 'bot-guild-section');
  section.append(text('h4', 'bot-section-title', title), text('p', 'subtle bot-section-hint', hint));

  const addRow = $('div', 'toolbar');
  const addInput = $('input') as HTMLInputElement;
  addInput.placeholder = 'nome exato da guild';
  const addBtn = $('button', 'primary');
  addBtn.textContent = 'Adicionar';
  const add = () => {
    const name = addInput.value.trim();
    if (!name) return;
    addBtn.disabled = true;
    void api(`/api/servers/${server.id}/bot/guilds/${kind}`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }).then(() => {
      showToast('Guild adicionada à configuração do bot.', 'success');
      return loadDetail(server.id);
    }).catch((error) => {
      addBtn.disabled = false;
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
  };
  addBtn.addEventListener('click', add);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') add();
  });
  addRow.append(addInput, addBtn);
  section.append(addRow);

  const list = $('div', 'table bot-guild-list');
  if (guilds.length === 0) {
    list.append(text('div', 'subtle', 'nenhuma guild cadastrada'));
  }
  for (const name of [...guilds].sort((a, b) => a.localeCompare(b))) {
    const row = $('div', 'rowline');
    row.append(text('span', 'mono', `[${name.toUpperCase()}] ${name}`));
    const remove = $('button', 'danger');
    remove.textContent = 'Remover';
    remove.addEventListener('click', () => {
      remove.disabled = true;
      void api(`/api/servers/${server.id}/bot/guilds/${kind}/${encodeURIComponent(name)}`, { method: 'DELETE' })
        .then(() => {
          showToast('Guild removida da configuração do bot.', 'success');
          return loadDetail(server.id);
        }).catch((error) => {
          remove.disabled = false;
          showToast(error instanceof Error ? error.message : String(error), 'error');
        });
    });
    row.append(remove);
    list.append(row);
  }
  section.append(list);
  return section;
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

function checkbox(label: string, checked: boolean): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = $('label', 'check');
  const field = $('input') as HTMLInputElement;
  field.type = 'checkbox';
  field.checked = checked;
  wrap.append(field, text('span', '', label));
  return { wrap, input: field };
}

function action(label: string, run: () => void, cls = 'ghost'): HTMLButtonElement {
  const btn = $('button', cls);
  btn.textContent = label;
  btn.addEventListener('click', run);
  return btn;
}

async function login(password: string, email = ''): Promise<void> {
  if (loggingIn) return;
  loggingIn = true;
  notice = '';
  render();

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
    loggingIn = false;
    showToast('Login realizado com sucesso.', 'success');
  } catch (err) {
    loggingIn = false;
    token = '';
    sessionStorage.removeItem(TOKEN_KEY);
    notice = '';
    showToast(err instanceof Error ? err.message : String(err), 'error');
    render();
  }
}

async function refreshAll(): Promise<void> {
  await loadOverview();
  if (!selectedId) selectedId = overview?.servers[0]?.id ?? 0;
  if (selectedId) await loadDetail(selectedId);
  await loadTickets();
  await loadAudit();
  render();
}

async function loadTickets(): Promise<void> {
  try {
    const body = await api<{ tickets: Ticket[] }>('/api/tickets');
    tickets = body.tickets;
  } catch {
    tickets = [];
  }
}

/**
 * A trilha e da conta, nao do servidor selecionado: login, compra e criacao de
 * servidor nao pertencem a servidor nenhum, e sao justamente as linhas que o
 * dono precisa ver. O servidor de cada acao aparece na propria linha.
 */
async function loadAudit(): Promise<void> {
  try {
    audit = (await api<{ entries: AuditEntry[] }>('/api/audit?limit=120')).entries;
  } catch {
    audit = [];
  }
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
    // O SSE atualiza presença a cada poucos segundos. A aba de Tickets não
    // pode ser reconstruída em background: até um evento que chegou junto do
    // clique roubaria o foco do campo recém-selecionado. O envio/Atualizar e a
    // troca de aba fazem o redraw explicitamente.
    if (activeTab === 'tickets' || (activeTab === 'bot' && botAction)) return;
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
