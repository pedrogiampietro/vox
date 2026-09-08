/**
 * Localização da interface web.
 *
 * O conteúdo vindo do servidor (nomes de canais, mensagens e apelidos) não é
 * traduzido. A tabela abaixo cobre apenas os textos criados pelo cliente e
 * também funciona como fallback para telas que ainda estão sendo migradas.
 */

export type Locale = 'pt-BR' | 'en' | 'es';

export const LOCALE_OPTIONS: readonly { value: Locale; label: string }[] = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
];

const LOCALE_KEY = 'vox.locale';
const DEFAULT_LOCALE: Locale = 'pt-BR';

// Conteúdo fornecido pelo usuário ou pelo servidor deve permanecer exatamente
// como foi escrito. Os componentes podem optar por este atributo quando o
// texto não tiver uma classe própria.
const DYNAMIC_CONTENT_SELECTOR = [
  '[data-i18n-skip]',
  '.peer',
  '.line',
  '.dm-row',
  '.poke-entry',
  '.channel-name',
  '.channel-desc',
  '.member-item',
  '.server-card .name',
  '.server-card .where',
  '.room-info .name',
  '.room-info .topic',
  '.rooms-headline .name',
].join(', ');

const PAGE_TITLES: Record<Locale, Record<string, string>> = {
  'pt-BR': {
    '/landing.html': 'v0x — voz para quem joga junto',
    '/customer.html': 'v0x — área do cliente',
    '/checkout.html': 'v0x — contratar servidor',
  },
  en: {
    '/landing.html': 'v0x — voice for teams that play together',
    '/customer.html': 'v0x — customer area',
    '/checkout.html': 'v0x — order a server',
  },
  es: {
    '/landing.html': 'v0x — voz para quienes juegan juntos',
    '/customer.html': 'v0x — área del cliente',
    '/checkout.html': 'v0x — contratar servidor',
  },
};

type Translation = readonly [string, string, string];

