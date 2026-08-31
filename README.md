# Vox

Voz em canais, no estilo do TeamSpeak 3: web, desktop e — depois — celular,
com servidor e protocolo próprios.

O objetivo é ser tão leve quanto o original. Hoje o cliente web inteiro
(protocolo + engine de áudio + interface) sai em **~23 kB de JS, 8 kB gzipado**,
e o servidor é **um arquivo de 150 kB** rodando em Node sem dependência nativa.

## A ideia em uma frase

**O servidor nunca decodifica áudio.** Ele recebe um pacote Opus, escreve dois
bytes com o id de quem falou e reencaminha o mesmo buffer para o resto do canal.
Isso é o que faz um servidor TS3 aguentar centenas de pessoas em poucas dezenas
de MB — todo o custo de DSP fica no cliente, onde sobra hardware.

```
navegador                       servidor                      navegador
---------                       --------                      ---------
mic -> AudioWorklet
    -> AudioEncoder (Opus)
    -> [voz|id|seq|flags|opus] ---> valida tamanho
                                    carimba o id (2 bytes)
                                    for (peer of canal) send  ---> jitter buffer
                                                                -> AudioDecoder
                                                                -> AudioWorklet -> alto-falante
```

Nada de WebRTC: sem ICE, sem DTLS, sem SRTP, sem SFU. O Opus vem do próprio
navegador via **WebCodecs**, então não baixamos um byte de codec, e o cancelamento
de eco, a supressão de ruído e o AGC vêm de graça das constraints do
`getUserMedia` — são os mesmos módulos que o WebRTC usa.

## Estrutura

| pacote | o que é |
| --- | --- |
| `packages/protocol` | protocolo binário, fonte única compartilhada por cliente e servidor |
| `packages/server` | servidor: canais, clientes, chat e roteamento de voz |
| `packages/web` | cliente web (também é o frontend do desktop e do mobile) |
| `packages/desktop` | casca Tauri v2 — mesma base gera Android e iOS |

## Rodando

```bash
npm install
```

Dois terminais:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

Abra <http://localhost:5173>. O Vite repassa `/vox` para o servidor, então o
cliente fala com a mesma origem — igual ao que acontece em produção.

Teste do caminho de voz sem precisar de microfone (dois clientes reais,
verifica carimbo do remetente, isolamento entre canais e chat):

```bash
npm run smoke
```

Produção local:

```bash
npm run build && npm start
```

O `npm start` sobe um processo só: ele serve o cliente web buildado e aceita
WebSocket na mesma porta.

## Colocando no ar

O cliente web **exige HTTPS fora do localhost**. Isso não é preferência de
estilo: o navegador só expõe `navigator.mediaDevices` em contexto seguro, e sem
ele não há captura de microfone — nem uma mensagem de erro decente explicando
por quê. `http://localhost` é a única exceção, e existe para desenvolvimento.

### Com domínio próprio (recomendado)

Aponte um registro A/AAAA para a máquina, copie `.env.example` para `.env`,
preencha `VOX_DOMAIN`, e deixe as portas 80 e 443 livres:

```bash
docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d --build
```

O Caddy pede o certificado ao Let's Encrypt, renova sozinho e encaminha o
upgrade de WebSocket de forma transparente. O servidor fica sem porta exposta,
só o proxy fala com ele. O override já liga `VOX_TRUST_PROXY` — sem isso o IP
de todo mundo vira o do proxy e o teto por IP derruba o servidor inteiro no
primeiro punhado de usuários.

### Com certificado próprio, sem proxy

O servidor fala TLS direto, útil quando o certificado já vem de outro lugar:

```bash
VOX_TLS_CERT=/caminho/cert.pem VOX_TLS_KEY=/caminho/key.pem npm start
```

### Sem TLS

Continua válido para LAN, para desenvolvimento e para o app desktop, que não
depende de contexto seguro por servir de uma origem confiável. O servidor avisa
no boot quando sobe assim.

```bash
docker compose up -d --build
```

### Quedas

O cliente reconecta sozinho com backoff exponencial (1s, 2s, 4s… até 15s, com
jitter para a turma não voltar toda no mesmo instante). Durante a queda a árvore
de canais continua na tela e o motivo aparece no cabeçalho; o áudio é liberado e
volta quando o novo snapshot chega. Se a **primeira** conexão nunca completa, ele
desiste em três tentativas — endereço errado não melhora com insistência.

### Desktop

