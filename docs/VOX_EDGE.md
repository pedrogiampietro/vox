# Edge regional de voz

O edge regional reduz a latência da voz sem mover o servidor principal. A VPS
principal continua responsável por login, canais, permissões, chat e bot. A
VPS em São Paulo termina WebTransport/QUIC e encaminha a voz entre usuários
locais imediatamente; a origem continua recebendo cada frame para atender
usuários de outras regiões e manter a autoridade do servidor.

```text
cliente ── WSS controle ───────────────► servidor principal
cliente ── WebTransport/QUIC ──────────► voice-sp.v0x.online (São Paulo)
                                           │
                                           └── um WSS multiplexado ──► origem /internal/edge
```

## DNS

Crie na zona DNS do domínio:

```text
Tipo  Nome      Valor             Proxy
A     voice-sp  179.199.142.231   DNS somente
```

O hostname precisa resolver diretamente para a VPS. Proxy HTTP não transporta
o WebTransport/QUIC UDP do edge.

O edge usa um upstream multiplexado: cada navegador continua autenticando o
próprio token, mas a VPS regional mantém um único enlace privado com a origem.
Quando usuários da mesma região falam, a origem envia um frame uma vez por
canal para o edge, e o edge distribui localmente. O caminho antigo por link
individual continua aceito pela origem durante a atualização dos edges.

## Origem

No `.env` da VPS principal, acrescente:

```ini
VOX_VOICE_EDGE_HOST=voice-sp.v0x.online
VOX_VOICE_EDGE_PORT=9987
VOX_VOICE_EDGE_SECRET=COLOQUE_A_MESMA_CHAVE_NAS_DUAS_MAQUINAS
VOX_VOICE_ORIGIN_REGION=Origem
# Opcional quando houver mais de um edge:
# VOX_VOICE_EDGES=São Paulo=voice-sp.v0x.online:9987,Dallas=voice-dallas.v0x.online:9987
```

Gere uma chave longa fora do Git:

```bash
openssl rand -hex 32
```

O Caddy da origem já encaminha o caminho `/internal/edge` junto com os demais
WebSockets. Depois de atualizar o `.env`, reinicie o `vox.service`.

Quando houver mais de uma região, cada edge precisa de DNS, certificado,
  UDP/9987 e o mesmo segredo compartilhado com a origem. O cliente abre os candidatos
  em paralelo e mantém o primeiro handshake completo de voz concluído; isso
  escolhe a menor latência de rota disponível naquele momento, sem depender de
  uma base fixa de geolocalização. Se o QUIC abrir, mas o edge não conseguir
  autenticar na origem, o cliente fecha esse candidato e tenta o próximo.
Além dos edges configurados, a própria origem é anunciada automaticamente como
mais um candidato quando o WebTransport local consegue iniciar. Isso permite
comparar uma VPS regional com a origem sem criar outra máquina.

O ID do edge é estável. `VOX_EDGE_ID` pode ser usado para dar um nome amigável;
se ele não existir, o processo usa automaticamente o hostname da VPS. Assim,
uma reconexão do upstream atualiza o mesmo edge no painel, em vez de criar
entradas `edge-mux-1`, `edge-mux-2` e assim por diante. O cliente também fecha
automaticamente candidatos especulativos que perderam a corrida sem registrá-los
como falhas de autenticação, mantém a rota WebSocket como fallback e tenta o
QUIC novamente com backoff quando a origem ou o edge voltarem.

## Atualização automática de todos os edges

O workflow da `master` compila o edge uma vez e publica o mesmo artefato em
todas as VPS cadastradas. O `.env` da máquina, os certificados, os dados e o
segredo do link não são tocados. Depois do upload, o serviço é reiniciado e
validado; se não ficar `active`, a versão anterior é restaurada
automaticamente.

Faça a preparação de cada VPS uma única vez:

1. Instale a chave pública de deploy em `/root/.ssh/authorized_keys` (ou no
   usuário dedicado que executa `vox-edge.service`).
