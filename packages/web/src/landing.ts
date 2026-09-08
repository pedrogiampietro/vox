import { iconBrandMark } from './ui/icons.js';
import { $, text } from './ui/dom.js';
import { createPwaInstallCard, registerPwaServiceWorker, setupPwaInstall } from './pwa.js';
import { createLocaleSelect, translateTree } from './i18n.js';
import './landing.css';

const root = document.getElementById('landing');

function renderLandingPage(): HTMLElement {
  const page = $('main', 'landing-page');
  page.append(renderNav());
  const shell = $('div', 'landing-shell');
  const plans = renderPlans();
  shell.append(renderHero(), renderTrustBar(), renderDownload(), renderFeatures(), renderFlow(), plans, renderCta(), renderFooter());
  page.append(shell);
  translateTree(page);
  void refreshLandingPlans(plans);
  void refreshLandingStatus(page);
  return page;
}

function renderNav(): HTMLElement {
  const nav = $('nav', 'landing-nav');
  const brand = $('a', 'landing-brand') as HTMLAnchorElement;
  brand.href = '/';
  brand.append(iconBrandMark(), text('span', '', 'v0x'));

  const links = $('div', 'landing-nav-links');
  links.append(
    landingLink('Recursos', '#recursos'),
    landingLink('Como Funciona', '#como-funciona'),
    landingLink('Download', '#download'),
    landingLink('Planos', '#planos'),
  );

  const actions = $('div', 'landing-nav-actions');
  actions.append(
    landingLink('Entrar no Vox', '/app', 'landing-button landing-button-small landing-button-app'),
    landingLink('Abrir Painel', '/painel', 'landing-button landing-button-small landing-button-panel'),
    createLocaleSelect(() => {
      if (root) root.replaceChildren(renderLandingPage());
    }),
  );
  nav.append(brand, links, actions);
  return nav;
}

function renderHero(): HTMLElement {
  const hero = $('section', 'landing-hero');
  const copy = $('div', 'landing-hero-copy');
  copy.append(
    text('div', 'landing-kicker', 'VOZ EM TEMPO REAL · FEITA PARA GUILDAS'),
    heading('h1', ['A call que', 'acompanha o', 'ritmo da hunt.']),
    text('p', 'landing-lede', 'Canais rápidos, áudio limpo e conexão que não atrapalha a jogada. Entre pelo navegador e fale com o seu time em segundos.'),
  );

  const actions = $('div', 'landing-hero-actions');
  actions.append(
    landingLink('Entrar no Vox', '/app', 'landing-button landing-button-primary'),
    landingLink('Conhecer Recursos', '#recursos', 'landing-button landing-button-outline'),
  );
  copy.append(actions, renderQuickConnect());
  const mobileInstall = createPwaInstallCard({ compact: true, mobileOnly: true });
  if (mobileInstall) {
    mobileInstall.classList.add('landing-mobile-install');
    copy.append(mobileInstall);
  }

  const stage = $('div', 'landing-stage');
  stage.append(renderVoiceOrb(), renderServerWindow());
  hero.append(copy, stage);
  return hero;
}

function renderQuickConnect(): HTMLElement {
  const wrap = $('div', 'landing-quick');
  wrap.append(text('span', 'landing-quick-label', 'acesso rápido'));
  const form = $('form', 'landing-connect');
  const input = $('input') as HTMLInputElement;
  input.type = 'text';
  input.name = 'server';
  input.setAttribute('autocomplete', 'url');
  input.placeholder = 'servidor.v0x.online';
  input.setAttribute('aria-label', 'Endereço do servidor');
  const submit = $('button', 'landing-connect-button');
  submit.type = 'submit';
  submit.textContent = 'Conectar';
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const address = input.value.trim();
    if (!address) {
      input.focus();
      return;
    }
    window.location.assign(`/app?server=${encodeURIComponent(address)}`);
  });
  wrap.append(form, text('span', 'landing-quick-note', 'domínio, IP ou endereço do servidor'));
  return wrap;
}

