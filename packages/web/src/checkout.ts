import { iconBrandMark } from './ui/icons.js';
import { $, text } from './ui/dom.js';
import './checkout.css';

type PlanKey = 'community' | 'private' | 'war';
type Plan = { key: PlanKey; label: string; title: string; price: string; slots: string; paid: boolean; detail: string };
type Account = { id: number; email: string; createdAt: number };
type Overview = { account: Account | null; servers: { id: number }[] };
type ProvisionResult = { server: { slug: string; name: string; maxClients: number; url: string }; adminUrl: string };
type OrderResult = {
  id: string;
  plan: PlanKey;
  amountCents: number;
  status: 'pending' | 'approved' | 'failed';
  server?: { slug: string; name: string; maxClients: number; url: string };
  adminUrl?: string;
  error?: string;
};

const plans: Record<PlanKey, Plan> = {
  community: { key: 'community', label: 'comunidade', title: 'Para testar com o time', price: 'gratuito', slots: '10 slots', paid: false, detail: 'O essencial para colocar a primeira call no ar.' },
  private: { key: 'private', label: 'privado', title: 'Para sua guilda', price: 'sob consulta', slots: 'até 50 slots', paid: true, detail: 'Servidor dedicado, permissões e bot Rubinot.' },
  war: { key: 'war', label: 'war room', title: 'Para operações maiores', price: 'sob medida', slots: 'até 100 slots', paid: true, detail: 'Mais capacidade, edges regionais e módulos futuros.' },
};

const TOKEN_KEY = 'vox.customer.token';
const root = document.getElementById('checkout');
const params = new URLSearchParams(location.search);
const planParam = params.get('plan');
const orderId = params.get('order') ?? '';
const selectedPlan = planParam && Object.prototype.hasOwnProperty.call(plans, planParam)
  ? plans[planParam as PlanKey]
  : plans.community;
let token = sessionStorage.getItem(TOKEN_KEY) ?? '';
let step: 1 | 2 | 3 = token ? orderId ? 3 : 2 : 1;
let authMode: 'login' | 'register' = 'register';
let notice = '';
let busy = false;
let account: Account | null = null;
let provision: ProvisionResult | null = null;
let order: OrderResult | null = null;
let pollingOrder = false;

if (root) {
  render();
  void hydrateBillingPlans();
  if (token) void hydrateSession();
}

function render(): void {
  if (!root) return;
  root.replaceChildren(renderPage());
}

function renderPage(): HTMLElement {
  const page = $('main', 'checkout-page');
  page.append(renderNav());
  const layout = $('div', 'checkout-layout');
  const content = $('div', 'checkout-content');
  content.append(renderSteps(), step === 1 ? renderAuthStep() : step === 2 ? renderServerStep() : renderSuccessStep());
  layout.append(content, renderPlanSummary());
  page.append(layout, renderFooter());
  return page;
}

function renderNav(): HTMLElement {
  const nav = $('nav', 'checkout-nav');
  const brand = $('a', 'checkout-brand') as HTMLAnchorElement;
  brand.href = '/';
  brand.append(iconBrandMark(), text('span', '', 'v0x'));
  const back = $('a', 'checkout-back') as HTMLAnchorElement;
  back.href = '/#planos';
  back.textContent = 'voltar para planos';
  nav.append(brand, back);
  return nav;
}

function renderSteps(): HTMLElement {
  const list = $('div', 'checkout-steps');
  list.append(stepItem(1, 'conta', 'Crie ou acesse sua conta'), stepItem(2, 'servidor', 'Configure o primeiro servidor'), stepItem(3, 'pronto', 'Entre e administre'));
  return list;
}

function stepItem(number: number, label: string, detail: string): HTMLElement {
  const item = $('div', `checkout-step${step === number ? ' active' : step > number ? ' done' : ''}`);
  item.append(text('span', 'checkout-step-number', String(number).padStart(2, '0')), text('strong', '', label), text('span', '', detail));
  return item;
}

function renderAuthStep(): HTMLElement {
  const section = $('section', 'checkout-form-section');
  section.append(text('span', 'checkout-kicker', 'PASSO 01 · SUA CONTA'), text('h1', '', authMode === 'register' ? 'Comece pelo seu acesso.' : 'Bem-vindo de volta.'), text('p', 'checkout-lede', authMode === 'register' ? 'Crie sua conta e o Vox já deixa o plano escolhido separado para você.' : 'Entre para continuar com o plano selecionado.'));
  const tabs = $('div', 'checkout-tabs');
  const register = $('button', authMode === 'register' ? 'active' : '');
  register.type = 'button'; register.textContent = 'criar conta';
  register.addEventListener('click', () => { authMode = 'register'; notice = ''; render(); });
  const login = $('button', authMode === 'login' ? 'active' : '');
  login.type = 'button'; login.textContent = 'já tenho conta';
  login.addEventListener('click', () => { authMode = 'login'; notice = ''; render(); });
  tabs.append(register, login);

  const form = $('form', 'checkout-form');
  const email = field('email', 'seu@email.com', 'email');
  const password = field('senha', 'mínimo de 8 caracteres', 'password');
  form.append(email.wrap, password.wrap);
  const error = text('p', `checkout-notice${notice ? ' visible' : ''}`, notice);
  const submit = $('button', 'checkout-button checkout-primary');
  submit.type = 'submit'; submit.disabled = busy; submit.textContent = busy ? 'aguarde...' : authMode === 'register' ? 'criar conta e continuar' : 'entrar e continuar';
  form.append(error, submit);
  form.addEventListener('submit', (event) => { event.preventDefault(); void submitAuth(email.input.value.trim(), password.input.value); });
  section.append(tabs, form, text('p', 'checkout-security-note', 'A conta não exige cartão. O plano gratuito cria o servidor imediatamente.'));
  return section;
}

