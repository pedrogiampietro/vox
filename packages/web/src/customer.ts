import { iconBrandMark } from './ui/icons.js';
import { $, text } from './ui/dom.js';
import './customer.css';

type Account = { id: number; email: string; createdAt: number };
type ServerSummary = {
  id: number;
  slug: string;
  name: string;
  motd: string;
  clients: number;
  maxClients: number;
  channels: number;
  protected: boolean;
};
type Overview = {
  account: Account | null;
  servers: ServerSummary[];
  totals: { clients: number; servers: number };
  role: 'master' | 'owner';
};

const TOKEN_KEY = 'vox.customer.token';
const root = document.getElementById('customer');
let token = sessionStorage.getItem(TOKEN_KEY) ?? '';
let mode: 'login' | 'register' = 'login';
let notice = '';
let busy = false;
let overview: Overview | null = null;

if (root) {
  render();
  if (token) void loadOverview();
}

function render(): void {
  if (!root) return;
  root.replaceChildren(token && overview ? renderDashboard() : renderAuth());
}

function renderAuth(): HTMLElement {
  const page = $('main', 'customer-page customer-auth-page');
  page.append(renderNav('entrar'));

  const layout = $('div', 'customer-auth-layout');
  const intro = $('section', 'customer-auth-intro');
  intro.append(
    text('span', 'customer-kicker', mode === 'login' ? 'ÁREA DO CLIENTE' : 'COMECE PELO VOX'),
    heading(mode === 'login' ? 'Seu time, seus servidores.' : 'Crie sua conta e organize sua operação.'),
    text('p', '', mode === 'login'
      ? 'Acesse suas contratações, servidores e configurações em um único lugar.'
      : 'A conta é o ponto de partida para contratar servidores, acompanhar a assinatura e configurar o bot.'),
    renderAuthHighlights(),
  );

  const card = $('section', 'customer-auth-card');
  const tabs = $('div', 'customer-auth-tabs');
  const loginTab = $('button', mode === 'login' ? 'active' : '');
  loginTab.type = 'button';
  loginTab.textContent = 'entrar';
  loginTab.addEventListener('click', () => { mode = 'login'; notice = ''; render(); });
  const registerTab = $('button', mode === 'register' ? 'active' : '');
  registerTab.type = 'button';
  registerTab.textContent = 'criar conta';
  registerTab.addEventListener('click', () => { mode = 'register'; notice = ''; render(); });
  tabs.append(loginTab, registerTab);

  const form = $('form', 'customer-auth-form');
  const email = field('email', 'email', 'seu@email.com', 'email');
  const password = field('senha', '••••••••', 'password', 'senha');
  form.append(email.wrap, password.wrap);

  let confirmation: ReturnType<typeof field> | null = null;
  if (mode === 'register') {
    confirmation = field('confirmar senha', '••••••••', 'password', 'confirmar senha');
    form.append(confirmation.wrap);
  }

  const error = text('p', `customer-form-notice${notice ? ' visible' : ''}`, notice);
  const submit = $('button', 'customer-submit customer-button-primary');
  submit.type = 'submit';
  submit.textContent = busy ? 'aguarde...' : mode === 'login' ? 'entrar na minha conta' : 'criar minha conta';
  submit.disabled = busy;
  form.append(error, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitAuth(email.input.value.trim(), password.input.value, confirmation?.input.value ?? '');
  });

  const divider = text('span', 'customer-divider', 'ou');
  const google = $('button', 'customer-google');
  google.type = 'button';
  google.disabled = true;
  google.textContent = 'continuar com Google · em breve';
  google.title = 'Login Google será habilitado na próxima etapa';
  card.append(tabs, form, divider, google, text('p', 'customer-auth-footnote', 'Senha com no mínimo 8 caracteres. Nunca compartilhamos seus dados.'));
  layout.append(intro, card);
  page.append(layout, renderAuthFooter());
  return page;
}

function renderAuthHighlights(): HTMLElement {
  const list = $('div', 'customer-auth-highlights');
  list.append(
    highlight('01', 'Servidores em um só lugar', 'Veja status, slots e acesso direto.'),
    highlight('02', 'Bot modular', 'Rubinot agora; outros mundos depois.'),
    highlight('03', 'Cobrança transparente', 'Assinatura e faturas no mesmo painel.'),
  );
  return list;
}

function highlight(number: string, title: string, detail: string): HTMLElement {
  const item = $('div', 'customer-highlight');
  item.append(text('span', 'customer-highlight-number', number), text('strong', '', title), text('p', '', detail));
  return item;
}