function renderVoiceOrb(): HTMLElement {
  const orb = $('div', 'landing-orb');
  const rings = $('div', 'landing-orb-rings');
  rings.append($('i'), $('i'), $('i'));
  const core = $('div', 'landing-orb-core');
  core.append(text('span', '', 'v0x'));
  orb.append(rings, core);
  return orb;
}

function renderServerWindow(): HTMLElement {
  const window = $('div', 'landing-window');
  const top = $('div', 'landing-window-top');
  const lights = $('div', 'landing-window-lights');
  lights.append($('i'), $('i'), $('i'));
  top.append(lights, text('span', 'landing-window-title', 'Servidor Vox / ao vivo'), text('span', 'landing-window-signal', 'ONLINE'));

  const body = $('div', 'landing-window-body');
  body.append(
    windowRow('#', 'Lobby', '2 conectados', true),
    windowRow('#', 'War Channel', '12 conectados', false),
    windowRow('#', 'Hunt — Rotten Wasteland', '6 conectados', false),
  );

  const footer = $('div', 'landing-window-footer');
  footer.append(text('span', 'mono', 'QUIC'), text('span', 'landing-window-latency', 'voz em baixa latência'));
  const bars = $('div', 'landing-bars');
  for (let i = 0; i < 18; i++) bars.append($('i'));
  footer.append(bars);
  window.append(top, body, footer);
  return window;
}

function windowRow(icon: string, name: string, count: string, active: boolean): HTMLElement {
  const row = $('div', `landing-window-row${active ? ' active' : ''}`);
  row.append(text('span', 'landing-window-channel', icon), text('span', '', name), text('span', 'landing-window-count', count));
  return row;
}

function renderTrustBar(): HTMLElement {
  const bar = $('div', 'landing-trust');
  bar.append(
    trustMetric('01', 'sem instalação', 'abre no navegador'),
    trustMetric('02', 'voz em QUIC', 'menos fila no áudio'),
    trustMetric('03', 'seu servidor', 'canais sob seu controle'),
  );
  return bar;
}

function trustMetric(index: string, title: string, detail: string): HTMLElement {
  const item = $('div', 'landing-trust-item');
  item.append(text('span', 'landing-trust-index', index), text('strong', '', title), text('span', '', detail));
  return item;
}

function renderDownload(): HTMLElement {
  const section = $('section', 'landing-section landing-download');
  section.id = 'download';
  section.append(sectionIntro('baixe e escolha seu jeito', 'O Vox acompanha a sua rotina de jogo.'));
  const grid = $('div', 'landing-download-grid');
  grid.append(
    downloadCard('01', 'web', 'Navegador', 'disponível agora', 'Entre em segundos, sem instalar nada e com voz QUIC quando sua rede permitir.', downloadWeb()),
    downloadCard('02', 'desktop', 'Windows / Tauri', 'disponível agora', 'Um cliente leve para deixar a call aberta ao lado da partida, com a mesma conta e os mesmos servidores.', downloadDesktop()),
    downloadCard('03', 'store', 'Microsoft Store', 'em preparação', 'Estamos preparando o pacote para publicação na Microsoft Store, com instalação centralizada pelo Windows.', text('span', 'landing-download-soon', 'disponível após aprovação')),
    downloadCard('04', 'mobile', 'Celular (PWA)', 'disponível agora', 'Instale o Vox direto pelo navegador no Android ou iPhone e abra a call pela sua tela inicial.', downloadMobile()),
  );
  section.append(grid);
  return section;
}

function downloadCard(number: string, kind: string, title: string, status: string, detail: string, action: HTMLElement): HTMLElement {
  const card = $('article', `landing-download-card landing-download-${kind}`);
  card.append(text('span', 'landing-card-number', number), text('span', 'landing-download-status', status), text('h3', '', title), text('p', '', detail));
  const actions = $('div', 'landing-download-actions');
  actions.append(action);
  card.append(actions);
  return card;
}

