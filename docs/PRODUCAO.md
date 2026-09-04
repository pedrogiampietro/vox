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

## Requisitos da nova máquina

- Debian/Ubuntu 64-bit com Node.js 22 ou superior;
- DNS `A` e, se usado, `AAAA` apontando para a nova máquina;
- portas abertas no firewall da VPS e no firewall do provedor:
  - `80/tcp` e `443/tcp` para Caddy/HTTPS;
  - `443/udp` para HTTP/3 do Caddy, opcional;
  - `9987-10086/udp` para voz QUIC (ou o intervalo definido por
    `VOX_WT_PORT`/`VOX_WT_PORT_MAX`);
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

## Deploy de uma atualização

O workflow do GitHub Actions já executa este fluxo quando há push na `master`:

```bash
cd /opt/vox
git pull --ff-only origin master
npm ci
npm run build
systemctl restart vox.service
```

O `.env`, `/etc/caddy` e os dados ficam fora do Git e não são sobrescritos pelo
deploy.

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
VOX_MP_50_NO_BOT_PRICE=29.90
VOX_MP_50_BOT_PRICE=69.90
VOX_MP_100_NO_BOT_PRICE=50.90
VOX_MP_100_BOT_PRICE=99.90
VOX_MP_254_NO_BOT_PRICE=100.00
VOX_MP_254_BOT_PRICE=150.00
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
ss -ltnup | grep -E ':(80|443|9987)\b'
journalctl -u vox.service -n 50 --no-pager | grep -Ei 'WebTransport|QUIC|certificado|WebSocket'
```

O resultado necessário para voz QUIC é parecido com:

```text
[vox] voz por WebTransport em udp/9987 (0.0.0.0)
UNCONN 0 0 0.0.0.0:9987 0.0.0.0:* users:(('node',...))
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

## Diagnóstico rápido

| Sintoma | Causa provável | Verificação |
| --- | --- | --- |
| `voz no WebSocket (sem WebTransport: falta certificado UDP)` | `VOX_WT_CERT`/`VOX_WT_KEY` ausentes, inválidos ou módulo ausente | `journalctl -u vox.service -n 50` |
| Listener aparece em `127.0.0.1:9987` | `VOX_WT_HOST` herdou o `VOX_HOST` local | definir `VOX_WT_HOST=0.0.0.0` |
| Listener UDP existe, mas cliente mostra `WS` | UDP bloqueada, porta fora do intervalo liberado ou certificado não corresponde ao hostname | firewall, DNS, `VOX_WT_CERT_DIR` e certificado |
| WebSocket funciona, mas QUIC não | Caddy está ativo, mas a UDP anunciada no Welcome não chega ao Node | `tcpdump -ni any udp portrange 9987-10086` |
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