const TRANSLATIONS: readonly Translation[] = [
  ['servidores', 'servers', 'servidores'],
  ['identidade', 'identity', 'identidad'],
  ['Identidade', 'Identity', 'Identidad'],
  ['IDENTIDADE', 'IDENTITY', 'IDENTIDAD'],
  ['Capturar', 'Capture', 'Captura'],
  ['CAPTURAR', 'CAPTURE', 'CAPTURA'],
  ['Reprodução', 'Playback', 'Reproducción'],
  ['REPRODUÇÃO', 'PLAYBACK', 'REPRODUCCIÓN'],
  ['Notificações', 'Notifications', 'Notificaciones'],
  ['NOTIFICAÇÕES', 'NOTIFICATIONS', 'NOTIFICACIONES'],
  ['Grupos', 'Groups', 'Grupos'],
  ['GRUPOS', 'GROUPS', 'GRUPOS'],
  ['Permissões', 'Permissions', 'Permisos'],
  ['PERMISSÕES', 'PERMISSIONS', 'PERMISOS'],
  ['Bot', 'Bot', 'Bot'],
  ['Idioma', 'Language', 'Idioma'],
  ['online agora', 'online now', 'en línea ahora'],
  ['servidor local', 'local server', 'servidor local'],
  ['editar', 'edit', 'editar'],
  ['editar servidor', 'edit server', 'editar servidor'],
  ['adicionar servidor', 'add server', 'agregar servidor'],
  ['+ adicionar servidor', '+ add server', '+ agregar servidor'],
  ['endereco do servidor', 'server address', 'dirección del servidor'],
  ['endereço do servidor', 'server address', 'dirección del servidor'],
  ['seu apelido', 'your nickname', 'tu apodo'],
  ['senha (opcional)', 'password (optional)', 'contraseña (opcional)'],
  ['senha', 'password', 'contraseña'],
  ['se houver', 'if any', 'si existe'],
  ['entrar no servidor', 'join server', 'entrar al servidor'],
  ['salvar', 'save', 'guardar'],
  ['salvar alterações', 'save changes', 'guardar cambios'],
  ['remover', 'remove', 'quitar'],
  ['cancelar', 'cancel', 'cancelar'],
  ['fechar', 'close', 'cerrar'],
  ['voltar', 'back', 'volver'],
  ['sair', 'leave', 'salir'],
  ['+ canal', '+ channel', '+ canal'],
  ['canal', 'channel', 'canal'],
  ['canais', 'channels', 'canales'],
  ['nenhum canal disponível', 'no channels available', 'no hay canales disponibles'],
  ['canal lotado', 'channel is full', 'canal lleno'],
  ['recolher canal', 'collapse channel', 'contraer canal'],
  ['expandir canal', 'expand channel', 'expandir canal'],
  ['sem voz', 'no voice', 'sin voz'],
  ['moderado', 'moderated', 'moderado'],
  ['BOT', 'BOT', 'BOT'],
  ['CANAIS', 'CHANNELS', 'CANALES'],
  ['FERRAMENTAS', 'TOOLS', 'HERRAMIENTAS'],
  ['visão geral', 'overview', 'resumen'],
  ['respawns reivindicados', 'claimed respawns', 'respawns reclamados'],
  ['nenhuma mensagem ainda', 'no messages yet', 'todavía no hay mensajes'],
  ['sem mensagens no canal', 'no messages in this channel', 'no hay mensajes en este canal'],
  ['escreva algo para começar a conversa', 'write something to start the conversation', 'escribe algo para iniciar la conversación'],
  ['mensagem…', 'message…', 'mensaje…'],
  ['mensagem privada', 'private message', 'mensaje privado'],
  ['conectado', 'connected', 'conectado'],
  ['conectados', 'connected', 'conectados'],
  ['voce', 'you', 'tú'],
  ['você', 'you', 'tú'],
  ['membros', 'members', 'miembros'],
  ['voz', 'voice', 'voz'],
  ['online no Tibia', 'online in Tibia', 'en línea en Tibia'],
  ['offline no Tibia', 'offline in Tibia', 'desconectado en Tibia'],
  ['offline', 'offline', 'desconectado'],
  ['silenciado pela moderação', 'muted by moderation', 'silenciado por moderación'],
  ['ausente', 'away', 'ausente'],
  ['claimed resp', 'claimed respawns', 'respawns reclamados'],
  ['1 ativo', '1 active', '1 activo'],
  ['1 ativos', '1 active', '1 activo'],
  ['ativos', 'active', 'activos'],
  ['buscar respawn', 'search respawn', 'buscar respawn'],
  ['nota opcional', 'optional note', 'nota opcional'],
  ['duração fixa do claim', 'claim duration is fixed', 'la duración del claim es fija'],
  ['nenhum respawn encontrado', 'no respawn found', 'no se encontró ningún respawn'],
  ['ocupados', 'occupied', 'ocupados'],
  ['nenhum respawn ocupado', 'no occupied respawn', 'ningún respawn ocupado'],
  ['todos os respawns', 'all respawns', 'todos los respawns'],
  ['sair fila', 'leave queue', 'salir de la cola'],
  ['fila', 'queue', 'cola'],
  ['liberar', 'release', 'liberar'],
  ['próximo', 'next', 'siguiente'],
  ['Poke recebido', 'Poke received', 'Poke recibido'],
  ['limpar tudo', 'clear all', 'limpiar todo'],
  ['ações do servidor', 'server actions', 'acciones del servidor'],
  ['testar', 'test', 'probar'],
  ['testar notificação', 'test notification', 'probar notificación'],
  ['notificação', 'notification', 'notificación'],
  ['Notificação de teste funcionando!', 'Test notification working!', '¡La notificación de prueba funciona!'],
  ['Conexão perdida', 'Connection lost', 'Conexión perdida'],
  ['CONEXÃO FALHOU', 'CONNECTION FAILED', 'CONEXIÓN FALLIDA'],
  ['CONECTANDO', 'CONNECTING', 'CONECTANDO'],
  ['Não foi possível entrar', 'Could not join', 'No fue posible entrar'],
  ['Entrando no servidor', 'Joining server', 'Entrando al servidor'],
  ['servidor atual', 'current server', 'servidor actual'],
  ['Preparando identidade e áudio', 'Preparing identity and audio', 'Preparando identidad y audio'],
  ['Conectando ao servidor', 'Connecting to server', 'Conectando al servidor'],
  ['Autenticando acesso', 'Authenticating access', 'Autenticando acceso'],
  ['Carregando canais e usuários', 'Loading channels and users', 'Cargando canales y usuarios'],
  ['Sessão pronta', 'Session ready', 'Sesión lista'],
  ['tentar novamente', 'try again', 'intentar de nuevo'],
  ['configurações', 'settings', 'configuración'],
  ['reprodução', 'playback', 'reproducción'],
  ['ações do servidor', 'server actions', 'acciones del servidor'],
  ['arraste para aumentar ou diminuir a descrição', 'drag to resize the description', 'arrastra para cambiar el tamaño de la descripción'],
  ['redimensionar descrição do canal', 'resize channel description', 'cambiar tamaño de la descripción del canal'],
  ['entrar', 'join', 'entrar'],
  ['criar canal', 'create channel', 'crear canal'],
  ['criar sub-canal', 'create sub-channel', 'crear subcanal'],
  ['editar canal', 'edit channel', 'editar canal'],
  ['gerenciar bans', 'manage bans', 'gestionar baneos'],
  ['gerenciar grupos', 'manage groups', 'gestionar grupos'],
  ['expulsar', 'kick', 'expulsar'],
  ['mutar', 'mute', 'silenciar'],
  ['desmutar', 'unmute', 'activar sonido'],
  ['expulsar todos do servidor', 'kick everyone from the server', 'expulsar a todos del servidor'],
  ['remover canal', 'remove channel', 'eliminar canal'],
  ['enviar poke', 'send poke', 'enviar poke'],
  ['cancelar', 'cancel', 'cancelar'],
  ['aplicar', 'apply', 'aplicar'],
  ['salvar descrição', 'save description', 'guardar descripción'],
  ['gerar nova identidade', 'generate new identity', 'generar nueva identidad'],
  ['Esta chave define quem você é para os servidores.', 'This key defines who you are to servers.', 'Esta clave define quién eres para los servidores.'],
  ['identidade ainda não carregada', 'identity not loaded yet', 'identidad aún no cargada'],
  ['cole aqui um backup de identidade', 'paste an identity backup here', 'pega aquí una copia de seguridad de identidad'],
  ['copiar fingerprint', 'copy fingerprint', 'copiar fingerprint'],
  ['copiado', 'copied', 'copiado'],
  ['Backup da identidade', 'Identity backup', 'Copia de seguridad de identidad'],
  ['copiar backup', 'copy backup', 'copiar copia de seguridad'],
  ['backup copiado', 'backup copied', 'copia de seguridad copiada'],
  ['Importar identidade', 'Import identity', 'Importar identidad'],
  ['importar', 'import', 'importar'],
  ['backup inválido', 'invalid backup', 'copia de seguridad inválida'],
  ['CAPTURAR', 'CAPTURE', 'CAPTURA'],
  ['Voz mono em 48 kHz, com processamento otimizado para fala', 'Mono voice at 48 kHz, optimized for speech', 'Voz mono a 48 kHz, optimizada para habla'],
  ['Dispositivo de captura', 'Capture device', 'Dispositivo de captura'],
  ['Dispositivo de reprodução', 'Playback device', 'Dispositivo de reproducción'],
  ['padrão do sistema', 'system default', 'predeterminado del sistema'],
  ['microfone', 'microphone', 'micrófono'],
  ['saída', 'output', 'salida'],
  ['Ativação', 'Activation', 'Activación'],
  ['Tecla Push-to-Talk', 'Push-to-Talk key', 'Tecla Push-to-Talk'],
  ['pressione uma tecla...', 'press a key...', 'presiona una tecla…'],
  ['Limiar de detecção de voz', 'Voice detection threshold', 'Umbral de detección de voz'],
  ['O medidor mostra o nível atual. O limiar de parada é suavizado para não cortar sílabas.', 'The meter shows the current level. The stop threshold is softened to avoid cutting off syllables.', 'El medidor muestra el nivel actual. El umbral de parada se suaviza para no cortar sílabas.'],
  ['calibrar ruído ambiente', 'calibrate ambient noise', 'calibrar ruido ambiental'],
  ['fique em silêncio por 1,5 s', 'stay silent for 1.5 s', 'guarda silencio durante 1,5 s'],
  ['medindo...', 'measuring...', 'midiendo…'],
  ['microfone indisponível', 'microphone unavailable', 'micrófono no disponible'],
  ['parar teste', 'stop test', 'detener prueba'],
  ['ouvir teste de microfone', 'listen to microphone test', 'escuchar prueba de micrófono'],
  ['erro de microfone', 'microphone error', 'error de micrófono'],
  ['ANÁLISE DE VOZ', 'VOICE ANALYSIS', 'ANÁLISIS DE VOZ'],
  ['Grava localmente o mix do canal e o microfone local para comparar qualidade, cortes e ruído.', 'Locally records the channel mix and local microphone to compare quality, dropouts, and noise.', 'Graba localmente la mezcla del canal y el micrófono para comparar calidad, cortes y ruido.'],
  ['Use somente com o consentimento das pessoas gravadas.', 'Use only with the consent of the people being recorded.', 'Úsalo solo con el consentimiento de las personas grabadas.'],
  ['iniciar gravação de análise', 'start analysis recording', 'iniciar grabación de análisis'],
  ['parar e salvar', 'stop and save', 'detener y guardar'],
  ['erro ao iniciar gravação', 'error starting recording', 'error al iniciar la grabación'],
  ['baixar relatório JSON', 'download JSON report', 'descargar informe JSON'],
  ['Qualidade de voz (bitrate)', 'Voice quality (bitrate)', 'Calidad de voz (bitrate)'],
  ['REPRODUÇÃO', 'PLAYBACK', 'REPRODUCCIÓN'],
  ['Configure o sistema de reprodução de áudio', 'Configure audio playback', 'Configura la reproducción de audio'],
  ['Volume geral', 'Master volume', 'Volumen general'],
  ['AVISOS SONOROS', 'SOUND ALERTS', 'ALERTAS DE SONIDO'],
  ['Escolha tons ou uma voz masculina/feminina em português ou inglês. A voz disponível depende do sistema.', 'Choose tones or a male/female voice in Portuguese or English. Available voices depend on the system.', 'Elige tonos o una voz masculina/femenina en portugués o inglés. Las voces disponibles dependen del sistema.'],
  ['Ativar avisos sonoros', 'Enable sound alerts', 'Activar alertas de sonido'],
  ['Pacote de sons', 'Sound pack', 'Paquete de sonidos'],
  ['Volume dos avisos', 'Alert volume', 'Volumen de alertas'],
  ['Ajuste de voz (preamp)', 'Voice adjustment (preamp)', 'Ajuste de voz (preamp)'],
  ['testar:', 'test:', 'probar:'],
  ['Alguém entrou', 'Someone joined', 'Alguien entró'],
  ['Alguém saiu', 'Someone left', 'Alguien salió'],
  ['Mensagem recebida', 'Message received', 'Mensaje recibido'],
  ['Conectado', 'Connected', 'Conectado'],
  ['Microfone mutado', 'Microphone muted', 'Micrófono silenciado'],
  ['Microfone ativado', 'Microphone unmuted', 'Micrófono activado'],
  ['Fones mutados', 'Headphones muted', 'Auriculares silenciados'],
  ['Fones ativados', 'Headphones unmuted', 'Auriculares activados'],
  ['Troca de canal', 'Channel changed', 'Cambio de canal'],
  ['Compartilhamento de tela', 'Screen sharing', 'Compartir pantalla'],
  ['Respawn reivindicado', 'Respawn claimed', 'Respawn reclamado'],
  ['NOTIFICAÇÕES', 'NOTIFICATIONS', 'NOTIFICACIONES'],
  ['Configure notificações nativas do sistema', 'Configure native system notifications', 'Configura las notificaciones nativas del sistema'],
  ['Ativar notificações nativas (menções, mensagens privadas, pokes, kick/ban)', 'Enable native notifications (mentions, private messages, pokes, kicks/bans)', 'Activar notificaciones nativas (menciones, mensajes privados, pokes, expulsiones/baneos)'],
  ['🔒 Permitir notificações', '🔒 Allow notifications', '🔒 Permitir notificaciones'],
  ['✅ Permitido', '✅ Allowed', '✅ Permitido'],
  ['❌ Negado', '❌ Denied', '❌ Denegado'],
  ['▶ testar notificação', '▶ test notification', '▶ probar notificación'],
  ['PERMISSÕES DO SERVIDOR', 'SERVER PERMISSIONS', 'PERMISOS DEL SERVIDOR'],
  ['Grupo mínimo pra cada ação. Envio direto ao clicar no dropdown.', 'Minimum group for each action. Changes are sent when you select a dropdown option.', 'Grupo mínimo para cada acción. Se envía al seleccionar una opción.'],
  ['CANAIS', 'CHANNELS', 'CANALES'],
  ['MODERAÇÃO', 'MODERATION', 'MODERACIÓN'],
  ['COMANDOS DO BOT', 'BOT COMMANDS', 'COMANDOS DEL BOT'],
  ['restaurar padrões', 'restore defaults', 'restaurar valores predeterminados'],
  ['GRUPOS DO SERVIDOR', 'SERVER GROUPS', 'GRUPOS DEL SERVIDOR'],
  ['Configure nome, cor e ícone dos grupos. As alterações só valem depois de salvar.', 'Configure group names, colors, and icons. Changes take effect after saving.', 'Configura nombres, colores e iconos de los grupos. Los cambios se aplican después de guardar.'],
  ['salvar alterações', 'save changes', 'guardar cambios'],
  ['descartar', 'discard', 'descartar'],
  ['PRESET DO SERVIDOR', 'SERVER PRESET', 'PREAJUSTE DEL SERVIDOR'],
  ['aplicar preset', 'apply preset', 'aplicar preajuste'],
  ['recriar do zero', 'recreate from scratch', 'recrear desde cero'],
  ['exportar preset', 'export preset', 'exportar preajuste'],
  ['importar preset', 'import preset', 'importar preajuste'],
  ['trocar', 'change', 'cambiar'],
  ['ícone', 'icon', 'icono'],
  ['Nome', 'Name', 'Nombre'],
  ['Cor', 'Color', 'Color'],
  ['padrão', 'default', 'predeterminado'],
  ['Idioma', 'Language', 'Idioma'],
  ['Selecione o idioma da interface', 'Choose the interface language', 'Elige el idioma de la interfaz'],
  ['Português (Brasil)', 'Portuguese (Brazil)', 'Portugués (Brasil)'],
  ['APLICAR', 'APPLY', 'APLICAR'],
  ['Instalar o v0x como aplicativo', 'Install v0x as an app', 'Instalar v0x como aplicación'],
  ['Instale o v0x no celular', 'Install v0x on your phone', 'Instala v0x en tu celular'],
  ['Leve o v0x para o celular', 'Take v0x to your phone', 'Lleva v0x a tu celular'],
  ['Acesso rápido, tela cheia e sem procurar o site toda vez.', 'Quick access, full screen, and no need to find the site every time.', 'Acceso rápido, pantalla completa y sin buscar el sitio cada vez.'],
  ['Instalar agora', 'Install now', 'Instalar ahora'],
  ['Como instalar no iPhone', 'How to install on iPhone', 'Cómo instalar en iPhone'],
  ['Como instalar no Android', 'How to install on Android', 'Cómo instalar en Android'],
  ['Como instalar', 'How to install', 'Cómo instalar'],
  ['fechar aviso', 'close notice', 'cerrar aviso'],
  ['Fechar aviso de instalação', 'Close installation notice', 'Cerrar aviso de instalación'],
  ['Instale o v0x no iPhone', 'Install v0x on iPhone', 'Instala v0x en iPhone'],
  ['Instale o v0x no celular', 'Install v0x on your phone', 'Instala v0x en tu celular'],
  ['No Safari, o v0x pode virar um aplicativo na sua tela de início.', 'In Safari, v0x can become an app on your home screen.', 'En Safari, v0x puede convertirse en una aplicación en tu pantalla de inicio.'],
  ['Adicione o v0x à tela inicial para abrir a call como um aplicativo.', 'Add v0x to your home screen to open the call like an app.', 'Añade v0x a tu pantalla de inicio para abrir la llamada como una aplicación.'],
  ['Abra esta página no Safari.', 'Open this page in Safari.', 'Abre esta página en Safari.'],
  ['Toque no botão Compartilhar.', 'Tap the Share button.', 'Toca el botón Compartir.'],
  ['Escolha Adicionar à Tela de Início e confirme.', 'Choose Add to Home Screen and confirm.', 'Elige Añadir a pantalla de inicio y confirma.'],
  ['Abra o menu ⋮ do Chrome.', 'Open Chrome’s ⋮ menu.', 'Abre el menú ⋮ de Chrome.'],
  ['Toque em Instalar aplicativo ou Adicionar à tela inicial.', 'Tap Install app or Add to home screen.', 'Toca Instalar aplicación o Añadir a pantalla de inicio.'],
  ['Confirme a instalação do v0x.', 'Confirm the v0x installation.', 'Confirma la instalación de v0x.'],
  ['Abra o menu do seu navegador.', 'Open your browser menu.', 'Abre el menú de tu navegador.'],
  ['Escolha Instalar aplicativo ou Adicionar à tela inicial.', 'Choose Install app or Add to home screen.', 'Elige Instalar aplicación o Añadir a pantalla de inicio.'],
  ['entendi', 'got it', 'entendido'],
  ['▶', '▶', '▶'],
  ['radio · tons', 'radio · tones', 'radio · tonos'],
  ['minimal · tons', 'minimal · tones', 'minimal · tonos'],
  ['voz PT · masculina', 'PT voice · male', 'voz PT · masculina'],
  ['voz PT · feminina', 'PT voice · female', 'voz PT · femenina'],
  ['voz EN · masculina', 'EN voice · male', 'voz EN · masculina'],
  ['voz EN · feminina', 'EN voice · female', 'voz EN · femenina'],
  ['v0x Radio (tons)', 'v0x Radio (tones)', 'v0x Radio (tonos)'],
  ['Minimal (tons)', 'Minimal (tones)', 'Minimal (tonos)'],
  ['Voz masculina · Português (Brasil)', 'Male voice · Portuguese (Brazil)', 'Voz masculina · Portugués (Brasil)'],
  ['Voz feminina · Português (Brasil)', 'Female voice · Portuguese (Brazil)', 'Voz femenina · Portugués (Brasil)'],
  ['Voz masculina · Inglês', 'Male voice · English', 'Voz masculina · Inglés'],
  ['Voz feminina · Inglês', 'Female voice · English', 'Voz femenina · Inglés'],
  ['Recursos', 'Features', 'Recursos'],
  ['Como Funciona', 'How It Works', 'Cómo funciona'],
  ['Download', 'Download', 'Descargas'],
  ['Planos', 'Plans', 'Planes'],
  ['Entrar no Vox', 'Open Vox', 'Entrar a Vox'],
  ['Abrir Vox', 'Open Vox', 'Abrir Vox'],
  ['Abrir Painel', 'Open dashboard', 'Abrir panel'],
  ['Abrir Painel Vox', 'Open Vox dashboard', 'Abrir panel de Vox'],
  ['Conhecer Recursos', 'Explore features', 'Conocer recursos'],
  ['comunidade', 'community', 'comunidad'],
  ['guilda', 'guild', 'guild'],
  ['operação', 'operation', 'operación'],
  ['VOZ EM TEMPO REAL · FEITA PARA GUILDAS', 'REAL-TIME VOICE · BUILT FOR GUILDS', 'VOZ EN TIEMPO REAL · HECHA PARA GUILDS'],
  ['A call que', 'The call that', 'La llamada que'],
  ['acompanha o', 'keeps up with', 'acompaña el'],
  ['ritmo da hunt.', 'the hunt.', 'ritmo de la hunt.'],
  ['Canais rápidos, áudio limpo e conexão que não atrapalha a jogada. Entre pelo navegador e fale com o seu time em segundos.', 'Fast channels, clean audio, and a connection that never gets in the way. Join from your browser and talk to your team in seconds.', 'Canales rápidos, audio limpio y una conexión que no interrumpe la partida. Entra desde el navegador y habla con tu equipo en segundos.'],
  ['acesso rápido', 'quick access', 'acceso rápido'],
  ['Conectar', 'Connect', 'Conectar'],
  ['domínio, IP ou endereço do servidor', 'domain, IP, or server address', 'dominio, IP o dirección del servidor'],
  ['Endereço do servidor', 'Server address', 'Dirección del servidor'],
  ['Servidor Vox / ao vivo', 'Vox server / live', 'Servidor Vox / en vivo'],
  ['voz em baixa latência', 'low-latency voice', 'voz de baja latencia'],
  ['sem instalação', 'no installation', 'sin instalación'],
  ['abre no navegador', 'opens in the browser', 'se abre en el navegador'],
  ['voz em QUIC', 'QUIC voice', 'voz en QUIC'],
  ['menos fila no áudio', 'less audio queuing', 'menos cola en el audio'],
  ['seu servidor', 'your server', 'tu servidor'],
  ['canais sob seu controle', 'channels under your control', 'canales bajo tu control'],
  ['BAIXE E ESCOLHA SEU JEITO', 'DOWNLOAD AND CHOOSE YOUR WAY', 'DESCARGA Y ELIGE TU FORMA'],
  ['baixe e escolha seu jeito', 'download and choose your way', 'descarga y elige tu forma'],
  ['O Vox acompanha a sua rotina de jogo.', 'Vox fits your gaming routine.', 'Vox acompaña tu rutina de juego.'],
  ['disponível agora', 'available now', 'disponible ahora'],
  ['em preparação', 'in preparation', 'en preparación'],
  ['Navegador', 'Browser', 'Navegador'],
  ['Windows / Tauri', 'Windows / Tauri', 'Windows / Tauri'],
  ['Celular (PWA)', 'Phone (PWA)', 'Celular (PWA)'],
  ['Entre em segundos, sem instalar nada e com voz QUIC quando sua rede permitir.', 'Join in seconds, with no installation and QUIC voice when your network allows it.', 'Entra en segundos, sin instalar nada y con voz QUIC cuando tu red lo permita.'],
  ['Um cliente leve para deixar a call aberta ao lado da partida, com a mesma conta e os mesmos servidores.', 'A lightweight client to keep the call open beside your game, with the same account and servers.', 'Un cliente ligero para mantener la llamada junto a la partida, con la misma cuenta y servidores.'],
  ['Estamos preparando o pacote para publicação na Microsoft Store, com instalação centralizada pelo Windows.', 'We are preparing the Microsoft Store package, with installation managed by Windows.', 'Estamos preparando el paquete para la Microsoft Store, con instalación centralizada por Windows.'],
  ['disponível após aprovação', 'available after approval', 'disponible después de la aprobación'],
  ['Instale o Vox direto pelo navegador no Android ou iPhone e abra a call pela sua tela inicial.', 'Install Vox directly from the browser on Android or iPhone and open the call from your home screen.', 'Instala Vox directamente desde el navegador en Android o iPhone y abre la llamada desde tu pantalla de inicio.'],
  ['Instalar como aplicativo', 'Install as an app', 'Instalar como aplicación'],
  ['Instalar no celular', 'Install on phone', 'Instalar en el celular'],
  ['Chrome ou Edge · opção gratuita', 'Chrome or Edge · free option', 'Chrome o Edge · opción gratuita'],
  ['Android · iPhone pelo Safari · gratuito', 'Android · iPhone with Safari · free', 'Android · iPhone con Safari · gratis'],
  ['Baixar .EXE', 'Download .EXE', 'Descargar .EXE'],
  ['Baixar .MSI', 'Download .MSI', 'Descargar .MSI'],
  ['conferir SHA-256', 'check SHA-256', 'comprobar SHA-256'],
  ['todas as versões', 'all versions', 'todas las versiones'],
  ['por que o Vox', 'why Vox', 'por qué Vox'],
  ['comece em poucos passos', 'start in a few steps', 'empieza en pocos pasos'],
  ['monte do seu jeito', 'build it your way', 'móntalo a tu manera'],
  ['Tudo que a sua guilda precisa para jogar coordenada.', 'Everything your guild needs to play as one.', 'Todo lo que tu guild necesita para jugar coordinada.'],
  ['Áudio que acompanha', 'Audio that keeps up', 'Audio que acompaña'],
  ['WebTransport e QUIC priorizam a voz em tempo real, com medição de rota e fallback automático quando a rede não coopera.', 'WebTransport and QUIC prioritize real-time voice, with route measurement and automatic fallback when the network does not cooperate.', 'WebTransport y QUIC priorizan la voz en tiempo real, con medición de ruta y fallback automático cuando la red no coopera.'],
  ['Channels sem bagunça', 'Channels without the mess', 'Channels sin desorden'],
  ['Organize lobby, war, hunts, AFK e salas privadas em uma estrutura clara para o time encontrar tudo rápido.', 'Organize lobby, war, hunts, AFK, and private rooms in a clear structure so your team finds everything quickly.', 'Organiza lobby, war, hunts, AFK y salas privadas en una estructura clara para que el equipo encuentre todo rápido.'],
  ['Controle de verdade', 'Real control', 'Control de verdad'],
  ['Permissões, grupos, senha, bot, logs e painel administrativo para o servidor funcionar do seu jeito.', 'Permissions, groups, passwords, bots, logs, and an admin dashboard so the server works your way.', 'Permisos, grupos, contraseña, bot, registros y panel de administración para que el servidor funcione a tu manera.'],
  ['comece em poucos passos', 'start in a few steps', 'empieza en pocos pasos'],
  ['Do link para a call sem interromper a partida.', 'From link to call without interrupting the game.', 'Del enlace a la llamada sin interrumpir la partida.'],
  ['Abra o Vox', 'Open Vox', 'Abre Vox'],
  ['Acesse pelo navegador. Sem launcher pesado e sem configuração complicada.', 'Access it from your browser. No heavy launcher or complicated setup.', 'Accede desde el navegador. Sin launcher pesado ni configuración complicada.'],
  ['Escolha seu servidor', 'Choose your server', 'Elige tu servidor'],
  ['Entre pelo endereço direto ou selecione um dos servidores que você já salvou.', 'Join using the direct address or select one of the servers you have saved.', 'Entra con la dirección directa o selecciona uno de los servidores que ya guardaste.'],
  ['Fale com o time', 'Talk to your team', 'Habla con tu equipo'],
  ['Escolha o channel, ajuste seu microfone e coordene a próxima jogada.', 'Choose a channel, adjust your microphone, and coordinate the next play.', 'Elige el channel, ajusta tu micrófono y coordina la próxima jugada.'],
  ['monte do seu jeito', 'build it your way', 'móntalo a tu manera'],
  ['Um servidor. Você escolhe a capacidade e os extras.', 'One server. You choose the capacity and extras.', 'Un servidor. Tú eliges la capacidad y los extras.'],
  ['CONFIGURAÇÃO DO SEU VOX', 'YOUR VOX CONFIGURATION', 'CONFIGURACIÓN DE TU VOX'],
  ['Quanto espaço o seu time precisa?', 'How much space does your team need?', '¿Cuánto espacio necesita tu equipo?'],
  ['Mova o slider para escolher a capacidade. O preço é atualizado na hora.', 'Move the slider to choose capacity. The price updates instantly.', 'Mueve el control para elegir la capacidad. El precio se actualiza al instante.'],
  ['quantidade de slots', 'number of slots', 'cantidad de slots'],
  ['Quantidade de slots', 'Number of slots', 'Cantidad de slots'],
  ['Adicionar Rubinot', 'Add Rubinot', 'Añadir Rubinot'],
  ['Hunted List, UP Level e DeathList automáticos', 'Automatic Hunted List, UP Level, and DeathList', 'Hunted List, UP Level y DeathList automáticos'],
  ['Rubinot com Hunted List, UP Level e DeathList', 'Rubinot with Hunted List, UP Level, and DeathList', 'Rubinot con Hunted List, UP Level y DeathList'],
  ['Channels e permissões sob seu controle', 'Channels and permissions under your control', 'Channels y permisos bajo tu control'],
  ['Áudio QUIC com fallback WS', 'QUIC audio with WS fallback', 'Audio QUIC con fallback WS'],
  ['Painel administrativo incluído', 'Admin dashboard included', 'Panel de administración incluido'],
  ['O Rubinot começa a partir de 50 slots.', 'Rubinot starts at 50 slots.', 'Rubinot empieza a partir de 50 slots.'],
  ['SUA CONFIGURAÇÃO', 'YOUR CONFIGURATION', 'TU CONFIGURACIÓN'],
  ['gratuito', 'free', 'gratis'],
  ['por mês', 'per month', 'al mes'],
  ['Criar Meu Servidor Grátis', 'Create My Free Server', 'Crear mi servidor gratis'],
  ['Continuar com Essa Configuração', 'Continue with This Configuration', 'Continuar con esta configuración'],
  ['Pix ou cartão · servidor criado após a confirmação do pagamento.', 'Pix or card · server created after payment confirmation.', 'Pix o tarjeta · servidor creado tras confirmar el pago.'],
  ['Você pode trocar de plano depois pelo painel do cliente.', 'You can change plans later from the customer dashboard.', 'Puedes cambiar de plan después desde el panel del cliente.'],
  ['PRONTO PARA ENTRAR?', 'READY TO JOIN?', '¿LISTO PARA ENTRAR?'],
  ['Seu time já está esperando.', 'Your team is already waiting.', 'Tu equipo ya está esperando.'],
  ['Abra o Vox, escolha um channel e coloque a comunicação no lugar certo — dentro da partida, sem distração.', 'Open Vox, choose a channel, and keep communication where it belongs — in the game, without distractions.', 'Abre Vox, elige un channel y mantén la comunicación en su sitio — dentro de la partida, sin distracciones.'],
  ['voz para quem joga junto', 'voice for teams that play together', 'voz para quienes juegan juntos'],
  ['Política de privacidade', 'Privacy policy', 'Política de privacidad'],
  ['landing', 'home', 'inicio'],
  ['abrir Vox', 'open Vox', 'abrir Vox'],
  ['ou', 'or', 'o'],
  ['v0x · voz para quem joga junto', 'v0x · voice for teams that play together', 'v0x · voz para quienes juegan juntos'],
  ['área do cliente', 'customer area', 'área del cliente'],
  ['conta segura · suporte em breve', 'secure account · support coming soon', 'cuenta segura · soporte próximamente'],
  ['PASSO 01 · SUA CONTA', 'STEP 01 · YOUR ACCOUNT', 'PASO 01 · TU CUENTA'],
  ['PASSO 02 · CONFIGURAÇÃO', 'STEP 02 · CONFIGURATION', 'PASO 02 · CONFIGURACIÓN'],
  ['PASSO 03 · TUDO PRONTO', 'STEP 03 · ALL SET', 'PASO 03 · TODO LISTO'],
  ['conta', 'account', 'cuenta'],
  ['servidor', 'server', 'servidor'],
  ['pronto', 'ready', 'listo'],
  ['criar conta', 'create account', 'crear cuenta'],
  ['já tenho conta', 'I already have an account', 'ya tengo una cuenta'],
  ['criar conta e continuar', 'create account and continue', 'crear cuenta y continuar'],
  ['entrar e continuar', 'sign in and continue', 'entrar y continuar'],
  ['aguarde...', 'please wait...', 'espera…'],
  ['A conta não exige cartão. O plano gratuito cria o servidor imediatamente.', 'No card is required. The free plan creates the server immediately.', 'No se necesita tarjeta. El plan gratuito crea el servidor inmediatamente.'],
  ['Dê um nome para o seu servidor.', 'Name your server.', 'Dale un nombre a tu servidor.'],
  ['nome do servidor', 'server name', 'nombre del servidor'],
  ['endereço curto', 'short address', 'dirección corta'],
  ['senha do servidor (opcional)', 'server password (optional)', 'contraseña del servidor (opcional)'],
  ['deixe vazio para público', 'leave empty for public access', 'déjalo vacío para acceso público'],
  ['continuar para pagamento', 'continue to payment', 'continuar al pago'],
  ['criar servidor gratuito', 'create free server', 'crear servidor gratis'],
  ['Sem cartão, sem cobrança e com 10 slots para começar.', 'No card, no charge, and 10 slots to get started.', 'Sin tarjeta, sin cargos y con 10 slots para empezar.'],
  ['PLANO SELECIONADO', 'SELECTED PLAN', 'PLAN SELECCIONADO'],
  ['capacidade', 'capacity', 'capacidad'],
  ['painel', 'dashboard', 'panel'],
  ['incluído', 'included', 'incluido'],
  ['trocar plano', 'change plan', 'cambiar plan'],
  ['voltar para planos', 'back to plans', 'volver a los planes'],
  ['Seu servidor está no ar.', 'Your server is live.', 'Tu servidor está activo.'],
  ['Renovação confirmada.', 'Renewal confirmed.', 'Renovación confirmada.'],
  ['entrar no Vox', 'open Vox', 'entrar a Vox'],
  ['abrir painel Vox', 'open Vox dashboard', 'abrir panel de Vox'],
  ['Nenhuma fatura disponível', 'No invoices available', 'No hay facturas disponibles'],
  ['Histórico financeiro.', 'Financial history.', 'Historial financiero.'],
  ['aplicativo', 'app', 'aplicación'],
  ['Leve sua call para a partida.', 'Take your call into the game.', 'Lleva tu llamada a la partida.'],
  ['abrir versão web', 'open web version', 'abrir versión web'],
  ['baixar Windows', 'download Windows', 'descargar Windows'],
  ['Nenhum servidor encontrado', 'No servers found', 'No se encontraron servidores'],
  ['contratações', 'subscriptions', 'contrataciones'],
  ['faturas', 'invoices', 'facturas'],
  ['ÁREA DO CLIENTE', 'CUSTOMER AREA', 'ÁREA DEL CLIENTE'],
  ['COMECE PELO VOX', 'START WITH VOX', 'EMPIEZA CON VOX'],
  ['Seu time, seus servidores.', 'Your team, your servers.', 'Tu equipo, tus servidores.'],
  ['Crie sua conta e organize sua operação.', 'Create your account and organize your operation.', 'Crea tu cuenta y organiza tu operación.'],
  ['Acesse suas contratações, servidores e configurações em um único lugar.', 'Access your subscriptions, servers, and settings in one place.', 'Accede a tus contrataciones, servidores y configuraciones en un solo lugar.'],
  ['A conta é o ponto de partida para contratar servidores, acompanhar a assinatura e configurar o bot.', 'Your account is the starting point for ordering servers, managing subscriptions, and configuring the bot.', 'La cuenta es el punto de partida para contratar servidores, seguir la suscripción y configurar el bot.'],
  ['Servidores em um só lugar', 'Servers in one place', 'Servidores en un solo lugar'],
  ['Veja status, slots e acesso direto.', 'See status, slots, and direct access.', 'Consulta el estado, los slots y el acceso directo.'],
  ['Bot modular', 'Modular bot', 'Bot modular'],
  ['Rubinot agora; outros mundos depois.', 'Rubinot now; other worlds later.', 'Rubinot ahora; otros mundos después.'],
  ['Cobrança transparente', 'Transparent billing', 'Facturación transparente'],
  ['Assinatura e faturas no mesmo painel.', 'Subscriptions and invoices in the same dashboard.', 'Suscripciones y facturas en el mismo panel.'],
  ['entrar na minha conta', 'sign in to my account', 'entrar en mi cuenta'],
  ['continuar com Google · em breve', 'continue with Google · coming soon', 'continuar con Google · próximamente'],
  ['Login Google será habilitado na próxima etapa', 'Google login will be enabled in a future step', 'El inicio de sesión con Google estará disponible más adelante'],
  ['Senha com no mínimo 8 caracteres. Nunca compartilhamos seus dados.', 'Password must have at least 8 characters. We never share your data.', 'La contraseña debe tener al menos 8 caracteres. Nunca compartimos tus datos.'],
  ['PAINEL DO CLIENTE', 'CUSTOMER DASHBOARD', 'PANEL DEL CLIENTE'],
  ['Tudo sob controle.', 'Everything under control.', 'Todo bajo control.'],
  ['contratar outro servidor', 'order another server', 'contratar otro servidor'],
  ['Nenhum servidor vinculado ainda.', 'No linked servers yet.', 'Aún no hay servidores vinculados.'],
  ['Quando sua contratação estiver ativa, o servidor aparecerá aqui com acesso direto e configurações.', 'When your order is active, the server will appear here with direct access and settings.', 'Cuando tu contratación esté activa, el servidor aparecerá aquí con acceso directo y configuraciones.'],
  ['plano comunidade · sem cobrança', 'community plan · no charge', 'plan comunidad · sin cargos'],
  ['pago em', 'paid on', 'pagado el'],
  ['renovar', 'renew', 'renovar'],
  ['abrindo pagamento…', 'opening payment…', 'abriendo el pago…'],
  ['configurar', 'configure', 'configurar'],
  ['Contratações independentes', 'Independent subscriptions', 'Contrataciones independientes'],
  ['Sua conta pode ter vários servidores. Cada nova contratação mantém seus slots, channels e bot separados.', 'Your account can have multiple servers. Each subscription keeps its slots, channels, and bot separate.', 'Tu cuenta puede tener varios servidores. Cada contratación mantiene sus slots, channels y bot separados.'],
  ['contratar outro', 'order another', 'contratar otro'],
  ['A configuração detalhada continua disponível no painel administrativo de cada servidor.', 'Detailed configuration remains available in each server’s admin dashboard.', 'La configuración detallada sigue disponible en el panel de administración de cada servidor.'],
  ['O cliente web já está disponível. A versão desktop em Tauri já pode ser instalada no Windows.', 'The web client is available now. The Tauri desktop version can be installed on Windows.', 'El cliente web ya está disponible. La versión de escritorio en Tauri se puede instalar en Windows.'],
  ['Nenhuma fatura disponível', 'No invoices available', 'No hay facturas disponibles'],
  ['As faturas aparecerão aqui quando houver uma contratação.', 'Invoices will appear here when you place an order.', 'Las facturas aparecerán aquí cuando haya una contratación.'],
  ['Renovação', 'Renewal', 'Renovación'],
  ['Contratação', 'Subscription', 'Contratación'],
  ['criado em', 'created on', 'creado el'],
  ['válido até', 'valid until', 'válido hasta'],
  ['conta segura · suporte em breve', 'secure account · support coming soon', 'cuenta segura · soporte próximamente'],
  ['PASSO 01 · SUA CONTA', 'STEP 01 · YOUR ACCOUNT', 'PASO 01 · TU CUENTA'],
  ['Comece pelo seu acesso.', 'Start with your account.', 'Empieza con tu acceso.'],
  ['Bem-vindo de volta.', 'Welcome back.', 'Bienvenido de nuevo.'],
  ['Crie sua conta e o Vox já deixa o plano escolhido separado para você.', 'Create your account and Vox will reserve your selected plan for you.', 'Crea tu cuenta y Vox reservará el plan elegido para ti.'],
  ['Entre para continuar com o plano selecionado.', 'Sign in to continue with the selected plan.', 'Inicia sesión para continuar con el plan seleccionado.'],
  ['PASSO 02 · CONFIGURAÇÃO', 'STEP 02 · CONFIGURATION', 'PASO 02 · CONFIGURACIÓN'],
  ['Dê um nome para o seu servidor.', 'Name your server.', 'Dale un nombre a tu servidor.'],
  ['Você poderá ajustar channels, grupos e o bot depois.', 'You can adjust channels, groups, and the bot later.', 'Podrás ajustar channels, grupos y el bot después.'],
  ['O servidor só será criado depois da confirmação do pagamento no Mercado Pago.', 'The server will be created after payment is confirmed by Mercado Pago.', 'El servidor se creará después de que Mercado Pago confirme el pago.'],
  ['PASSO 03 · PAGAMENTO', 'STEP 03 · PAYMENT', 'PASO 03 · PAGO'],
  ['O pagamento não foi concluído.', 'Payment was not completed.', 'El pago no se completó.'],
  ['Nenhum servidor foi criado. Você pode voltar aos planos e tentar novamente.', 'No server was created. You can return to the plans and try again.', 'No se creó ningún servidor. Puedes volver a los planes e intentarlo de nuevo.'],
  ['Pagamento confirmado.', 'Payment confirmed.', 'Pago confirmado.'],
  ['Aguardando confirmação.', 'Waiting for confirmation.', 'Esperando confirmación.'],
  ['verificando o status do pagamento…', 'checking payment status…', 'comprobando el estado del pago…'],
  ['Você pode fechar esta página; o pedido fica salvo na sua conta.', 'You can close this page; the order is saved to your account.', 'Puedes cerrar esta página; el pedido queda guardado en tu cuenta.'],
  ['PASSO 03 · TUDO PRONTO', 'STEP 03 · ALL SET', 'PASO 03 · TODO LISTO'],
  ['Seu servidor está no ar.', 'Your server is live.', 'Tu servidor está activo.'],
  ['SERVIDOR RENOVADO', 'RENEWED SERVER', 'SERVIDOR RENOVADO'],
  ['ENDEREÇO DO SERVIDOR', 'SERVER ADDRESS', 'DIRECCIÓN DEL SERVIDOR'],
  ['Faça login no painel com', 'Sign in to the dashboard with', 'Inicia sesión en el panel con'],
  ['contratação segura por etapas', 'secure step-by-step ordering', 'contratación segura por etapas'],
  ['pagamento protegido pelo Mercado Pago', 'payment protected by Mercado Pago', 'pago protegido por Mercado Pago'],
];

