# Runbook de produção

Este documento descreve como instalar, migrar e validar o Vox em uma VPS.
Ele cobre o cenário usado atualmente: Node servido por `systemd`, Caddy na
frente para HTTPS/WebSocket e WebTransport/QUIC direto em um intervalo de
portas UDP reservado para os hostnames dos servidores virtuais.

## Visão da rede

```text
cliente web
  ├── HTTPS/WSS :443 ───────► Caddy ───────► Node/Vox 127.0.0.1:9987/tcp
  └── WebTransport/QUIC :9987..10086/udp ► Node/Vox 0.0.0.0:9987..10086/udp
```

O Caddy não encaminha o WebTransport para o Node. Por isso o intervalo UDP
`9987..10086` deve chegar diretamente ao processo Vox. O primeiro hostname usa
`9987`; os próximos ganham portas seguintes automaticamente. Se a UDP estiver
bloqueada, o cliente segue funcionando por WebSocket, mas a voz fica sujeita ao
comportamento do TCP.

O painel e o controle continuam no WebSocket. QUIC é usado somente para voz.

Para distribuir a voz por uma região diferente da origem, consulte o
[runbook do edge regional](VOX_EDGE.md). O edge é opcional: sem
`VOX_VOICE_EDGE_HOST`, o processo usa o WebTransport da própria VPS.

O terminador QUIC Rust separado é uma etapa opcional de migração. Quando
`VOX_VOICE_QUIC_GATEWAY_ENABLED=1`, o cliente tenta primeiro o
`vox-voice-quic` em `VOX_VOICE_QUIC_GATEWAY_PORT` e mantém o WebTransport do
Node como fallback. O gateway precisa do certificado do hostname anunciado,
da porta UDP pública liberada e do arquivo `/etc/vox-voice-quic.env`; o canal
de controle `127.0.0.1:19878` não deve ser exposto à internet.

## Requisitos da nova máquina

- Debian/Ubuntu 64-bit com Node.js 22 ou superior;
- DNS `A` e, se usado, `AAAA` apontando para a nova máquina;
- portas abertas no firewall da VPS e no firewall do provedor:
  - `80/tcp` e `443/tcp` para Caddy/HTTPS;
  - `443/udp` para HTTP/3 do Caddy, opcional;
  - `9987-10086/udp` para voz QUIC (ou o intervalo definido por
    `VOX_WT_PORT`/`VOX_WT_PORT_MAX`);
  - `11000/udp` se o gateway QUIC Rust estiver ativado;
  - `22/tcp` somente para administração;
- Caddy instalado e com renovação automática do Let's Encrypt;
- repositório clonado em `/opt/vox`;
- dependências opcionais do WebTransport instaladas por `npm ci`.

Não coloque senha, token, chave SSH ou chave privada de certificado no Git.

## Primeira instalação

```bash
sudo mkdir -p /opt/vox
sudo chown "$USER":"$USER" /opt/vox
git clone git@github.com:pedrogiampietro/vox.git /opt/vox
cd /opt/vox
npm ci
npm run typecheck
npm run build
```

Copie o ambiente da instalação anterior ou crie `/opt/vox/.env`. O mínimo para
o servidor atrás de Caddy é:

```ini
VOX_HOST=127.0.0.1
VOX_PORT=9987
VOX_BASE_DOMAIN=v0x.online
VOX_DATA_DIR=data

# O Caddy emite um certificado por hostname sob demanda. O Vox cria o listener
# QUIC do hostname automaticamente ao receber a primeira conexão.
VOX_WT_PORT=9987
VOX_WT_PORT_MAX=10086
VOX_WT_HOST=0.0.0.0
VOX_WT_CERT_DIR=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory
VOX_WT_CERT=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/server-1.v0x.online/server-1.v0x.online.crt
VOX_WT_KEY=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/server-1.v0x.online/server-1.v0x.online.key

# O serviço está atrás do Caddy local; sem isto todos os clientes parecem vir
# do mesmo IP e o limite de conexões por IP bloqueia a instância inteira.
VOX_TRUST_PROXY=1
```

`VOX_WT_CERT` e `VOX_WT_KEY` são caminhos no disco, não o conteúdo do
certificado. O processo precisa conseguir ler os dois arquivos. `VOX_WT_CERT`
serve como certificado inicial; depois o Vox encontra automaticamente os
certificados irmãos em `VOX_WT_CERT_DIR` e abre uma porta UDP por hostname.
Assim, criar um servidor virtual novo não exige editar o `.env` nem reiniciar o
Vox. Como o serviço atual roda como `root`, a leitura já funciona; com um
usuário dedicado, ajuste grupo e permissões do diretório de certificados.