function downloadWeb(): HTMLElement {
  const wrap = $('div', 'landing-download-desktop');
  wrap.append(landingLink('Abrir Vox', '/app', 'landing-button landing-button-primary'));
  const install = text('button', 'landing-button landing-button-outline landing-install', 'Instalar como aplicativo') as HTMLButtonElement;
  install.type = 'button';
  install.hidden = true;
  install.disabled = true;
  setupPwaInstall(install);
  wrap.append(install, text('span', 'landing-download-note', 'Chrome ou Edge · opção gratuita'));
  return wrap;
}

function downloadMobile(): HTMLElement {
  const wrap = $('div', 'landing-download-desktop');
  const install = text('button', 'landing-button landing-button-primary landing-mobile-install-action', 'Instalar no celular') as HTMLButtonElement;
  install.type = 'button';
  setupPwaInstall(install, { alwaysVisible: true });
  wrap.append(install, text('span', 'landing-download-note', 'Android · iPhone pelo Safari · gratuito'));
  return wrap;
}

/**
 * Os instaladores saem das releases do GitHub, nao do nosso dominio.
 *
 * O motivo e o aviso "normalmente nao e baixado" do Chrome: ele e reputacao,
 * e a de github.com e incomparavel com a de um dominio novo. `latest/download`
 * mantem o link fixo — a versao vive na tag, o nome do arquivo nao muda.
 */
const RELEASES = 'https://github.com/pedrogiampietro/v0x-desktop/releases';
const LATEST = `${RELEASES}/latest/download`;

function downloadLink(label: string, href: string): HTMLAnchorElement {
  // Sem `download`: o atributo so vale na mesma origem, e forcar o nome de um
  // arquivo de outro dominio nao funciona — o navegador ignora e ainda perde o
  // nome que veio da release.
  return landingLink(label, href, 'landing-button landing-button-primary');
}

function downloadPair(): HTMLElement {
  const pair = $('div', 'landing-download-pair');
  pair.append(
    downloadLink('Baixar .EXE', `${LATEST}/v0x-windows-x64-setup.exe`),
    downloadLink('Baixar .MSI', `${LATEST}/v0x-windows-x64.msi`),
  );
  return pair;
}

/** Conferir o hash e a unica forma de o usuario validar o que baixou. */
function downloadDesktop(): HTMLElement {
  const wrap = $('div', 'landing-download-desktop');
  wrap.append(downloadPair());
  const notes = $('div', 'landing-download-notes');
  const checksums = landingLink('conferir SHA-256', `${LATEST}/SHA256SUMS.txt`, 'landing-download-note');
  const releases = landingLink('todas as versões', RELEASES, 'landing-download-note');
  releases.target = '_blank';
  releases.rel = 'noopener';
  notes.append(checksums, releases);
  wrap.append(notes);
  return wrap;
}

function renderFeatures(): HTMLElement {
  const section = $('section', 'landing-section landing-features');
  section.id = 'recursos';
  section.append(sectionIntro('por que o Vox', 'Tudo que a sua guilda precisa para jogar coordenada.'));
  const grid = $('div', 'landing-feature-grid');
  grid.append(
    featureCard('01', 'Áudio que acompanha', 'WebTransport e QUIC priorizam a voz em tempo real, com medição de rota e fallback automático quando a rede não coopera.'),
    featureCard('02', 'Channels sem bagunça', 'Organize lobby, war, hunts, AFK e salas privadas em uma estrutura clara para o time encontrar tudo rápido.'),
    featureCard('03', 'Controle de verdade', 'Permissões, grupos, senha, bot, logs e painel administrativo para o servidor funcionar do seu jeito.'),
  );
  section.append(grid);
  return section;
}

