# Escala da voz

## O que o teste mostrou

O teste foi feito no ambiente de produção e mediu a sessão completa, não um
servidor local:

- 20 clientes e 4 pessoas falando: todos conectaram, mas o RTT p95 chegou a
  483 ms e o event loop p95 a aproximadamente 164 ms;
- 50 clientes e 8 pessoas falando: todos conectaram, porém o RTT p95 ficou em
  344 ms, o p99 em 1.203 ms e o event loop p95 em aproximadamente 193 ms;
- o processo Node chegou a cerca de 64% de um núcleo, enquanto a máquina ficou
  em cerca de 16% de CPU, sem quedas reportadas no resumo do teste.

Isso aponta para o encaminhamento de voz e as escritas individuais nos
transportes como gargalo. Memória, rede total e CPU da máquina ainda não são o
limite. Portanto, aumentar a VPS ou trocar Node por Go agora não resolve a
causa principal sozinho.

## Melhorias em ordem de impacto

### 0. Observabilidade e seleção de rota

O painel master agora guarda uma janela de 60 amostras e mostra CPU, event
loop, fan-out, descartes, fila de saída, conexões de controle/voz e o estado
de cada edge. Cada listener WebTransport registra tentativas, sucesso, falha,
p50 e p95 do handshake; o relay também informa upstreams, sessões e tráfego
por região.

No cliente, os candidatos QUIC continuam sendo sondados em paralelo, mas a
rota passa a lembrar o tempo de handshake e os erros consecutivos. Um edge que
falha duas vezes entra em quarentena por 30 segundos. Se a rota ativa cair, o
cliente volta imediatamente ao WebSocket e tenta outro candidato com backoff,
sem deixar a interface sem áudio.

O teste de matriz foi ajustado para cenários de 50, 100 e 150 clientes, com
8, 16 e 24 falantes em 2, 4 e 8 canais. O perfil `continuous` mantém todos os
falantes transmitindo; `realistic` intercala ciclos de fala e silêncio, além de
variar tamanho e intervalo dos pacotes. Ele pode comparar `ws` (voz no
controle), `ws-dedicated` (socket exclusivo de voz), `quic` ou `auto`. O
relatório registra a divisão entre os transportes e o event loop p95. Para
medir regiões de verdade, cada rodada ainda deve ser disparada a partir de
origens geográficas diferentes; um único runner não representa vários IPs.

Quando houver dois edges configurados, o workflow aceita `voice_edges` como
uma lista de seletores separados por vírgula, por exemplo `voice-sp,manowar`.
Os shards são distribuídos em round-robin e cada relatório registra o host
QUIC que realmente recebeu as conexões. Com `auto`, o cliente volta a medir os
candidatos anunciados normalmente; com um seletor, a rodada confirma a
capacidade de cada VPS isoladamente.

### 1. Medir e reduzir o trabalho do caminho quente

O servidor agora registra o fan-out no painel: quantos pacotes entraram e
quantas entregas foram geradas. A contabilidade é feita uma vez por pacote,
depois do filtro de canal, em vez de repetir o custo de métricas em cada
destinatário.

Antes de cada mudança de arquitetura, repetir o mesmo cenário e comparar:

- event loop p95;
- RTT p95 e p99 por região;
- pacotes descartados;
- fan-out médio por pacote;
- CPU do processo, CPU da máquina e banda de saída.

O cliente já possui VAD com hangover para não transmitir silêncio, Opus mono
com FEC e bitrate ajustável. O bitrate agora desce automaticamente em uma
janela instável e volta ao valor escolhido quando a qualidade se recupera;
isso reduz fila e perda sem alterar permanentemente a preferência do usuário.

### 2. Transformar cada edge regional em um relay multiplexado

Esta etapa foi implementada no servidor e no edge. O edge já distribuía voz
localmente, mas mantinha um link privado separado para cada navegador. Agora
ele mantém um único link por edge e servidor, com registro de sessões e
roteamento por `clientId`:

```text
clientes da região -> edge regional -> um upstream -> origem
                                      <- um downstream <- origem
```

Assim, a origem envia um frame uma vez para cada região remota, e o edge faz o
fan-out local. Isso remove o crescimento de escritas da origem proporcional ao
número de usuários de uma mesma região.

### 3. Separar o plano de voz do plano de controle

Esta etapa já está ativa: o cliente e o servidor separam a voz em um
WebSocket próprio quando o QUIC não está disponível, e o Hub Node publica os
frames uma vez para o roteador Rust. O roteador mantém workers por servidor e
canal, calcula o fan-out fora do event loop e preserva uma fila prioritária
para controle.

O próximo ganho não é reescrever autenticação em outra linguagem. É medir a
capacidade do roteador em produção, ajustar o número de workers por CPU e só
então ativar o gateway QUIC Rust público onde houver certificado, UDP e um
edge regional independente.

### 4. Só então avaliar outra linguagem

Node continua adequado para o controle e para o relay inicial. Go ou Rust
passam a fazer sentido se, após o upstream compartilhado e a separação dos
workers, o perfil ainda mostrar o relay como limite. Reescrever antes disso
apenas troca a linguagem e mantém o mesmo fan-out.

## Critério para liberar capacidade

Não usar apenas “todos conectaram” como critério. Para cada região, liberar o
próximo nível somente se o teste de 60 segundos atingir:

- 0 quedas inesperadas;
- 0 descartes sustentados de voz;
- event loop p95 abaixo de 100 ms, idealmente abaixo de 50 ms;
- RTT p95 abaixo de 250 ms para usuários próximos do edge;
- memória estável e CPU do processo sem ficar colada em um núcleo.

Os testes precisam ser executados a partir de mais de uma origem geográfica.
Um teste iniciado na própria VPS mede bem o custo de processamento, mas não
representa a latência de um jogador no Brasil, Europa ou América do Norte.