## Caddy

O Caddy precisa encaminhar o HTTPS e o upgrade do WebSocket para o Node. Um
exemplo equivalente ao ambiente atual:

```caddyfile
{
    on_demand_tls {
        ask http://127.0.0.1:9987/internal/caddy-ask
    }
}

v0x.online, www.v0x.online {
    reverse_proxy 127.0.0.1:9987
}

*.v0x.online {
    tls {
        on_demand
    }
    reverse_proxy 127.0.0.1:9987
}
```

Depois de instalar ou alterar o Caddyfile:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

O certificado do Caddy costuma ficar em:

```text
/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<hostname>/<hostname>.crt
/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<hostname>/<hostname>.key
```

O Vox acompanha a alteração do certificado e recarrega o QUIC. Ao conectar em
`<slug>.v0x.online`, o Caddy emite o certificado sob demanda; após essa emissão,
o Vox cria automaticamente o listener UDP daquele hostname. Não é necessário
criar uma regra Caddy ou um certificado manual por servidor virtual.

## Serviço systemd

Instale a unidade versionada no repositório:

```bash
sudo cp /opt/vox/docs/vox.service /etc/systemd/system/vox.service
```

Ative:

```bash
systemctl daemon-reload
systemctl enable --now vox.service
```

Em uma instalação mais restrita, troque `User=root` por um usuário próprio e
garanta leitura do banco, dos ícones e dos certificados do WebTransport.

## Bot de música (jukebox)

O jukebox é gerenciado pelo próprio `vox.service`. Quando o servidor inicia,
ele cria um controlador por servidor virtual e cada controlador entra no canal
`bot`. Players temporários são criados somente no canal que pediu a música e
encerrados quando a fila termina ou fica sem ouvintes.

Instalações antigas podem ainda ter a unidade separada
`vox-music-jukebox.service`. Ela precisa ficar desativada, porque mantê-la
ativa cria um segundo cliente com o mesmo nome no servidor primário:

```bash
systemctl disable --now vox-music-jukebox.service
systemctl reset-failed vox-music-jukebox.service 2>/dev/null || true
```

O deploy executa essa migração automaticamente quando encontra a unidade
legada.

### Verificar

```bash
systemctl status vox.service --no-pager
journalctl -u vox.service -n 80 --no-pager | grep jukebox
```

O controlador entra no canal `VOX_BOT_CHANNEL` (padrão `bot`) do servidor
primário e responde a pedidos no chat. O jukebox cria players sob demanda, um
por canal de voz ativo, com fila independente; pedidos por DM usam o canal
atual de quem enviou. As variáveis (`VOX_BOT_PASSWORD`, `VOX_BOT_VOLUME`,
`VOX_FFMPEG`, `VOX_YTDLP`) estão descritas no README.

## Deploy de uma atualização

O workflow do GitHub Actions executa este fluxo quando há push na `master`:

```bash
cd /opt/vox
git pull --ff-only origin master
npm ci
npm run build
systemctl restart vox.service
```

O `.env`, `/etc/caddy` e os dados ficam fora do Git e não são sobrescritos pelo
deploy. Depois que os edges regionais forem cadastrados em
`VOX_EDGE_TARGETS`, o mesmo workflow também envia o artefato compilado para
cada VPS, atualiza `vox-edge.service`, reinicia o serviço e restaura a versão
anterior se a nova não ficar saudável. Consulte o [runbook do edge](VOX_EDGE.md)
para a preparação única e o formato da lista.

## Teste de carga e métricas

O painel master exibe, na Visão Geral, CPU do processo Vox, memória RSS,
memória usada da máquina, tráfego de entrada/saída, tráfego separado entre
controle e voz, latência do event loop e uptime. Os contadores de banda medem
os payloads do protocolo; cabeçalhos TCP/TLS ficam fora da conta.

Para um teste local controlado, inicie o servidor com uma janela compatível
com a quantidade de clientes. O limite padrão por IP é 8 para proteção contra
abuso, então um teste com mais clientes precisa ser feito em ambiente de teste:

```powershell
$env:VOX_MAX_PER_IP = '0'
$env:VOX_MAX_CLIENTS = '512'
$env:VOX_JUKEBOX_ENABLED = '0' # linha de base sem o processo de musica
npm run dev:server
```

