import { $, text } from './ui/dom.js';
import './pwa.css';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type PwaInstallPlatform = 'ios' | 'android' | 'other';
export type PwaInstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

export interface PwaInstallState {
  standalone: boolean;
  platform: PwaInstallPlatform;
  promptAvailable: boolean;
}

export interface PwaInstallButtonOptions {
  /** Mantem o botao visivel para exibir instrucoes mesmo sem prompt nativo. */
  alwaysVisible?: boolean;
}

export interface PwaInstallCardOptions {
  compact?: boolean;
  dismissible?: boolean;
  mobileOnly?: boolean;
}

let deferredPrompt: InstallPromptEvent | null = null;
let lifecycleReady = false;
let installCardDismissed = false;
let appInstalled = false;

export function isPwaStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function detectPlatform(): PwaInstallPlatform {
  const userAgent = navigator.userAgent;
  const isIpad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPad|iPhone|iPod/.test(userAgent) || isIpad) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'other';
}

function ensurePwaLifecycle(): void {
  if (lifecycleReady || typeof window === 'undefined') return;
  lifecycleReady = true;

  window.addEventListener('beforeinstallprompt', (event) => {
    const prompt = event as InstallPromptEvent;
    if (typeof prompt.prompt !== 'function') return;
    event.preventDefault();
    deferredPrompt = prompt;
    refreshPwaInstallUi();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    appInstalled = true;
    refreshPwaInstallUi();
  });
}

export function getPwaInstallState(): PwaInstallState {
  ensurePwaLifecycle();
  return {
    standalone: appInstalled || isPwaStandalone(),
    platform: detectPlatform(),
    promptAvailable: deferredPrompt !== null,
  };
}

function installButtonLabel(state: PwaInstallState): string {
  if (state.promptAvailable) return 'Instalar agora';
  if (state.platform === 'ios') return 'Como instalar no iPhone';
  if (state.platform === 'android') return 'Como instalar no Android';
  return 'Como instalar';
}

function refreshPwaInstallUi(): void {
  if (typeof document === 'undefined') return;
  const state = getPwaInstallState();
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-pwa-install-action]');
  for (const button of buttons) {
    const isCardAction = button.dataset.pwaInstallCardAction === 'true';
    const alwaysVisible = button.dataset.pwaInstallAlwaysVisible === 'true';
    if (state.standalone) {
      button.closest('.pwa-install-card')?.remove();
      button.hidden = true;
      continue;
    }
    button.textContent = installButtonLabel(state);
    button.disabled = false;
    if (!isCardAction) {
      button.hidden = !(alwaysVisible || state.promptAvailable || state.platform === 'ios');
    }
  }
}

export async function promptPwaInstall(): Promise<PwaInstallOutcome> {
  ensurePwaLifecycle();
  const prompt = deferredPrompt;
  if (!prompt) return 'unavailable';

  deferredPrompt = null;
  refreshPwaInstallUi();
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    refreshPwaInstallUi();
    return choice.outcome;
  } catch {
    refreshPwaInstallUi();
    return 'unavailable';
  }
}

export function setupPwaInstall(
  button: HTMLButtonElement,
  options: PwaInstallButtonOptions = {},
): void {
  ensurePwaLifecycle();
  button.dataset.pwaInstallAction = 'true';
  button.dataset.pwaInstallAlwaysVisible = options.alwaysVisible ? 'true' : 'false';
  if (button.dataset.pwaInstallBound === 'true') {
    refreshPwaInstallUi();
    return;
  }

  button.dataset.pwaInstallBound = 'true';
  button.addEventListener('click', () => {
    void promptPwaInstall().then((outcome) => {
      if (outcome === 'unavailable') openPwaInstallGuide();
    });
  });
  refreshPwaInstallUi();
}

export function createPwaInstallCard(options: PwaInstallCardOptions = {}): HTMLElement | null {
  ensurePwaLifecycle();
  const state = getPwaInstallState();
  if (state.standalone || (options.dismissible && installCardDismissed)) return null;

  const classes = [
    'pwa-install-card',
    options.compact ? 'pwa-install-compact' : '',
    options.mobileOnly ? 'pwa-install-mobile-only' : '',
  ].filter(Boolean).join(' ');
  const card = $('aside', classes);
  card.setAttribute('aria-label', 'Instalar o v0x como aplicativo');

  const icon = text('span', 'pwa-install-icon', 'v0x');
  const copy = $('div', 'pwa-install-copy');
  copy.append(
    text('strong', '', options.compact ? 'Instale o v0x no celular' : 'Leve o v0x para o celular'),
    text('span', 'pwa-install-description', 'Acesso rápido, tela cheia e sem procurar o site toda vez.'),
  );

  const actions = $('div', 'pwa-install-actions');
  const action = text('button', 'pwa-install-action', installButtonLabel(state)) as HTMLButtonElement;
  action.type = 'button';
  action.dataset.pwaInstallAction = 'true';
  action.dataset.pwaInstallCardAction = 'true';
  action.addEventListener('click', () => {
    void promptPwaInstall().then((outcome) => {
      if (outcome === 'unavailable') openPwaInstallGuide();
    });
  });
  actions.append(action);

  if (options.dismissible) {
    const dismiss = text('button', 'pwa-install-dismiss', '×') as HTMLButtonElement;
    dismiss.type = 'button';
    dismiss.title = 'fechar aviso';
    dismiss.setAttribute('aria-label', 'Fechar aviso de instalação');
    dismiss.addEventListener('click', () => {
      installCardDismissed = true;
      card.remove();
    });
    actions.append(dismiss);
  }

  card.append(icon, copy, actions);
  return card;
}

export function openPwaInstallGuide(): void {
  if (document.querySelector('.pwa-install-overlay')) return;

  const state = getPwaInstallState();
  const overlay = $('div', 'pwa-install-overlay');
  const modal = $('section', 'pwa-install-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'pwa-install-title');

  const title = text('h2', '', state.platform === 'ios' ? 'Instale o v0x no iPhone' : 'Instale o v0x no celular');
  title.id = 'pwa-install-title';
  const intro = text('p', 'pwa-install-intro', state.platform === 'ios'
    ? 'No Safari, o v0x pode virar um aplicativo na sua tela de início.'
    : 'Adicione o v0x à tela inicial para abrir a call como um aplicativo.');

  const steps = $('ol', 'pwa-install-steps');
  if (state.platform === 'ios') {
    steps.append(
      text('li', '', 'Abra esta página no Safari.'),
      text('li', '', 'Toque no botão Compartilhar.'),
      text('li', '', 'Escolha Adicionar à Tela de Início e confirme.'),
    );
  } else if (state.platform === 'android') {
    steps.append(
      text('li', '', 'Abra o menu ⋮ do Chrome.'),
      text('li', '', 'Toque em Instalar aplicativo ou Adicionar à tela inicial.'),
      text('li', '', 'Confirme a instalação do v0x.'),
    );
  } else {
    steps.append(
      text('li', '', 'Abra o menu do seu navegador.'),
      text('li', '', 'Escolha Instalar aplicativo ou Adicionar à tela inicial.'),
    );
  }

  const footer = $('div', 'pwa-install-modal-footer');
  const close = text('button', 'pwa-install-close', 'entendi') as HTMLButtonElement;
  close.type = 'button';
  close.addEventListener('click', () => overlay.remove());
  footer.append(close);
  modal.append(title, intro, steps, footer);
  overlay.append(modal);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
}

export function registerPwaServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  void navigator.serviceWorker.register('/sw.js', { scope: '/' });
}
