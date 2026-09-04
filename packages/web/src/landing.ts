import { iconBrandMark } from './ui/icons.js';
import { $, text } from './ui/dom.js';
import './landing.css';

const root = document.getElementById('landing');

if (root) {
  root.append(renderLandingPage());
}

function renderLandingPage(): HTMLElement {
  const page = $('main', 'landing-page');
  page.append(renderNav());
  const shell = $('div', 'landing-shell');
  shell.append(renderHero(), renderTrustBar(), renderFeatures(), renderFlow(), renderPlans(), renderCta(), renderFooter());
  page.append(shell);
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
    landingLink('recursos', '#recursos'),
    landingLink('como funciona', '#como-funciona'),
    landingLink('planos', '#planos'),
  );

  const actions = $('div', 'landing-nav-actions');
  actions.append(
    landingLink('painel admin', '/admin', 'landing-nav-muted'),
    landingLink('entrar', '/app', 'landing-button landing-button-small'),
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
    landingLink('entrar no Vox', '/app', 'landing-button landing-button-primary'),
    landingLink('conhecer recursos', '#recursos', 'landing-button landing-button-outline'),
  );
  copy.append(actions, renderQuickConnect());

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
  submit.textContent = 'conectar';
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

function renderPlans(): HTMLElement {
  const section = $('section', 'landing-section landing-plans');
  section.id = 'planos';
  section.append(sectionIntro('planos', 'Comece pequeno. Cresça quando o time pedir mais espaço.'));
  const grid = $('div', 'landing-plan-grid');
  grid.append(
    planCard('comunidade', 'Para testar com o time', 'gratuito', ['Channels essenciais', 'Áudio em tempo real', 'Acesso pelo navegador'], 'começar agora', '/app'),
    planCard('privado', 'Para sua guilda', 'sob consulta', ['Servidor dedicado', 'Permissões e grupos', 'Bot e canais organizados'], 'falar sobre o Vox', '/app', true),
    planCard('war room', 'Para operações maiores', 'sob medida', ['Estrutura para vários times', 'Edges regionais', 'Suporte de implantação'], 'montar estrutura', '/app'),
  );
  section.append(grid, text('p', 'landing-plan-note', 'Os planos comerciais serão conectados ao checkout na próxima etapa. Por enquanto, você já pode entrar e testar a experiência do Vox.'));
  return section;
}

function planCard(label: string, title: string, price: string, benefits: string[], action: string, href: string, featured = false): HTMLElement {
  const card = $('article', `landing-plan${featured ? ' featured' : ''}`);
  card.append(text('span', 'landing-plan-label', label), text('h3', '', title), text('strong', 'landing-plan-price', price));
  const list = $('ul', 'landing-plan-list');
  for (const benefit of benefits) list.append(text('li', '', benefit));
  card.append(list, landingLink(action, href, 'landing-button landing-button-outline'));
  return card;
}

function renderCta(): HTMLElement {
  const section = $('section', 'landing-cta');
  const content = $('div', 'landing-cta-content');
  content.append(text('span', 'landing-kicker', 'PRONTO PARA ENTRAR?'), text('h2', '', 'Seu time já está esperando.'), text('p', '', 'Abra o Vox, escolha um channel e coloque a comunicação no lugar certo — dentro da partida, sem distração.'));
  const actions = $('div', 'landing-cta-actions');
  actions.append(landingLink('acessar área do cliente', '/cliente', 'landing-button landing-button-primary'), landingLink('painel administrativo', '/admin', 'landing-button landing-button-outline'));
  content.append(actions);
  section.append(content);
  return section;
}

function renderFooter(): HTMLElement {
  const footer = $('footer', 'landing-footer');
  const brand = $('a', 'landing-brand') as HTMLAnchorElement;
  brand.href = '/';
  brand.append(iconBrandMark(), text('span', '', 'v0x'));
  footer.append(brand, text('span', '', 'voz para quem joga junto'), text('span', 'landing-footer-copy', `© ${new Date().getFullYear()} v0x`));
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