Em outro terminal:

```powershell
npm run stress -- --clients 100 --speakers 5 --duration 60
```

O comando conclui o handshake real, mede RTT p50/p95/p99 e gera voz
sintética. O perfil `realistic` alterna ciclos de fala e silêncio, variando
também o tamanho e o intervalo dos quadros; `continuous` representa o pior
caso, com todos os falantes transmitindo sem pausa. Para testar o caminho regional
de voz, use `--voice-transport quic`; o controle continua no WebSocket da
origem. Para medir o fallback sem QUIC, use `--voice-transport ws-dedicated`.
O gerador distribui os clientes somente na quantidade de canais solicitada e
abre os links de voz em lotes de 8, com uma pequena rampa entre eles. Isso
evita que uma rajada artificial de 150 handshakes seja confundida com uso
normal. Para reproduzir uma reconexão em massa, aumente deliberadamente
`STRESS_BATCH` e `STRESS_VOICE_BATCH`; para uma entrada gradual, ajuste
`STRESS_VOICE_RAMP_MS`.
Para incluir no resumo as mesmas métricas do painel, informe a senha master
ou um token de sessão:

```powershell
$env:STRESS_ADMIN_PASSWORD = 'senha-do-painel'
npm run stress -- --clients 100 --speakers 5 --duration 60 --voice-profile realistic
```

`STRESS_ADMIN_PASSWORD` cria uma sessão nova para cada rodada e não expira no
meio do teste. `STRESS_ADMIN_TOKEN` continua aceito para compatibilidade; se
ele retornar 401/403, o runner tenta obter uma sessão nova usando a senha.

Com o edge regional ativo, a rodada equivalente pelo QUIC é:

```powershell
npm run stress -- --url wss://server-1.v0x.online/vox/5 --clients 30 --speakers 30 --duration 60 --voice-profile realistic --voice-transport quic
```

O teste remoto exige a confirmação explícita `STRESS_CONFIRM=1`. Comece com
20–50 clientes, observe CPU, RAM, banda e `event loop p95`, e aumente em
degraus. Não execute carga em produção sem combinar janela e limite com quem
opera a VPS; o script não tenta contornar limites de IP, capacidade do plano
ou banimentos.

Para repetir a mesma matriz de capacidade em uma máquina local ou em cada VPS,
use o orquestrador abaixo. Ele executa, em sequência, 20, 50, 80 e 120 clientes
com voz sintética e grava um `report.json` comparável. O teste não inclui o
consumo do Rubinot; o custo do Jukebox pode ser comparado ligando e desligando
`VOX_JUKEBOX_ENABLED`:

```powershell
npm run stress:matrix -- --duration 30 --target hostinger=wss://server-1.v0x.online/vox
npm run stress:matrix -- --duration 30 --target contabo=wss://outro-host.v0x.online/vox
```

É possível informar os dois alvos na mesma execução. Para a matriz remota,
defina `STRESS_CONFIRM=1`; para CPU, RAM, banda e event loop, informe também
`STRESS_ADMIN_TOKEN` ou `STRESS_ADMIN_PASSWORD`. Em ambiente local, deixe `VOX_MAX_PER_IP=0` e um
`VOX_MAX_CLIENTS` acima de 120. A primeira linha de planejamento deve usar o
menor resultado entre as duas VPS, mantendo aproximadamente 30% de folga. Para
separar o custo do processo de música, execute uma rodada com
`VOX_JUKEBOX_ENABLED=0` e outra com `VOX_JUKEBOX_ENABLED=1`; o Rubinot deve ser
medido em uma terceira rodada com o mundo real configurado.

Para testar a capacidade comercial de servidores virtuais na mesma máquina,
use `stress:capacity`. O comando cria temporariamente 1 servidor de 150, 200 e
300 slots e 10 servidores de 50 slots, executa cenários de conexão e voz em
paralelo e remove apenas os servidores que criou:

```powershell
$env:STRESS_ADMIN_PASSWORD = 'senha-do-painel-local'
$env:VOX_MAX_PER_IP = '0'
npm run stress:capacity -- --target local=ws://127.0.0.1:9990/vox --provision --duration 15
```