function renderDashboard(): HTMLElement {
  const page = $('main', 'customer-page customer-dashboard-page');
  page.append(renderNav('painel'));
  const shell = $('div', 'customer-shell');
  const account = overview?.account;
  const headingRow = $('div', 'customer-heading-row');
  const headingCopy = $('div', 'customer-heading-copy');
  headingCopy.append(
    text('span', 'customer-kicker', 'PAINEL DO CLIENTE'),
    text('h1', '', 'Tudo sob controle.'),
    text('p', '', account?.email ?? 'Sua conta Vox'),
  );
  const logout = $('button', 'customer-button customer-button-ghost');
  logout.type = 'button';
  logout.textContent = 'sair';
  logout.addEventListener('click', logoutAccount);
  const headingActions = $('div', 'customer-heading-actions');
  const addServer = $('a', 'customer-button customer-button-primary') as HTMLAnchorElement;
  addServer.href = '/#planos';
  addServer.textContent = 'contratar outro servidor';
  headingActions.append(addServer, logout);
  headingRow.append(headingCopy, headingActions);
  shell.append(headingRow, renderStats(), renderDashboardGrid());
  page.append(shell, renderAuthFooter());
  return page;
}

function renderStats(): HTMLElement {
  const stats = $('div', 'customer-stats');
  const servers = overview?.servers ?? [];
  const totalSlots = servers.reduce((sum, server) => sum + Math.max(server.maxClients, 0), 0);
  stats.append(
    stat('servidores', String(overview?.totals.servers ?? 0), 'contratados ou vinculados'),
    stat('online agora', String(overview?.totals.clients ?? 0), 'pessoas conectadas'),
    stat('slots totais', totalSlots ? String(totalSlots) : '—', totalSlots ? 'capacidade contratada' : 'defina seu primeiro plano'),
    stat('conexão', 'QUIC', 'fallback automático para WS'),
  );
  return stats;
}

function stat(label: string, value: string, detail: string): HTMLElement {
  const item = $('article', 'customer-stat');
  item.append(text('span', 'customer-stat-label', label), text('strong', '', value), text('span', '', detail));
  return item;
}

function renderDashboardGrid(): HTMLElement {
  const grid = $('div', 'customer-dashboard-grid');
  grid.append(renderServersCard(), renderSubscriptionCard(), renderBotCard(), renderDownloadCard(), renderInvoicesCard());
  return grid;
}

function renderServersCard(): HTMLElement {
  const card = dashboardCard('seus servidores', 'Acesso rápido e visão da operação.', 'wide');
  const list = $('div', 'customer-server-list');
  const servers = overview?.servers ?? [];
  if (servers.length === 0) {
    const empty = $('div', 'customer-empty');
    empty.append(text('strong', '', 'Nenhum servidor vinculado ainda.'), text('p', '', 'Quando sua contratação estiver ativa, o servidor aparecerá aqui com acesso direto e configurações.'));
    list.append(empty);
  } else {
    for (const server of servers) list.append(renderServer(server));
  }
  card.append(list);
  return card;
}

function renderServer(server: ServerSummary): HTMLElement {
  const item = $('article', 'customer-server');
  const copy = $('div', 'customer-server-copy');
  copy.append(text('span', 'customer-server-signal', '● online'), text('h3', '', server.name), text('span', 'mono', `${server.slug}.v0x.online · ${server.channels} channels`));
  const occupancy = text('strong', 'customer-server-occupancy', `${server.clients}/${server.maxClients || '∞'}`);
  const actions = $('div', 'customer-server-actions');
  const open = $('a', 'customer-button customer-button-primary');
  open.href = `/app?server=${encodeURIComponent(serverUrl(server))}`;
  open.textContent = 'abrir Vox';
  const manage = $('a', 'customer-button customer-button-ghost');
  manage.href = `/admin?server=${server.id}`;
  manage.textContent = 'configurar';
  actions.append(open, manage);
  item.append(copy, occupancy, actions);
  return item;
}

function renderSubscriptionCard(): HTMLElement {
  const card = dashboardCard('assinatura', 'Seu plano e os próximos vencimentos.', 'half');
  const status = $('div', 'customer-subscription-status');
  status.append(text('span', 'customer-status-dot', '●'), text('strong', '', 'Contratações independentes'));
  card.append(status, text('p', 'customer-muted-copy', 'Sua conta pode ter vários servidores. Cada nova contratação mantém seus slots, channels e bot separados.'));
  const action = $('a', 'customer-button customer-button-outline');
  action.href = '/#planos';
  action.textContent = 'contratar outro';
  card.append(action);
  return card;
}

function renderBotCard(): HTMLElement {
  const card = dashboardCard('bot e integrações', 'Automação para o mundo da sua guilda.', 'half');
  const modules = $('div', 'customer-module-list');
  modules.append(module('Rubinot', 'disponível', true), module('Global', 'em breve', false), module('DeusOT', 'em breve', false));
  card.append(modules, text('p', 'customer-muted-copy', 'A configuração detalhada continua disponível no painel administrativo de cada servidor.'));
  return card;
}