Precisa do toolchain Rust (<https://rustup.rs>) — é o que mantém o instalador na
casa dos 10 MB em vez dos 180 MB de um Electron.

```bash
npm run dev:desktop
```

Antes do primeiro `tauri build`, gere os ícones a partir de um PNG 1024×1024:

```bash
npm run icons --workspace=@vox/desktop -- caminho/para/icone.png
```

Celular, quando chegar a hora: `npm run android:init --workspace=@vox/desktop`.
O cliente web já é responsivo e não usa nada que falte no WebView do Android.

## Configuração do servidor

Tudo por variável de ambiente:

| variável | padrão | |
| --- | --- | --- |
| `VOX_HOST` | `0.0.0.0` | |
| `VOX_PORT` | `9987` | mesma porta do TS3, por carinho |
| `VOX_NAME` | `Servidor Vox` | |
| `VOX_MOTD` | `Bem-vindo.` | |
| `VOX_PASSWORD` | vazio | vazio = servidor aberto |
| `VOX_MAX_CLIENTS` | `128` | |
| `VOX_MAX_PER_IP` | `8` | conexões simultâneas por IP; `0` desliga |
| `VOX_TIMEOUT_MS` | `30000` | sem ping por esse tempo, cai |
| `VOX_VOICE_RATE` | `120` | pacotes de voz por segundo, por conexão |
| `VOX_CONTROL_RATE` | `40` | mensagens de controle por segundo |
| `VOX_DATA_DIR` | `data` | onde os canais permanentes são gravados |
| `VOX_TLS_CERT` | vazio | TLS direto no Node; vazio = HTTP puro |
| `VOX_TLS_KEY` | vazio | par do anterior |
| `VOX_TRUST_PROXY` | `false` | ligue **só** atrás de proxy reverso |

Canais permanentes vivem em `data/channels.json`. Canais criados por usuários são
temporários e somem quando esvaziam, como no TS3.

## O protocolo

Todo frame começa com um byte que diz o tipo. Números são little-endian (x86 e
ARM são LE, então não se paga byteswap em nada). Strings são UTF-8 com prefixo
`u16`.

### Voz — 6 bytes de cabeçalho

```
0   u8   0x00
1   u16  clientId   (o cliente manda 0; o servidor carimba)
3   u16  seq        (com wrap)
5   u8   flags      (bit 0 = fim de fala)
6   ...  payload Opus
```

A ida e a volta têm o mesmo formato de propósito: é isso que permite o servidor
reencaminhar sem copiar nem realocar por destinatário.

### Controle

```
0   u8   0x01
1   u8   opcode
2   ...  campos do opcode
```

Os opcodes e o formato de cada mensagem estão em
[`packages/protocol/src/control.ts`](packages/protocol/src/control.ts) como uma
união discriminada — servidor e cliente importam o mesmo arquivo, então mudar um
campo quebra a compilação dos dois lados de uma vez, que é exatamente o que se
quer de um protocolo binário.

## O que já funciona

- Handshake com versão, senha e apelido único
- Árvore de canais, entrar/criar/editar/remover, canais temporários e permanentes
- Chat de canal, de servidor e privado
- Mudo de microfone e de som, com estado replicado para todos
- Voz Opus 48 kHz mono, ativação por voz (com hangover) ou push-to-talk
- Indicador de quem está falando, medidor de entrada, volume de saída
- Limite de taxa por conexão, teto por IP e limpeza de conexões mortas
- TLS direto ou atrás de proxy, com HTTPS automático via Caddy no compose
- Reconexão automática com backoff, sem perder a tela de vista

## O que vem a seguir

Em ordem de impacto:

1. **WebTransport.** Hoje a voz anda em WebSocket, que é TCP: uma perda trava a
   fila e a voz engasga. Datagramas sobre QUIC resolvem isso. A interface
   `PeerSocket` no servidor e a classe `Connection` no cliente já isolam o
   transporte — é trocar os dois, não reescrever o resto. O buffer de jitter em
   `mixer.ts` já reordena pacotes, mesmo sendo inútil em TCP.
2. **PLC de verdade.** Quando um pacote se perde hoje entra silêncio. O Opus tem
   ocultação de perda embutida, mas o `AudioDecoder` do WebCodecs não expõe a
   chamada — vai precisar de um decodificador libopus em WASM só para esse caso,
   ou esperar a API crescer.
3. **Identidade e permissões.** Hoje qualquer um cria e apaga canal. O caminho
   natural é o do TS3: par de chaves gerado no cliente, servidor guarda a
   pública, e grupos de servidor/canal por cima disso.
4. **Volume por usuário e mudo local.** O mixer já tem um `GainNode` por
   remetente; falta a interface.
5. **Acabamento de cliente.** Sons de entrada e saída, atalho global de
   push-to-talk no desktop (o navegador só enxerga tecla com a janela em foco) e
   lista de servidores favoritos.