O relatório mostra clientes ativos, RTT, CPU, memória e saída de banda por
cenário. Em uma VPS, informe `STRESS_ADMIN_TOKEN` ou `STRESS_ADMIN_PASSWORD` e defina também
`STRESS_CONFIRM=1`; faça isso em uma janela combinada, porque os servidores são
criados e apagados durante a medição. Rode com `VOX_JUKEBOX_ENABLED=0` para a
linha de base e com `1` para medir o processo de música. A capacidade segura é
o maior cenário que mantém cerca de 30% de folga e `event loop p95` abaixo de
50–100 ms.

### Janela de carga pela Actions

O workflow manual `Production voice stress` executa em sequência os cenários
isolados de 50, 100 e 150 clientes, com 8, 16 e 24 falantes distribuídos em 2,
4 e 8 canais. Cada cenário é dividido em shards de no máximo 8 clientes, que
rodam simultaneamente em runners diferentes para não concentrar toda a carga
em um único IP. Cada shard publica seu `report.json`; ao final, a Action agrega
os relatórios na própria página, permitindo comparar CPU, memória, banda, event
loop, RTT, descartes e transportes sem somar as cargas entre cenários.

Antes de iniciar, confirme que a VPS aceita a quantidade de conexões por IP e
combine a janela com quem opera a produção. Se quiser CPU, RAM e event loop no
relatório, cadastre `STRESS_ADMIN_PASSWORD` como Secret do repositório. O
workflow também aceita o segredo antigo `STRESS_ADMIN_TOKEN` e o usa como
senha quando não existe um segredo novo; assim a sessão é criada no começo de
cada shard e não fica dependente de um token temporário. Esses segredos nunca
devem ser colocados no workflow ou na URL. Sem eles, o painel master continua
mostrando essas métricas em tempo real.
Depois abra **Actions → Production voice stress → Run workflow**, informe a
URL WSS, a duração, o transporte e digite `PRODUCAO` no campo de confirmação.
O campo `voice_edges` pode ficar em `auto` para medir a seleção normal do
cliente. Para distribuir os shards entre as duas VPS, informe os IDs estáveis
dos edges separados por vírgula, por exemplo `voice-sp,edge-eu`; o seletor deve
ser o nome da região ou um trecho do hostname anunciado. Cada shard será fixado
em um edge e o resumo final mostrará a quantidade de conexões por edge.

Por padrão, a Action usa `quality_gate=report-only`: capacidade (conexões,
transporte, voz e shards completos) reprova a rodada, enquanto RTT e event loop
ficam como alerta. Isso evita confundir a rota do runner hospedado pelo GitHub
com a experiência de um jogador. Para uma meta de latência rígida, escolha
`enforce`. Para medir regiões de forma comparável, rode os mesmos shards em
probes fixos no Brasil e na Europa (self-hosted runners ou VPS); runners
hospedados não têm região de origem fixa garantida.

O roteador Rust mantém as alterações de controle (mute, troca de canal e saída)
em uma fila prioritária, separada da fila limitada de voz. Frames que chegam
atrasados ou quando a fila está cheia são descartados de propósito e aparecem
em `voiceDroppedPacketsTotal`, porque aumentar a fila faria o áudio chegar
velho e prejudicaria todo o canal.

Em uma instalação atrás de Caddy ou outro proxy confiável, valide primeiro
`VOX_TRUST_PROXY=1`. Sem essa opção, o servidor enxerga o endereço do proxy em
vez do cliente e `VOX_MAX_PER_IP=8` passa a valer para todos os usuários juntos;
um teste distribuído termina em `429` sem medir a capacidade de voz.

Os runners hospedados pelo GitHub normalmente têm IPs públicos diferentes, mas
isso não é uma garantia de diversidade geográfica. Se aparecer `429` por limite
de IP, repita a rodada com runners ou máquinas distribuídos no Brasil, Europa e
América do Norte e compare os artefatos pelo mesmo cenário. O workflow é manual
e não agenda carga automaticamente.

## Checkout Pro do Mercado Pago

O checkout pago usa o Checkout Pro: o Vox cria uma preferência no servidor e
redireciona o cliente para o Mercado Pago, onde ele pode escolher Pix ou
cartão. O servidor do cliente só é criado depois que o webhook confirma um
pagamento aprovado. O retorno do navegador não é usado como prova de pagamento.

### Variáveis na VPS

Adicione ao `/opt/vox/.env` (substitua os valores de exemplo):