function featureCard(number: string, title: string, detail: string): HTMLElement {
  const card = $('article', 'landing-feature-card');
  card.append(text('span', 'landing-card-number', number), text('h3', '', title), text('p', '', detail), text('span', 'landing-card-arrow', '↗'));
  return card;
}

function renderFlow(): HTMLElement {
  const section = $('section', 'landing-section landing-flow');
  section.id = 'como-funciona';
  section.append(sectionIntro('comece em poucos passos', 'Do link para a call sem interromper a partida.'));
  const steps = $('div', 'landing-steps');
  steps.append(
    step('01', 'Abra o Vox', 'Acesse pelo navegador. Sem launcher pesado e sem configuração complicada.'),
    step('02', 'Escolha seu servidor', 'Entre pelo endereço direto ou selecione um dos servidores que você já salvou.'),
    step('03', 'Fale com o time', 'Escolha o channel, ajuste seu microfone e coordene a próxima jogada.'),
  );
  section.append(steps);
  return section;
}

function step(number: string, title: string, detail: string): HTMLElement {
  const item = $('article', 'landing-step');
  item.append(text('span', 'landing-step-number', number), text('h3', '', title), text('p', '', detail));
  return item;
}

type ConfigTier = {
  slots: number;
  label: string;
  basicKey: string;
  botKey: string | null;
  basicPriceCents: number;
  botPriceCents: number;
};

const configTiers: ConfigTier[] = [
  { slots: 10, label: 'comunidade', basicKey: 'community', botKey: null, basicPriceCents: 0, botPriceCents: 0 },
  { slots: 50, label: 'guilda', basicKey: '50-basic', botKey: '50-bot', basicPriceCents: 2990, botPriceCents: 6990 },
  { slots: 100, label: 'operação', basicKey: '100-basic', botKey: '100-bot', basicPriceCents: 5090, botPriceCents: 9990 },
  { slots: 254, label: 'comunidade', basicKey: '254-basic', botKey: '254-bot', basicPriceCents: 10000, botPriceCents: 15000 },
];

const landingPrices = new Map<string, number>();
for (const tier of configTiers) {
  landingPrices.set(tier.basicKey, tier.basicPriceCents);
  if (tier.botKey) landingPrices.set(tier.botKey, tier.botPriceCents);
}

let selectedTierIndex = 0;
let includeBot = false;

