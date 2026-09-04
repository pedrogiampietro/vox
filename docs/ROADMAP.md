# Roadmap Vox

Vox começou como voz em canais no estilo TeamSpeak, mas a base já suporta uma
ambição maior: uma plataforma leve para comunidades em tempo real, com voz de
baixa latência, administração própria, identidade portátil e clientes web,
desktop e futuramente mobile.

## Norte do produto

- Continuar leve: servidor roteia áudio sem decodificar, cliente faz o trabalho
  pesado, e tudo deve continuar fácil de hospedar.
- Ser confiável para comunidades pequenas e médias antes de tentar virar rede
  social gigante.
- Ter administração séria: permissões claras, auditoria, bans, grupos e painel.
- Fazer voz parecer sólida mesmo em rede ruim: QUIC quando possível, fallback
  sem drama, métricas visíveis e buffer melhor.
- Ser agradável de usar todos os dias: favoritos, atalhos, notificações, boas
  configurações de áudio e poucos cliques para tarefas comuns.

## Estado atual

Já existe:

- Protocolo binário compartilhado entre cliente e servidor.
- Voz Opus via WebCodecs, com WebTransport oportunista e fallback WebSocket.
- Canais, chat, DMs, pokes, favoritos, notificações e preferências de áudio.
- Identidade por chave pública, challenge/response, grupos, bans e moderação.
- Múltiplos servidores virtuais por processo.
- API admin com login, overview, ações de moderação e stream SSE.
- Wrapper desktop Tauri usando a mesma base web.
- Bot multi-provider com Rubinot e DeusOT, usando o mesmo contrato normalizado.

Principais lacunas:

- A interface admin existe em `packages/panel`, mas ainda é inicial.
- `packages/web/src/main.ts` concentra UI demais e já dificulta evolução.
- A UX de identidade já expõe fingerprint e backup/importação, mas dono/admin e
  permissões ainda precisam ficar mais claros.
- Métricas de rede/voz aparecem parcialmente no cliente, mas ainda faltam
  jitter, perda percebida e visão histórica.
- O buffer de jitter é simples e PLC ainda não existe.
- Desktop ainda não tem recursos nativos importantes, como push-to-talk global.

## Sequência recomendada

1. Atualizar documentação e visão do produto.
2. Modularizar o cliente web sem mudar comportamento.
3. Evoluir `packages/panel` até cobrir a administração do dia a dia.
4. Melhorar UX de identidade, backup/importação e permissões.
5. Expor métricas de qualidade de rede e voz.
6. Evoluir áudio: jitter adaptativo e tratamento de perda.
7. Fortalecer desktop: PTT global, tray, auto-start e atualização.
8. Abrir caminho para bots, webhooks e integrações.

## Backlog por área

### Cliente

- Separar UI em módulos: browser de servidores, shell, canais, chat, settings,
  menus, overlays e componentes pequenos.
- Criar estado de conexão mais legível: offline, conectando, online,
  reconectando, recusado por senha, versão incompatível.
- Melhorar onboarding: escolher nick, servidor, senha e explicar identidade.
- Tela de identidade: fingerprint completo, exportar/importar, regenerar e aviso
  claro de perda de posse/grupos. Feito inicialmente.
- Mostrar transporte de voz atual, RTT, descartes e estado do microfone. Parcial.
- Refinar DMs: abas persistentes, unread por conversa, fechar/reabrir com
  histórico local da sessão.
- Tornar permissões visíveis nos menus em vez de apenas esconder ações.

### Servidor

- Adicionar auditoria em memória/persistida para ações administrativas.
- Definir modelo granular de permissões por servidor/canal.
- Melhorar banimento: expiração, motivo, autor, prefix lookup e talvez hash de
  IP opcional.
- Endpoints admin para editar grupos visuais e canais sem depender do cliente.
- Export/import de configuração de servidor virtual.
- Métricas agregadas de transporte, conexões, quedas e rate limit.

### Painel Admin

- Ampliar `packages/panel` com telas dedicadas por domínio.
- Login por senha admin usando `/api/login`. Feito.
- Dashboard com servidores virtuais, usuários, canais, bans e saúde. Parcial.
- CRUD de servidores virtuais. Parcial.
- Moderação ao vivo: kick, ban, mover usuário, anunciar, alterar grupo. Feito.
- Gerenciamento de grupos: nome, cor e ícone.
- Criação/edição de canais permanentes pelo painel.
- Auditoria de ações administrativas.
- Stream SSE para atualizar overview sem polling pesado.

### Áudio

- Medir jitter real por remetente.
- Tornar o jitter buffer adaptativo.
- Investigar libopus WASM para PLC nos casos em que WebCodecs não expõe perda.
- Normalização/limiter por usuário.
- Diagnóstico de captura: dispositivo, nível, clipping e threshold.
- Futuro: posicionamento estéreo e perfis de voz por canal.

### Desktop

- Push-to-talk global.
- Tray icon com mute/deafen/conectar/desconectar.
- Auto-start opcional.
- Notificações nativas reais com permissões claras.
- Atualizador automático.
- Empacotamento e assinatura.

### Bots e Integrações

- Finalizar o hardening dos providers Rubinot/DeusOT e adicionar novos OTs sem
  espalhar regras específicas pelo bot.
- API de eventos: usuário entrou/saiu, mensagem, poke, channel move, moderação.
- Registro de comandos com permissões.
- Webhooks de entrada e saída.
- Bot bridge para comunidades externas.
- Soundboard/música com permissões por canal.