```ini
VOX_MP_ACCESS_TOKEN=APP_USR-...
VOX_MP_WEBHOOK_SECRET=...
# Preços mensais base. O bot Rubinot é um adicional fixo de R$ 80,00.
VOX_MP_50_PRICE=35.00
VOX_MP_100_PRICE=65.00
VOX_MP_200_PRICE=130.00
VOX_MP_300_PRICE=180.00
VOX_MP_BOT_ADDON_PRICE=80.00
VOX_PUBLIC_ORIGIN=https://v0x.online
VOX_MP_WEBHOOK_URL=https://v0x.online/api/payments/mercadopago/webhook
```

O Access Token é um segredo de servidor: não vai para o frontend, screenshots,
chat, GitHub ou arquivo `.env.example`. A Public Key pode permanecer pública,
mas não substitui o Access Token para criar preferências pelo backend. O Client
ID/Client Secret são necessários para um fluxo OAuth/marketplace; não são o
par usado neste checkout que recebe na própria conta Vox.

No painel do Mercado Pago, abra Webhooks da aplicação de produção, informe
exatamente a URL acima, marque o evento `Pagamentos` e salve. Depois revele a
assinatura secreta gerada e coloque-a em `VOX_MP_WEBHOOK_SECRET`. A assinatura
é usada para rejeitar notificações falsificadas.

Após alterar o `.env`:

```bash
systemctl restart vox.service
systemctl is-active vox.service
journalctl -u vox.service -n 50 --no-pager | grep -Ei 'Mercado Pago|pagamento|erro'
```

Abra `https://v0x.online/api/billing/plans`: os planos pagos devem aparecer com
`enabled: true`. Faça um pedido de teste com valor real somente quando os
preços e a conta estiverem conferidos. O webhook esperado é um `POST` do
Mercado Pago em `/api/payments/mercadopago/webhook`; o Vox consulta o pagamento
na API do Mercado Pago, confere pedido, moeda e valor e então cria o servidor
Rubinot. Notificações repetidas são idempotentes depois que o pedido já tem
servidor associado.

Uma conta pode criar vários servidores independentes. Cada contratação paga
gera um novo servidor vinculado à mesma conta, com sua própria capacidade,
channels e configuração de bot. Cada pagamento aprovado guarda o método, a
data do pagamento e um ciclo de 30 dias. A renovação é feita no painel do
cliente e prolonga o vencimento do mesmo servidor, sem criar outra instância.
A expiração é informativa no painel por enquanto; a suspensão automática do
servidor será uma etapa posterior.

Para diagnosticar uma notificação, use o painel de Webhooks do Mercado Pago e
os logs do serviço. Nunca registre o Access Token, a assinatura secreta ou a
senha do servidor nos logs.

## Migração para outra VPS

### 1. Fazer backup na máquina antiga

```bash
cd /opt/vox
tar -czf "/root/vox-backup-$(date +%Y%m%d-%H%M%S).tar.gz" .env data
tar -czf "/root/caddy-config-backup-$(date +%Y%m%d-%H%M%S).tar.gz" -C /etc caddy
tar -czf "/root/caddy-data-backup-$(date +%Y%m%d-%H%M%S).tar.gz" -C /var/lib/caddy .local/share/caddy
```

Guarde os backups fora da VPS. Eles contêm credenciais e chaves privadas.

### 2. Preparar a nova VPS

Instale Node, Caddy e o repositório seguindo as seções anteriores. Restaure:

- `/opt/vox/.env`;
- `/opt/vox/data/vox.db`;
- `/opt/vox/data/servers.json` e `accounts.json`, quando existirem;
- `/etc/caddy/Caddyfile`;
- o armazenamento do Caddy, ou deixe o Caddy emitir os certificados novamente.

Se o domínio mudar, atualize `VOX_WT_CERT_DIR` para a raiz do armazenamento do
Caddy e `VOX_WT_CERT`/`VOX_WT_KEY` para um certificado inicial existente. Nunca
copie uma chave privada para o repositório.

### 3. Validar antes da troca de DNS

```bash
systemctl is-active caddy
systemctl is-active vox.service
ss -ltnup | grep -E ':(80|443|9987|11000)\b'
journalctl -u vox.service -n 50 --no-pager | grep -Ei 'WebTransport|QUIC|certificado|WebSocket'
```

O resultado necessário para voz QUIC é parecido com:

```text
[vox] voz por WebTransport em udp/9987 (0.0.0.0)
UNCONN 0 0 0.0.0.0:9987 0.0.0.0:* users:(('node',...))
```

