# Plano de mídia do v0x

O Vox mantém o Node como plano de controle: identidade, login, permissões,
canais, bots e painel continuam no `vox.service`. O tráfego quente pode ser
encaminhado pelo `vox-voice-router`, e o terminador público QUIC fica no
`vox-voice-quic` quando o gateway estiver ativado.

## Fluxo

```text
cliente -- WebSocket controle ---------------------> Node
cliente -- WebTransport QUIC --> gateway Rust ------> Node (auth/frame)
                                      |                |
                                      +-- UDP --------> roteador Rust
                                                         |
                                      entregas agrupadas -+
```

O Node valida o token e continua decidindo quem pode falar em qual canal. O
gateway QUIC só termina TLS/HTTP3, autentica o token através do Node e repassa
datagramas. O roteador Rust mantém a lista de participantes por servidor/canal,
calcula o fan-out em workers e devolve uma entrega contendo o frame uma vez e
os destinatários. O Node ainda escreve nos sockets WebSocket e no gateway; isso
permite ativação gradual, rollback imediato e mantém o fallback existente.

Cada canal é fixado em um worker pelo hash de `servidor + canal`. As filas são
limitadas; quando ficam cheias, o áudio antigo é descartado para preservar a
latência. O roteador também descarta frames atrasados, ignora payloads de
silêncio explícito e evita eco entre clientes atendidos pelo mesmo edge.

## Instalação em produção

O CI publica o binário Linux em `/usr/local/bin/vox-voice-router`. A unidade
`docs/vox-voice.service` usa somente `127.0.0.1`, portanto não abre uma nova
porta pública. O Node detecta o serviço pelo sinal de prontidão. Se o processo
estiver ausente, cair ou não responder, a voz continua pelo caminho atual.

```bash
install -m 755 vox-voice-router /usr/local/bin/vox-voice-router
install -m 644 docs/vox-voice.service /etc/systemd/system/vox-voice.service
systemctl daemon-reload
systemctl enable --now vox-voice.service
systemctl restart vox.service
```

Para escolher a quantidade de workers, crie `/etc/vox-voice-router.env`:

```ini
VOX_VOICE_ROUTER_LISTEN=127.0.0.1:19876
VOX_VOICE_ROUTER_TARGET=127.0.0.1:19877
VOX_VOICE_ROUTER_WORKERS=4
```

Use aproximadamente o número de núcleos disponíveis, reservando pelo menos
um núcleo para o Node e o sistema. O worker não deve ser exposto à internet.

## Ativação gradual

1. Instale o serviço com `VOX_VOICE_ROUTER_ENABLED=1` e mantenha o
   `VOX_VOICE_ROUTER_MANAGED_EXTERNALLY=1`.
2. Confirme no log do `vox.service` a mensagem `roteador Rust pronto`.
3. Execute smoke test e cargas de 50, 100, 150, 300 e 500 usuários.
4. Compare event loop, fan-out, descartes e RTT com a linha de base.
5. Se o worker não ficar pronto, remova-o ou desligue a variável: o Node volta
   automaticamente ao encaminhamento anterior.

## Gateway QUIC separado

O gateway é deliberadamente desligado por padrão porque exige uma porta UDP
pública e o mesmo certificado usado pelo hostname anunciado. O Node local pode
continuar ativo como candidato de fallback enquanto o gateway é validado.

Crie `/etc/vox-voice-quic.env` na VPS:

```ini
VOX_VOICE_QUIC_BIND=0.0.0.0:11000
VOX_VOICE_QUIC_CERT=/caminho/para/hostname.crt
VOX_VOICE_QUIC_KEY=/caminho/para/hostname.key
VOX_VOICE_QUIC_CONTROL=127.0.0.1:19878
VOX_VOICE_QUIC_NODE=127.0.0.1:19877
```

No ambiente do `vox.service`, habilite o mesmo candidato para o Welcome:

```ini
VOX_VOICE_QUIC_GATEWAY_ENABLED=1
VOX_VOICE_QUIC_GATEWAY_HOST=manowar.v0x.online
VOX_VOICE_QUIC_GATEWAY_PORT=11000
VOX_VOICE_QUIC_GATEWAY_REGION=Origem Rust
VOX_VOICE_QUIC_GATEWAY_CONTROL=127.0.0.1:19878
```

Depois do próximo deploy, a unidade `vox-voice-quic.service` será iniciada
automaticamente se o arquivo existir. Mantenha a porta UDP liberada e execute
smoke/cargas comparando RTT, perdas e handshakes. Se o gateway não responder,
o cliente tenta outro edge ou volta sozinho ao WebSocket.

O gateway Rust usa a biblioteca `wtransport` para WebTransport. Por isso ele
deve ser ativado primeiro em uma VPS de teste e só depois virar o candidato
principal de todos os servidores.
