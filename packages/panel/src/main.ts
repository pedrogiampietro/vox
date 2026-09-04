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

type AdminTab = 'overview' | 'server' | 'users' | 'channels' | 'bans' | 'bot' | 'billing' | 'tickets';

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
    intervalMs: number;
    channelName: string;
    enabled: boolean;
    globalDeaths: boolean;
    globalKills: boolean;
    globalLevelMin: number;
    summarizePresence: boolean;
    presenceSummaryMs: number;
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
      grid.append(renderServerSettings(detail), renderClients(detail));
    } else if (activeTab === 'server') {
      grid.append(renderServerSettings(detail), renderAnnouncement(detail));
    } else if (activeTab === 'users') {
      grid.append(renderClients(detail));
    } else if (activeTab === 'channels') {
      grid.append(renderChannels(detail));
    } else if (activeTab === 'bans') {
      grid.append(renderBans(detail));
    } else if (activeTab === 'bot') {
      grid.append(botState && botState.provider !== 'none'
        ? renderBot(detail, botState)
        : emptyTab('Bot', 'Este servidor não possui um provider de bot ativo. Escolha Rubinot ou DeusOT na aba Servidor.'));
    } else if (activeTab === 'billing') {
      grid.append(renderBilling(detail));
    } else if (activeTab === 'tickets') {
      grid.append(renderTickets(server));
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
  if (overview?.role === 'master') {
    const presetSelect = $('select') as HTMLSelectElement;
    if (!SERVER_PRESETS.some((option) => option.id === server.presetId)) {
      const custom = $('option') as HTMLOptionElement;
      custom.value = server.presetId;
      custom.textContent = 'Personalizado (somente pelo cliente)';
      custom.selected = true;
      custom.disabled = true;
      presetSelect.append(custom);
    }
    for (const option of SERVER_PRESETS) {
      const item = $('option') as HTMLOptionElement;
      item.value = option.id;
      item.textContent = option.name;
      item.selected = option.id === server.presetId;
      presetSelect.append(item);
    }
    preset.append(presetSelect);
    preset.dataset.presetField = 'true';
  } else {
    preset.append(text('strong', '', server.providerLabel || 'Sem bot'));
  }
  const save = $('button', 'primary');
  save.textContent = 'Salvar';
  save.addEventListener('click', () => {
    const selectedPreset = (preset.querySelector('select') as HTMLSelectElement | null)?.value;
    void api(`/api/servers/${server.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: name.input.value,
        slug: slug.input.value.trim(),
        motd: motd.input.value,
        ...(overview?.role === 'master'
          ? {
              maxClients: Number(max.input.value) || server.maxClients,
              ...(selectedPreset && SERVER_PRESETS.some((option) => option.id === selectedPreset)
                ? { presetId: selectedPreset }
                : {}),
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

  const statusLine = $('div', 'toolbar');
  const statusLabel = text('span', bot.running ? 'bot-status bot-on' : 'bot-status bot-off', bot.running ? 'ativo' : 'parado');
  statusLine.append(statusLabel);
  const toggle = $('button', bot.running ? 'danger' : 'primary');
  toggle.textContent = bot.running ? 'Parar' : 'Iniciar';
  toggle.addEventListener('click', () => {
    void api(`/api/servers/${server.id}/bot/${bot.running ? 'stop' : 'start'}`, { method: 'POST' })
      .then(() => {
        showToast(bot.running ? 'Bot parado.' : 'Bot iniciado.', 'success');
        return loadDetail(server.id);
      }).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      });
  });
  statusLine.append(toggle);
  const test = $('button', 'ghost');
  test.textContent = 'Testar Alerta';
  test.addEventListener('click', () => {
    void api(`/api/servers/${server.id}/bot/test`, { method: 'POST' })
      .then(() => {
        notice = '';
        showToast('Alerta de teste enviado.', 'success');
        render();
      }).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 'error');
      });
  });
  statusLine.append(test);
  box.append(statusLine);

  const form = $('div', 'form two');
  const world = input('world', botDraft.world ?? bot.config.world, 'text', 'ex: Vesperia');
  const guild = input('guild', botDraft.guildName ?? bot.config.guildName, 'text', 'nome da guild (opcional)');
  const channel = input('canal de notificacao', botDraft.channelName ?? bot.config.channelName, 'text', 'bot');
  const interval = input('intervalo (segundos)', botDraft.intervalSec ?? String(bot.config.intervalMs / 1000), 'number');
  const globalLevelMin = input('level global min.', botDraft.globalLevelMin ?? String(bot.config.globalLevelMin), 'number');
  const presenceSummarySec = input(
    'resumo online/offline (segundos)',
    botDraft.presenceSummarySec ?? String(bot.config.presenceSummaryMs / 1000),
    'number',
  );

  world.input.addEventListener('input', () => { botDraft.world = world.input.value; });
  guild.input.addEventListener('input', () => { botDraft.guildName = guild.input.value; });
  channel.input.addEventListener('input', () => { botDraft.channelName = channel.input.value; });
  interval.input.addEventListener('input', () => { botDraft.intervalSec = interval.input.value; });
  globalLevelMin.input.addEventListener('input', () => { botDraft.globalLevelMin = globalLevelMin.input.value; });
  presenceSummarySec.input.addEventListener('input', () => { botDraft.presenceSummarySec = presenceSummarySec.input.value; });

  const rules = $('div', 'bot-rules');
  const deaths = checkbox('kills/deaths globais', bot.config.globalDeaths && bot.config.globalKills);
  const presence = checkbox('resumir online/offline', bot.config.summarizePresence);
  rules.append(deaths.wrap, presence.wrap);

  const save = $('button', 'primary');
  save.textContent = 'Salvar Configuração';
  save.addEventListener('click', () => {
    void api(`/api/servers/${server.id}/bot`, {
      method: 'PATCH',
      body: JSON.stringify({
        world: world.input.value.trim(),
        guildName: guild.input.value.trim(),
        channelName: channel.input.value.trim() || 'bot',
        intervalMs: (Number(interval.input.value) || 60) * 1000,
        globalDeaths: deaths.input.checked,
        globalKills: deaths.input.checked,
        globalLevelMin: Number(globalLevelMin.input.value) || 0,
        summarizePresence: presence.input.checked,
        presenceSummaryMs: (Number(presenceSummarySec.input.value) || 300) * 1000,
        enabled: bot.config.enabled,
      }),
    }).then(() => {
      botDraft = {};
      showToast('Configuração do bot salva.', 'success');
      return loadDetail(server.id);
    }).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    });
  });

  form.append(world.wrap, guild.wrap, channel.wrap, interval.wrap, globalLevelMin.wrap, presenceSummarySec.wrap, rules, save);
  box.append(form);

  // hunted list
  const huntedSection = $('div', 'bot-hunted');
  huntedSection.append(text('h4', '', `Hunted List (${bot.hunted.length})`));

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
  huntedSection.append(addRow);

  const list = $('div', 'table');
  if (bot.hunted.length === 0) {
    list.append(text('div', 'subtle', 'nenhum jogador na hunted list'));
  }
  for (const name of bot.hunted.sort()) {
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
    if (activeTab === 'tickets') return;
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