Se o gateway separado estiver ativado, confirme também:

```bash
systemctl is-active vox-voice.service
systemctl is-active vox-voice-quic.service
ss -lunp | grep -E ':(11000|19878)\b'
journalctl -u vox-voice-quic.service -n 50 --no-pager
```

### 4. Trocar o DNS

Atualize os registros `A`/`AAAA` para o IP novo. Confira se não existe um
`AAAA` antigo apontando para outra máquina; isso pode fazer alguns usuários
caírem em uma rota diferente.

Depois da propagação, confirme no cliente que aparece `QUIC`, e não `WS`.

## Validação funcional

No repositório local, o smoke test pode ser executado contra a produção:

```bash
VOX_URL=wss://server-1.v0x.online/vox npm run smoke
```

No Windows PowerShell:

```powershell
$env:VOX_URL = 'wss://server-1.v0x.online/vox'
npm run smoke
```

O teste deve validar o handshake QUIC, voz nos dois sentidos, isolamento entre
canais e recuperação para WebSocket. Os clientes de teste são temporários.

Na interface, o indicador esperado separa o caminho de controle do caminho da
voz:

```text
ctrl 167ms · voz 11ms · QUIC · São Paulo · excelente · drop 0
```

QUIC não reduz a distância até o servidor. Ele reduz engasgos e atrasos
variáveis causados por perda de pacotes no TCP. Para reduzir o RTT, é necessário
usar uma VPS mais próxima dos usuários ou distribuir relays por região.

O RTT exibido depois de `voz` é medido no edge QUIC escolhido pelo cliente; o
valor depois de `ctrl` continua sendo o caminho até a origem. Quando há mais de
um candidato configurado, o cliente testa o handshake completo de voz e tenta o
próximo automaticamente se o primeiro edge estiver sem acesso à origem.

As gravações de análise continuam sendo salvas localmente em áudio e JSON. O
relatório agora usa `schema: 2` e inclui `voiceRttMs`, `voiceRegion` e
`voiceQuality` no início e no fim da gravação, permitindo comparar a qualidade
do áudio com a rota efetivamente usada.

## Instaladores do desktop