2. Garanta que a instalação inicial descrita abaixo esteja funcionando.
3. No GitHub, em **Settings → Secrets and variables → Actions**, crie a
   variável `VOX_EDGE_TARGETS`, uma linha por máquina, no formato:

   ```text
   voice-sp|179.199.142.231|root|22
   ```

   Para outra região, acrescente outra linha, por exemplo
   `voice-dallas|IP|root|22`.
4. Crie o secret `VOX_EDGE_SSH_KEY` com a chave privada correspondente. Use
   uma chave exclusiva de deploy, sem senha de usuário e sem colocá-la no
   repositório.

A partir daí, cada push aprovado na `master` atualiza a origem e todos os
edges automaticamente. O cadastro de uma VPS nova continua exigindo apenas a
preparação inicial da máquina e a inclusão da linha; os deploys seguintes
deixam de ser manuais.

## Instalação da VPS em São Paulo

Requisitos: Ubuntu/Debian 64-bit, Node.js 22+, acesso root, IPv4 público e
UDP/9987 liberada no firewall da VPS e no firewall do provedor.

```bash
apt update
apt install -y ca-certificates curl git ufw caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
git clone git@github.com:pedrogiampietro/vox.git /opt/vox
cd /opt/vox
npm ci
npm run build:edge
```

O repositório pode ser clonado por HTTPS quando a máquina não possuir uma chave
SSH do GitHub. Nesse caso, use um token somente de leitura e não o grave no
disco.

Crie `/etc/vox-edge.env` com permissão restrita:

```ini
VOX_EDGE_WT_PORT=9987
# O DNS do edge usa A/IPv4; mantenha o listener em IPv4.
VOX_EDGE_WT_HOST=0.0.0.0
VOX_EDGE_ID=voice-sp
VOX_EDGE_ORIGIN=wss://server-1.v0x.online/internal/edge
VOX_EDGE_SECRET=COLOQUE_A_MESMA_CHAVE_DA_ORIGEM
VOX_EDGE_CERT=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/voice-sp.v0x.online/voice-sp.v0x.online.crt
VOX_EDGE_KEY=/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/voice-sp.v0x.online/voice-sp.v0x.online.key
```

```bash
chmod 600 /etc/vox-edge.env
```

## Certificado TLS

O certificado precisa conter `voice-sp.v0x.online`. O Caddy pode emitir e
renovar o certificado usando HTTP/HTTPS, enquanto o processo edge usa os mesmos
arquivos para QUIC:

```caddyfile
voice-sp.v0x.online {
    respond 200
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
```

Depois que o certificado existir, confirme os caminhos do `.env` e inicie o
edge:

```bash
cp /opt/vox/docs/vox-edge.service /etc/systemd/system/vox-edge.service
systemctl daemon-reload
systemctl enable --now vox-edge.service
```

Firewall mínimo:

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 9987/udp
ufw --force enable
```

## Validação

```bash
systemctl is-active caddy vox-edge.service
ss -lunp | grep 9987
journalctl -u vox-edge.service -n 50 --no-pager
tcpdump -ni any udp port 9987
```

No cliente, o Welcome deve anunciar `voice-sp.v0x.online` e o transporte deve
aparecer como `QUIC`. Para usuários próximos de São Paulo, o RTT de voz deve
ser medido no edge, enquanto o RTT de controle continua refletindo a distância
até a origem.

No log do edge, procure `upstream multiplexado conectado`. Se aparecer apenas
o erro de conexão com a origem, o serviço tenta novamente a cada dois segundos;
os clientes aguardam o próximo upstream ou caem para a rota anunciada pela
origem.

## Fallback e rollback

Se o edge ficar indisponível, remova temporariamente `VOX_VOICE_EDGES` e
`VOX_VOICE_EDGE_HOST` do `.env` da origem e reinicie `vox.service`. O Vox volta
a anunciar o QUIC local da origem; se ele também não estiver disponível, o
cliente continua no WebSocket.

Nunca coloque senha, token, chave privada ou o conteúdo de `/etc/vox-edge.env`
no repositório.