function renderServerStep(): HTMLElement {
  const section = $('section', 'checkout-form-section');
  section.append(text('span', 'checkout-kicker', 'PASSO 02 · CONFIGURAÇÃO'), text('h1', '', 'Dê um nome para o seu servidor.'), text('p', 'checkout-lede', `${selectedPlan.title} · ${selectedPlan.slots}. Você poderá ajustar channels, grupos e o bot depois.`));
  const form = $('form', 'checkout-form');
  const name = field('nome do servidor', 'Ex.: Guilda Vox', 'text');
  const slug = field('endereço curto', 'ex.: minha-guilda', 'text');
  const password = field('senha do servidor (opcional)', 'deixe vazio para público', 'password');
  slug.input.addEventListener('input', () => { if (!slug.input.value && name.input.value) slug.input.value = slugify(name.input.value); });
  name.input.addEventListener('blur', () => { if (!slug.input.value) slug.input.value = slugify(name.input.value); });
  form.append(name.wrap, slug.wrap, password.wrap);
  const error = text('p', `checkout-notice${notice ? ' visible' : ''}`, notice);
  const submit = $('button', 'checkout-button checkout-primary');
  submit.type = 'submit'; submit.disabled = busy; submit.textContent = busy ? 'criando...' : selectedPlan.paid ? 'continuar para pagamento' : 'criar servidor gratuito';
  form.append(error, submit);
  form.addEventListener('submit', (event) => { event.preventDefault(); void provisionServer(name.input.value.trim(), slug.input.value.trim(), password.input.value); });
  section.append(form, text('p', 'checkout-security-note', selectedPlan.paid ? 'O servidor só será criado depois da confirmação do pagamento no Mercado Pago.' : 'Sem cartão, sem cobrança e com 10 slots para começar.'));
  return section;
}

function renderSuccessStep(): HTMLElement {
  const section = $('section', 'checkout-success');
  if (orderId && !provision) {
    if (order?.status === 'failed') {
      section.append(text('span', 'checkout-kicker', 'PASSO 03 · PAGAMENTO'), text('h1', '', 'O pagamento não foi concluído.'), text('p', 'checkout-lede', 'Nenhum servidor foi criado. Você pode voltar aos planos e tentar novamente.'));
      const back = $('a', 'checkout-button checkout-outline'); back.href = '/#planos'; back.textContent = 'voltar para planos';
      section.append(back);
      return section;
    }
    section.append(
      text('span', 'checkout-kicker', 'PASSO 03 · PAGAMENTO'),
      text('h1', '', order?.status === 'approved' ? 'Pagamento confirmado.' : 'Aguardando confirmação.'),
      text('p', 'checkout-lede', order?.status === 'approved'
        ? 'O Mercado Pago confirmou a cobrança. Estamos finalizando a criação do seu servidor.'
        : 'O pagamento foi iniciado. Assim que o Mercado Pago confirmar, o Vox cria seu servidor automaticamente.'),
      text('p', 'checkout-security-note', pollingOrder ? 'verificando o status do pagamento…' : 'Você pode fechar esta página; o pedido fica salvo na sua conta.'),
    );
    return section;
  }
  section.append(text('span', 'checkout-kicker', 'PASSO 03 · TUDO PRONTO'), text('h1', '', 'Seu servidor está no ar.'), text('p', 'checkout-lede', 'A conta já é a dona do servidor. Use o endereço abaixo para entrar com o seu time.'));
  if (provision) {
    const address = $('div', 'checkout-address');
    address.append(text('span', 'checkout-address-label', 'ENDEREÇO DO SERVIDOR'), text('strong', '', provision.server.url), text('span', 'mono', `${provision.server.maxClients} slots · plano ${selectedPlan.label}`));
    section.append(address);
    const actions = $('div', 'checkout-actions');
    const open = $('a', 'checkout-button checkout-primary'); open.href = `/app?server=${encodeURIComponent(provision.server.url)}`; open.textContent = 'entrar no Vox';
    const admin = $('a', 'checkout-button checkout-outline'); admin.href = provision.adminUrl; admin.textContent = 'abrir painel admin';
    actions.append(open, admin);
    section.append(actions, text('p', 'checkout-security-note', `Faça login no admin com ${account?.email ?? 'a conta criada'} para ajustar permissões e bot.`));
  }
  return section;
}