Os instaladores do Windows **não ficam mais na VPS**. O CI publica em
[pedrogiampietro/v0x-desktop](https://github.com/pedrogiampietro/v0x-desktop/releases)
e o site aponta para `releases/latest/download/`.

O motivo é o aviso "normalmente não é baixado" do Chrome, que é reputação. A
publicação anterior jogava contra em duas frentes: o arquivo saía de um domínio
sem histórico, e era recompilado a cada push na `master` — hash novo em todo
deploy, então nunca acumulava nada.

Agora **só sai release quando a versão muda**. Esta é a regra para qualquer
agente que trabalhe no repositório. Para publicar uma versão nova:

1. suba `version` em `packages/desktop/src-tauri/tauri.conf.json`;
2. faça o push na `master`.

Se a tag já existir, escolha a próxima versão em vez de reutilizá-la. O CI
detecta esse caso quando a versão foi alterada no push e encerra o job para
evitar uma publicação silenciosamente ignorada. Commits que não alteram a
versão continuam podendo atualizar somente o site e o servidor.

Se a tag `v<versão>` já existir, o job não faz nada e diz isso no log. O nome
dos arquivos não muda entre versões — é o que mantém o link `latest/download`
fixo e deixa o arquivo acumular reputação.

O job precisa do secret **`DESKTOP_RELEASE_TOKEN`**: um token do GitHub com
permissão `contents: write` em `v0x-desktop`. Sem ele o job falha de propósito,
porque os botões do site apontam para as releases e ficariam quebrados.

Cada release leva um `SHA256SUMS.txt`, que é a única forma de quem baixa
conferir o arquivo enquanto o binário não for assinado.

### Assinatura de código

Nada disso remove o aviso do SmartScreen na execução, e não garante remover o
do navegador — só assinar resolve de forma determinística. O passo de
assinatura existe no workflow, mas é no-op sem `WINDOWS_CERT_BASE64`.

Atenção ao mexer nisso: desde 2023 as regras do CA/Browser Forum exigem a chave
privada em hardware (FIPS 140-2 nível 2). Não existe mais guardar um `.pfx` num
secret, que é o que o passo atual assume — qualquer certificado novo vai exigir
reescrever a etapa para assinatura em nuvem (Azure Trusted Signing, Azure Key
Vault, DigiCert KeyLocker ou SSL.com eSigner).

## Backup automático

O `vox.service` tira um snapshot do banco sozinho: um 30 segundos depois de
subir — o que fixa o estado anterior a cada deploy, já que o deploy reinicia o
serviço — e depois a cada `VOX_BACKUP_INTERVAL_HOURS` (padrão 24).

```ini
VOX_BACKUP_DIR=/opt/vox/data/backups   # padrão: <VOX_DATA_DIR>/backups
VOX_BACKUP_INTERVAL_HOURS=24           # 0 desliga
VOX_BACKUP_KEEP=14                     # snapshots mantidos
```

O snapshot sai por `VACUUM INTO`, e isso importa: o SQLite roda em WAL, então
quase tudo escrito desde o último checkpoint vive em `vox.db-wal`, não em
`vox.db`. **Copiar apenas `vox.db` com o serviço no ar gera um arquivo onde as
tabelas nem existem.** O `VACUUM INTO` faz o próprio SQLite escrever um banco
novo, consistente e já compactado, sem parar ninguém.

Cada snapshot aparece no log e na aba Auditoria como `backup do banco`:

```bash
journalctl -u vox.service | grep '\[backup\]'
ls -lh /opt/vox/data/backups
```

Para restaurar, pare o serviço e ponha o snapshot no lugar do banco — os
arquivos `-wal` e `-shm` antigos precisam sair junto, senão o SQLite tenta
aplicá-los sobre um banco que não os conhece:

```bash
systemctl stop vox.service
cd /opt/vox/data
mv vox.db vox.db.quebrado; rm -f vox.db-wal vox.db-shm
cp backups/vox-20260904-061200.db vox.db
systemctl start vox.service
```

O backup cobre **somente o banco**. `.env` e os certificados do Caddy ficam de
fora de propósito: carregam segredo, não mudam sozinhos, e copiá-los para um
diretório de rotina transformaria o backup em alvo. O passo a passo deles está
em [Migração para outra VPS](#migração-para-outra-vps).

Os snapshots ficam na mesma máquina, então eles protegem contra erro de deploy
e corrupção — não contra perder a VPS. Para isso, sincronize o diretório para
fora, por exemplo com um `rsync` diário a partir de outra máquina:

```bash
rsync -az --delete root@IP_DA_VPS:/opt/vox/data/backups/ ~/vox-backups/
```

### Cópia remota criptografada no GitHub

O workflow `.github/workflows/backup-to-github.yml` publica a cópia mais
recente na pasta `backups/` deste próprio repositório, sempre criptografada.
O banco original nunca é enviado ao GitHub. O workflow mantém os 14 últimos
snapshots atuais e roda diariamente ou manualmente por `workflow_dispatch`.
Como cada execução cria um commit, versões cifradas antigas continuam no
histórico do Git; isso é esperado e não expõe o banco sem a senha, mas faz o
repositório crescer com o tempo.

Configure em **Settings → Secrets and variables → Actions**:

- secret `VOX_BACKUP_PASSPHRASE`: senha longa usada para cifrar os arquivos.

Os secrets `VPS_HOST`, `VPS_USER` e `VPS_SSH_KEY` já usados pelo deploy também
são usados para ler o snapshot da VPS. Guarde a senha de cifragem fora do
GitHub: sem ela, os arquivos continuam ilegíveis; com ela, é possível
restaurar o banco em outra máquina. O backup automático continua cobrindo
somente o banco — `.env` e certificados precisam de um procedimento separado
e igualmente protegido.

Para restaurar uma cópia publicada, baixe o arquivo `.db.gpg` do repositório
privado e mantenha a senha fora do shell sempre que possível:

```bash
gpg --quiet --batch --pinentry-mode loopback --decrypt \
  --output vox-restaurado.db vox-20260904-061200.db.gpg
```

Valide o checksum do arquivo cifrado antes de descriptografar. O workflow não
é ativado até que a senha de cifragem esteja configurada; isso evita uma
execução que publique um snapshot sem proteção.

## Auditoria e limites de requisição

Toda ação administrativa fica gravada em `audit_log`, na mesma base SQLite do
resto (`data/vox.db`). O painel mostra a trilha na aba **Auditoria**: o master
vê tudo, o dono vê o que ele mesmo fez, em todas as suas contratações.

Ficam registrados login (master e cliente, sucesso e falha), criação e remoção
de servidor, alteração de configuração, kick, ban, remoção de ban, movimentação
e troca de grupo, anúncio, ciclo de vida do bot, checkout, renovação, pagamento
aprovado, webhook recusado e mudança de status de ticket. Senha nunca entra no
registro — um `server.update` grava apenas quais campos mudaram.

A tabela se poda sozinha: 2.000 entradas por servidor e 5.000 para o que não
pertence a servidor nenhum. Para consultar direto no banco:

```bash
sqlite3 /opt/vox/data/vox.db   "SELECT datetime(at/1000,'unixepoch','-3 hours'), actor, ip, action, server_id, detail
   FROM audit_log ORDER BY id DESC LIMIT 40;"
```

Uma sequência de `auth.master.fail` ou `billing.webhook.reject` do mesmo IP é o
sinal que vale acompanhar: são as duas portas que dão acesso ou servidor grátis.

As rotas HTTP têm teto por janela deslizante, contado por conta quando há sessão
e por IP quando não há:

| Balde | Rotas | Teto |
| --- | --- | --- |
| `auth` | login master, login e registro de cliente | 8 / 5 min |
| `write` | qualquer POST/PATCH/DELETE autenticado | 120 / min |
| `provision` | criação de servidor comunidade | 3 / hora |
| `checkout` | compra e renovação | 10 / hora |
| `ticket` | abrir e responder chamado | 12 / 10 min |
| `webhook` | notificação do Mercado Pago | 120 / min |

Estourar o teto responde `429` e a ação não acontece. Os contadores vivem em
memória: reiniciar o `vox.service` zera todos. Leitura (`GET`) não tem teto,
porque o painel faz polling legítimo.

Atrás de proxy, ligue `VOX_TRUST_PROXY=1` — sem isso todo cliente chega com o
mesmo IP e os baldes por IP passam a punir o conjunto.

## Diagnóstico rápido

| Sintoma | Causa provável | Verificação |
| --- | --- | --- |
| `voz no WebSocket (sem WebTransport: falta certificado UDP)` | `VOX_WT_CERT`/`VOX_WT_KEY` ausentes, inválidos ou módulo ausente | `journalctl -u vox.service -n 50` |
| Listener aparece em `127.0.0.1:9987` | `VOX_WT_HOST` herdou o `VOX_HOST` local | definir `VOX_WT_HOST=0.0.0.0` |
| Listener UDP existe, mas cliente mostra `WS` | UDP bloqueada, porta fora do intervalo liberado ou certificado não corresponde ao hostname | firewall, DNS, `VOX_WT_CERT_DIR` e certificado |
| WebSocket funciona, mas QUIC não | Caddy está ativo, mas a UDP anunciada no Welcome não chega ao Node | `tcpdump -ni any udp portrange 9987-10086` |
| Gateway Rust não inicia | `/etc/vox-voice-quic.env` ausente, certificado inválido ou `11000/udp` ocupado | `systemctl status vox-voice-quic.service` e `journalctl -u vox-voice-quic.service` |
| Gateway aparece no Welcome, mas volta ao Node | Node e gateway usam portas de controle diferentes ou o certificado não corresponde ao hostname | conferir `VOX_VOICE_QUIC_GATEWAY_CONTROL`, `VOX_VOICE_QUIC_NODE` e o `.env` da unidade |
| Módulo WebTransport ausente | `npm ci` incompleto ou plataforma incompatível | `node -e "import('@fails-components/webtransport').then(() => console.log('ok'))"` |
| Só alguns subdomínios usam QUIC | certificado novo ainda não foi encontrado ou o intervalo UDP não está liberado | confira o log do hostname, `VOX_WT_CERT_DIR` e o firewall |

Para observar uma tentativa externa em tempo real:

```bash
tcpdump -ni any udp portrange 9987-10086
```

Se nenhum pacote aparecer durante uma tentativa do cliente, o bloqueio está no
firewall do provedor, na rede do usuário ou no DNS — não no processo Node.

## Rollback

O `.env` recebe um backup antes de alterações manuais. Para voltar:

```bash
cp -p /opt/vox/.env.bak-quic-YYYYMMDDHHMMSS /opt/vox/.env
systemctl restart vox.service
```

Para voltar o código ao commit anterior, use o procedimento normal de release
da equipe e depois execute `npm ci`, `npm run build` e `systemctl restart
vox.service`. Não use `git reset --hard` em uma máquina com alterações locais
sem fazer backup antes.