function module(name: string, state: string, active: boolean): HTMLElement {
  const item = $('div', `customer-module${active ? ' active' : ''}`);
  item.append(text('span', '', name), text('span', 'mono', state));
  return item;
}

function renderDownloadCard(): HTMLElement {
  const card = dashboardCard('aplicativo', 'Leve sua call para a partida.', 'half');
  card.append(text('p', 'customer-muted-copy', 'O cliente web já está disponível. A versão desktop em Tauri já pode ser instalada no Windows.'));
  const actions = $('div', 'customer-card-actions');
  const web = $('a', 'customer-button customer-button-primary');
  web.href = '/app';
  web.textContent = 'abrir versão web';
  const desktop = $('a', 'customer-button customer-button-outline');
  desktop.href = '/downloads/v0x-windows-x64-setup.exe';
  desktop.setAttribute('download', '');
  desktop.textContent = 'baixar Windows';
  actions.append(web, desktop);
  card.append(actions);
  return card;
}

function renderInvoicesCard(): HTMLElement {
  const card = dashboardCard('faturas', 'Histórico financeiro.', 'half');
  const empty = $('div', 'customer-empty customer-empty-compact');
  empty.append(text('strong', '', 'Nenhuma fatura disponível'), text('p', '', 'As faturas aparecerão aqui quando o checkout e a assinatura estiverem ativados.'));
  card.append(empty);
  return card;
}

function dashboardCard(label: string, title: string, size: 'wide' | 'half'): HTMLElement {
  const card = $('section', `customer-card customer-card-${size}`);
  card.append(text('span', 'customer-card-label', label), text('h2', '', title));
  return card;
}

function renderNav(current: string): HTMLElement {
  const nav = $('nav', 'customer-nav');
  const brand = $('a', 'customer-brand') as HTMLAnchorElement;
  brand.href = '/';
  brand.append(iconBrandMark(), text('span', '', 'v0x'));
  const links = $('div', 'customer-nav-links');
  links.append(navLink('landing', '/'), navLink('abrir Vox', '/app'));
  if (current === 'painel') links.append(text('span', 'customer-nav-current', 'área do cliente'));
  nav.append(brand, links);
  return nav;
}

function navLink(label: string, href: string): HTMLAnchorElement {
  const link = text('a', '', label) as HTMLAnchorElement;
  link.href = href;
  return link;
}

function renderAuthFooter(): HTMLElement {
  const footer = $('footer', 'customer-footer');
  footer.append(text('span', '', 'v0x · voz para quem joga junto'), text('span', 'mono', 'conta segura · suporte em breve'));
  return footer;
}

function heading(content: string): HTMLElement {
  return text('h1', 'customer-auth-title', content);
}

function field(label: string, placeholder: string, type: string, autocomplete: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = $('label', 'customer-field');
  wrap.append(text('span', '', label));
  const input = $('input') as HTMLInputElement;
  input.type = type;
  input.placeholder = placeholder;
  input.setAttribute('autocomplete', autocomplete);
  input.required = true;
  wrap.append(input);
  return { wrap, input };
}

async function submitAuth(email: string, password: string, confirmation: string): Promise<void> {
  if (busy) return;
  if (mode === 'register' && password !== confirmation) {
    notice = 'as senhas não conferem';
    render();
    return;
  }
  busy = true;
  notice = '';
  render();
  try {
    const response = await fetch(mode === 'register' ? '/api/account/register' : '/api/account/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await response.json() as { token?: string; error?: string };
    if (!response.ok || !body.token) throw new Error(body.error || 'não foi possível entrar');
    token = body.token;
    sessionStorage.setItem(TOKEN_KEY, token);
    busy = false;
    await loadOverview();
  } catch (error) {
    busy = false;
    notice = error instanceof Error ? error.message : String(error);
    render();
  }
}

async function loadOverview(): Promise<void> {
  try {
    const response = await fetch('/api/overview', { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json() as Overview & { error?: string };
    if (response.status === 401 || response.status === 403) throw new Error('sessão expirada; entre novamente');
    if (!response.ok) throw new Error(body.error || 'não foi possível carregar o painel');
    overview = body;
    notice = '';
    render();
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEY);
    token = '';
    overview = null;
    notice = error instanceof Error ? error.message : String(error);
    render();
  }
}

function logoutAccount(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  token = '';
  overview = null;
  mode = 'login';
  notice = '';
  render();
}

function serverUrl(server: ServerSummary): string {
  return `https://${server.slug}.v0x.online`;
}