function renderPlanSummary(): HTMLElement {
  const aside = $('aside', 'checkout-summary');
  aside.append(text('span', 'checkout-summary-label', 'PLANO SELECIONADO'), text('h2', '', selectedPlan.title), text('span', 'checkout-summary-plan', selectedPlan.label), text('strong', 'checkout-summary-price', selectedPlan.price), text('p', '', selectedPlan.detail));
  const list = $('ul', 'checkout-summary-list');
  list.append(summaryRow('capacidade', selectedPlan.slots), summaryRow('bot', selectedPlan.paid ? 'Rubinot configurável' : 'Rubinot opcional'), summaryRow('voz', 'QUIC + fallback WS'), summaryRow('painel', 'incluído'));
  aside.append(list);
  const change = $('a', 'checkout-change-plan'); change.href = '/#planos'; change.textContent = 'trocar plano'; aside.append(change);
  return aside;
}

function summaryRow(label: string, value: string): HTMLElement {
  const row = $('li', ''); row.append(text('span', '', label), text('strong', '', value)); return row;
}

function renderFooter(): HTMLElement {
  const footer = $('footer', 'checkout-footer'); footer.append(text('span', '', 'v0x · contratação segura por etapas'), text('span', 'mono', 'pagamento protegido pelo Mercado Pago')); return footer;
}

function field(label: string, placeholder: string, type: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = $('label', 'checkout-field'); wrap.append(text('span', '', label));
  const input = $('input') as HTMLInputElement; input.type = type; input.placeholder = placeholder; input.required = !(type === 'password' && label.includes('servidor')); input.setAttribute('autocomplete', type === 'email' ? 'email' : type === 'password' ? 'new-password' : 'off'); wrap.append(input); return { wrap, input };
}

async function submitAuth(email: string, password: string): Promise<void> {
  if (busy) return;
  busy = true; notice = ''; render();
  try {
    const response = await fetch(authMode === 'register' ? '/api/account/register' : '/api/account/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const body = await response.json() as { token?: string; error?: string; account?: Account };
    if (!response.ok || !body.token) throw new Error(body.error || 'não foi possível autenticar');
    token = body.token; account = body.account ?? null; sessionStorage.setItem(TOKEN_KEY, token); step = 2; busy = false; notice = ''; render();
  } catch (error) { busy = false; notice = error instanceof Error ? error.message : String(error); render(); }
}

async function hydrateSession(): Promise<void> {
  try {
    const response = await fetch('/api/overview', { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('sessão expirada');
    const body = await response.json() as Overview;
    account = body.account;
    step = orderId ? 3 : 2;
    render();
    if (orderId) void pollOrder();
  } catch { token = ''; account = null; sessionStorage.removeItem(TOKEN_KEY); step = 1; render(); }
}

async function provisionServer(name: string, slug: string, password: string): Promise<void> {
  if (busy) return;
  busy = true; notice = ''; render();
  try {
    if (selectedPlan.paid) {
      const response = await fetch('/api/account/checkout', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ plan: selectedPlan.key, name, slug, password }) });
      const body = await response.json() as { orderId?: string; initPoint?: string; error?: string };
      if (!response.ok || !body.orderId || !body.initPoint) throw new Error(body.error || 'não foi possível iniciar o pagamento');
      window.location.assign(body.initPoint);
      return;
    }
    const response = await fetch('/api/account/provision', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ plan: selectedPlan.key, name, slug, password }) });
    const body = await response.json() as ProvisionResult & { error?: string };
    if (!response.ok) throw new Error(body.error || 'não foi possível criar o servidor');
    provision = body; step = 3; busy = false; render();
  } catch (error) { busy = false; notice = error instanceof Error ? error.message : String(error); render(); }
}

async function hydrateBillingPlans(): Promise<void> {
  try {
    const response = await fetch('/api/billing/plans');
    if (!response.ok) return;
    const body = await response.json() as { plans?: { key: PlanKey; priceCents: number }[] };
    for (const remote of body.plans ?? []) {
      const local = plans[remote.key];
      if (local && remote.priceCents > 0) local.price = formatCents(remote.priceCents);
    }
    if (!busy && step !== 2) render();
  } catch {
    // O checkout gratuito continua funcionando mesmo sem o catálogo de preços.
  }
}

async function pollOrder(): Promise<void> {
  if (!orderId || !token || pollingOrder) return;
  pollingOrder = true;
  for (let attempt = 0; attempt < 48; attempt++) {
    try {
      const response = await fetch(`/api/account/orders/${encodeURIComponent(orderId)}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json() as OrderResult;
      if (!response.ok) throw new Error(body.error || 'não foi possível consultar o pedido');
      order = body;
      if (body.status === 'approved' && body.server) {
        provision = { server: body.server, adminUrl: body.adminUrl ?? `/admin?server=${body.server.slug}` };
        pollingOrder = false;
        busy = false;
        render();
        return;
      }
      if (body.status === 'failed') break;
      render();
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
      break;
    }
    await delay(2500);
  }
  pollingOrder = false;
  busy = false;
  render();
}

function formatCents(value: number): string {
  return (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'minha-guilda';
}