const DICTIONARY: Record<Locale, Record<string, string>> = {
  'pt-BR': {},
  en: {},
  es: {},
};

for (const [source, english, spanish] of TRANSLATIONS) {
  DICTIONARY.en[source] = english;
  DICTIONARY.es[source] = spanish;
}

export function getLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(LOCALE_KEY);
    return stored === 'en' || stored === 'es' || stored === 'pt-BR' ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function setLocale(locale: Locale): void {
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(LOCALE_KEY, locale); } catch { /* storage unavailable */ }
  }
  applyDocumentLocale(locale);
}

export function applyDocumentLocale(locale = getLocale()): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  const title = PAGE_TITLES[locale][location.pathname];
  if (title) document.title = title;
}

export function t(source: string): string {
  return DICTIONARY[getLocale()][source] ?? source;
}

function translatedText(source: string): string {
  const locale = getLocale();
  if (locale === DEFAULT_LOCALE) return source;
  const exact = DICTIONARY[locale][source.trim()];
  if (exact) return source.replace(source.trim(), exact);

  let match = /^(\d+) online$/.exec(source);
  if (match) return locale === 'en' ? `${match[1]} online` : `${match[1]} en línea`;
  match = /^(\d+) conectados$/.exec(source);
  if (match) return locale === 'en' ? `${match[1]} connected` : `${match[1]} conectados`;
  match = /^(\d+) canais e (\d+) usuário\(s\) carregados$/.exec(source);
  if (match) return locale === 'en'
    ? `${match[1]} channels and ${match[2]} user(s) loaded`
    : `${match[1]} canales y ${match[2]} usuario(s) cargados`;
  match = /^recebendo (\d+) canais e usuários…$/.exec(source);
  if (match) return locale === 'en' ? `receiving ${match[1]} channels and users…` : `recibiendo ${match[1]} canales y usuarios…`;
  match = /^(\d+) usuário\(s\)$/.exec(source);
  if (match) return locale === 'en' ? `${match[1]} user(s)` : `${match[1]} usuario(s)`;
  match = /^(\d+) usuários$/.exec(source);
  if (match) return locale === 'en' ? `${match[1]} users` : `${match[1]} usuarios`;
  match = /^(\d+) slots$/.exec(source);
  if (match) return `${match[1]} slots`;
  match = /^(\d+) slots para o seu time$/.exec(source);
  if (match) return locale === 'en' ? `${match[1]} slots for your team` : `${match[1]} slots para tu equipo`;
  match = /^(.+) · (\d+) slots( · Rubinot)?$/.exec(source);
  if (match) {
    const tierSource = match[1] ?? '';
    const tier = DICTIONARY[locale][tierSource] ?? tierSource;
    return `${tier} · ${match[2]} slots${match[3] ? ' · Rubinot' : ''}`;
  }
  match = /^mensagem para (.+)…$/.exec(source);
  if (match) return locale === 'en' ? `message to ${match[1]}…` : `mensaje para ${match[1]}…`;
  match = /^testar: (.+)$/.exec(source);
  if (match) {
    const label = DICTIONARY[locale][match[1] ?? ''] ?? match[1] ?? '';
    return locale === 'en' ? `test: ${label}` : `probar: ${label}`;
  }
  match = /^testar (.+)$/.exec(source);
  if (match) {
    const label = DICTIONARY[locale][match[1] ?? ''] ?? match[1] ?? '';
    return locale === 'en' ? `test ${label}` : `probar ${label}`;
  }
  return source;
}

