/**
 * Notificacoes nativas: Web (Notification API) + Tauri (plugin notification).
 *
 * Unifica as duas plataformas com uma API simples.
 */

type NotificationOptions = {
  title: string;
  body: string;
  tag?: string;
  icon?: string;
  silent?: boolean;
};

let tauriNotify: ((options: { title: string; body: string; icon?: string }) => Promise<void>) | null = null;
let permissionGranted = false;
let permissionRequested = false;

/**
 * Inicializa o sistema de notificacoes.
 * No Tauri, carrega o plugin dinamicamente.
 */
export async function initNotifications(): Promise<void> {
  if (typeof window === 'undefined') return;

  // Web: request permission if not already granted
  if ('Notification' in window && Notification.permission === 'default' && !permissionRequested) {
    permissionRequested = true;
    try {
      const perm = await Notification.requestPermission();
      permissionGranted = perm === 'granted';
    } catch {
      permissionGranted = false;
    }
  } else if ('Notification' in window) {
    permissionGranted = Notification.permission === 'granted';
  }

  // Tauri: try to load plugin (dynamic string prevents Vite static analysis)
  try {
    const pluginId = '@tauri-apps/' + 'plugin-notification';
    const mod = await import(/* @vite-ignore */ pluginId);
    if (mod?.notify) tauriNotify = mod.notify;
  } catch {
    // not running in Tauri or plugin not available
  }
}

/**
 * Verifica se notificacoes estao disponiveis e permitidas.
 */
export function canNotify(): boolean {
  if (tauriNotify) return true;
  return 'Notification' in window && permissionGranted;
}

/**
 * Mostra uma notificacao nativa.
 */
export async function notify(options: NotificationOptions): Promise<void> {
  if (!canNotify()) return;

  if (tauriNotify) {
    try {
      await tauriNotify({
        title: options.title,
        body: options.body,
        ...(options.icon ? { icon: options.icon } : {}),
      });
      return;
    } catch {
      // fallback para Web API
    }
  }

  // Web Notification API
  try {
    const n = new Notification(options.title, {
      body: options.body,
      ...(options.tag ? { tag: options.tag } : {}),
      ...(options.icon ? { icon: options.icon } : {}),
      ...(options.silent ? { silent: options.silent } : {}),
    });
    // Auto-close apos 5s
    setTimeout(() => n.close(), 5000);
  } catch {
    // ignorar erro
  }
}

/**
 * Pede permissao de notificacao (pode ser chamado ao clicar no checkbox nas settings).
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if ('Notification' in window && Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    permissionGranted = perm === 'granted';
    return permissionGranted;
  }
  return permissionGranted;
}

/**
 * Helper para notificacoes comuns do app.
 */
export const notifications = {
  /** Alguem mencionou seu nick no chat */
  mention(nick: string, channel: string, text: string): void {
    notify({ title: `Menção em #${channel}`, body: `${nick}: ${text}`, tag: `mention-${Date.now()}` });
  },
  /** Mensagem privada */
  privateMessage(nick: string, text: string): void {
    notify({ title: `Mensagem de ${nick}`, body: text, tag: `pm-${nick}` });
  },
  /** Poke recebido */
  poke(from: string): void {
    notify({ title: 'Poke!', body: `${from} te cutucou`, tag: 'poke' });
  },
  /** Kick/ban */
  moderation(action: 'kick' | 'ban', reason?: string): void {
    notify({ title: `Você foi ${action === 'kick' ? 'expulso' : 'banido'}`, body: reason || '', tag: 'moderation' });
  },
  /** Alguem entrou no seu canal */
  userJoinedChannel(nick: string, channel: string): void {
    notify({ title: `${nick} entrou em #${channel}`, body: '', tag: `join-${channel}` });
  },
};