function renderPlans(): HTMLElement {
  const section = $('section', 'landing-section landing-plans');
  section.id = 'planos';
  section.append(sectionIntro('monte do seu jeito', 'Um servidor. Você escolhe a capacidade e os extras.'));

  const configurator = $('div', 'landing-configurator');
  const controls = $('div', 'landing-configurator-controls');
  controls.append(
    text('span', 'landing-configurator-eyebrow', 'CONFIGURAÇÃO DO SEU VOX'),
    text('h3', '', 'Quanto espaço o seu time precisa?'),
    text('p', 'landing-configurator-copy', 'Mova o slider para escolher a capacidade. O preço é atualizado na hora.'),
  );

  const slotHeader = $('div', 'landing-configurator-label-row');
  slotHeader.append(text('span', '', 'quantidade de slots'));
  const slotValue = text('strong', '', '10 slots');
  slotValue.dataset.configSlots = 'true';
  slotHeader.append(slotValue);
  controls.append(slotHeader);

  const sliderWrap = $('div', 'landing-configurator-slider-wrap');
  const slider = $('input') as HTMLInputElement;
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(configTiers.length - 1);
  slider.step = '1';
  slider.value = String(selectedTierIndex);
  slider.setAttribute('aria-label', 'Quantidade de slots');
  slider.setAttribute('aria-valuetext', '10 slots');
  sliderWrap.append(slider);

  const marks = $('div', 'landing-configurator-marks');
  for (const tier of configTiers) marks.append(text('span', '', `${tier.slots}`));
  sliderWrap.append(marks);
  controls.append(sliderWrap);

  const botOption = $('label', 'landing-configurator-bot');
  const botCheckbox = $('input') as HTMLInputElement;
  botCheckbox.type = 'checkbox';
  botCheckbox.checked = includeBot;
  botCheckbox.setAttribute('aria-label', 'Adicionar Rubinot');
  const botCopy = $('span', 'landing-configurator-bot-copy');
  botCopy.append(text('strong', '', 'Adicionar Rubinot'), text('small', '', 'Hunted List, UP Level e DeathList automáticos'));
  const botSwitch = $('span', 'landing-configurator-switch');
  botSwitch.append($('i'));
  botOption.append(botCheckbox, botSwitch, botCopy);
  controls.append(botOption, text('p', 'landing-configurator-hint', 'O Rubinot começa a partir de 50 slots.'));

  const summary = $('aside', 'landing-configurator-summary');
  summary.append(text('span', 'landing-configurator-summary-label', 'SUA CONFIGURAÇÃO'));
  const summaryTitle = text('h3', '', 'Comunidade · 10 slots');
  summaryTitle.dataset.configTitle = 'true';
  summary.append(summaryTitle);
  const summaryPrice = text('strong', 'landing-configurator-price', 'gratuito');
  summaryPrice.dataset.configPrice = 'true';
  summary.append(summaryPrice, text('span', 'landing-configurator-period', 'por mês'));
  const summaryList = $('ul', 'landing-configurator-list');
  summary.append(summaryList);
  const action = landingLink('Criar Meu Servidor Grátis', '/contratar?plan=community', 'landing-button landing-button-primary landing-configurator-action');
  action.dataset.configAction = 'true';
  summary.append(action, text('p', 'landing-configurator-note', 'Pix ou cartão · servidor criado após a confirmação do pagamento.'));

  configurator.append(controls, summary);
  section.append(configurator, text('p', 'landing-plan-note', 'Você pode trocar de plano depois pelo painel do cliente.'));

  const sync = (): void => updateConfigurator(section, slider, botCheckbox);
  slider.addEventListener('input', () => {
    selectedTierIndex = Number(slider.value);
    sync();
  });
  botCheckbox.addEventListener('change', () => {
    includeBot = botCheckbox.checked;
    if (includeBot && selectedTierIndex === 0) {
      selectedTierIndex = 1;
      slider.value = '1';
    }
    sync();
  });
  sync();
  return section;
}

function updateConfigurator(section: HTMLElement, slider: HTMLInputElement, botCheckbox: HTMLInputElement): void {
  if (includeBot && selectedTierIndex === 0) selectedTierIndex = 1;
  const tier = configTiers[selectedTierIndex] ?? configTiers[0]!;
  const planKey = includeBot ? tier.botKey ?? configTiers[1]!.botKey! : tier.basicKey;
  const priceCents = landingPrices.get(planKey) ?? (includeBot ? tier.botPriceCents : tier.basicPriceCents);
  const price = section.querySelector('[data-config-price]');
  const slots = section.querySelector('[data-config-slots]');
  const title = section.querySelector('[data-config-title]');
  const action = section.querySelector('[data-config-action]') as HTMLAnchorElement | null;
  const list = section.querySelector('.landing-configurator-list');
  const progress = selectedTierIndex / (configTiers.length - 1) * 100;

  slider.value = String(selectedTierIndex);
  slider.style.setProperty('--landing-slider-progress', `${progress}%`);
  slider.setAttribute('aria-valuetext', `${tier.slots} slots`);
  botCheckbox.checked = includeBot;
  if (slots) slots.textContent = `${tier.slots} slots`;
  if (title) title.textContent = `${tier.label} · ${tier.slots} slots${includeBot ? ' · Rubinot' : ''}`;
  if (price) price.textContent = priceCents > 0 ? formatCents(priceCents) : 'gratuito';
  if (action) {
    action.href = `/contratar?plan=${encodeURIComponent(planKey)}`;
    action.textContent = priceCents > 0 ? 'Continuar com Essa Configuração' : 'Criar Meu Servidor Grátis';
  }
  if (list) {
    list.replaceChildren(
      configBenefit(`${tier.slots} slots para o seu time`),
      configBenefit(includeBot ? 'Rubinot com Hunted List, UP Level e DeathList' : 'Channels e permissões sob seu controle'),
      configBenefit('Áudio QUIC com fallback WS'),
      configBenefit('Painel administrativo incluído'),
    );
  }
  translateTree(section);
}