function preserveWhitespace(source: string, translated: string): string {
  const leading = source.match(/^\s*/)?.[0] ?? '';
  const trailing = source.match(/\s*$/)?.[0] ?? '';
  return `${leading}${translated.trim()}${trailing}`;
}

/** Traduz textos e atributos estáticos de uma árvore recém-renderizada. */
export function translateTree(root: ParentNode): void {
  applyDocumentLocale();
  if (getLocale() === DEFAULT_LOCALE) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest(DYNAMIC_CONTENT_SELECTOR)) continue;
    const source = node.nodeValue ?? '';
    const translated = translatedText(source);
    if (translated !== source) node.nodeValue = preserveWhitespace(source, translated);
  }

  if (root instanceof Element) translateAttributes(root);
  for (const element of root.querySelectorAll<HTMLElement>('*')) translateAttributes(element);
}

function translateAttributes(element: Element): void {
  if (element.matches(DYNAMIC_CONTENT_SELECTOR) || element.closest(DYNAMIC_CONTENT_SELECTOR)) return;
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    const translated = translatedText(value);
    if (translated !== value) element.setAttribute(attribute, preserveWhitespace(value, translated));
  }
}

export function createLocaleSelect(onChange?: (locale: Locale) => void): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'locale-select';
  select.setAttribute('aria-label', t('Idioma'));
  for (const option of LOCALE_OPTIONS) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    item.selected = option.value === getLocale();
    select.append(item);
  }
  select.addEventListener('change', () => {
    const locale = select.value as Locale;
    if (locale !== 'pt-BR' && locale !== 'en' && locale !== 'es') return;
    setLocale(locale);
    onChange?.(locale);
  });
  return select;
}

applyDocumentLocale();