function configBenefit(value: string): HTMLElement {
  return text('li', '', value);
}

async function refreshLandingPlans(section: HTMLElement): Promise<void> {
  try {
    const response = await fetch('/api/billing/plans');
    if (!response.ok) return;
    const body = await response.json() as { plans?: { key: string; priceCents: number }[] };
    for (const plan of body.plans ?? []) {
      if (plan.priceCents > 0) landingPrices.set(plan.key, plan.priceCents);
    }
    const slider = section.querySelector('input[type="range"]') as HTMLInputElement | null;
    const botCheckbox = section.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (slider && botCheckbox) updateConfigurator(section, slider, botCheckbox);
  } catch {
    // Os preços de fallback continuam visíveis se a API estiver indisponível.
  }
}

function formatCents(value: number): string {
  return (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function renderCta(): HTMLElement {
  const section = $('section', 'landing-cta');
  const content = $('div', 'landing-cta-content');
  content.append(text('span', 'landing-kicker', 'PRONTO PARA ENTRAR?'), text('h2', '', 'Seu time já está esperando.'), text('p', '', 'Abra o Vox, escolha um channel e coloque a comunicação no lugar certo — dentro da partida, sem distração.'));
  const actions = $('div', 'landing-cta-actions');
  actions.append(landingLink('Abrir Painel Vox', '/painel', 'landing-button landing-button-primary'));
  content.append(actions);
  section.append(content);
  return section;
}

function renderFooter(): HTMLElement {
  const footer = $('footer', 'landing-footer');
  const brand = $('a', 'landing-brand') as HTMLAnchorElement;
  brand.href = '/';
  brand.append(iconBrandMark(), text('span', '', 'v0x'));
  const privacy = landingLink('Política de privacidade', '/privacidade', 'landing-footer-copy');
  footer.append(brand, text('span', '', 'voz para quem joga junto'), privacy, text('span', 'landing-footer-copy', `© ${new Date().getFullYear()} v0x`));
  return footer;
}

function sectionIntro(kicker: string, title: string): HTMLElement {
  const intro = $('div', 'landing-section-intro');
  intro.append(text('span', 'landing-kicker', kicker), text('h2', '', title));
  return intro;
}

function heading(tag: string, lines: string[]): HTMLElement {
  const title = $(tag as 'h1', 'landing-title');
  for (const [index, line] of lines.entries()) {
    if (index > 0) title.append(document.createElement('br'));
    title.append(text('span', index === 1 ? 'accent' : '', line));
  }
  return title;
}

function landingLink(label: string, href: string, className = ''): HTMLAnchorElement {
  const link = text('a', className, label) as HTMLAnchorElement;
  link.href = href;
  return link;
}

async function refreshLandingStatus(page: HTMLElement): Promise<void> {
  try {
    const response = await fetch('/health');
    if (!response.ok) return;
    const body = await response.json() as { servers?: { clients?: number }[]; clients?: number };
    const total = body.clients ?? body.servers?.reduce((sum, server) => sum + (server.clients ?? 0), 0) ?? 0;
    const note = page.querySelector('.landing-window-signal');
    if (note) note.textContent = total > 0 ? `${total} ONLINE` : 'ONLINE';
  } catch {
    // A landing page nao depende do health check para continuar navegavel.
  }
}

// O configurador usa os dados declarados acima; monte a página somente depois
// de o módulo concluir a inicialização dessas constantes.
if (root) {
  registerPwaServiceWorker();
  root.append(renderLandingPage());
}
