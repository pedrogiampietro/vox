# Providers do bot Vox

O bot não acessa diretamente um site específico. Ele recebe um `GameProvider`,
que normaliza quatro fontes de informação:

- jogadores online por mundo;
- mortes recentes;
- membros de guild;
- ficha pública de personagem.

## Providers disponíveis

| Provider | Preset | Fonte | Mundos |
| --- | --- | --- | --- |
| `rubinot` | Rubinot | API JSON + páginas públicas | definidos pelo Rubinot |
| `deusot` | DeusOT | páginas públicas HTML via browser persistente | Andromeda, Eclipse, Sirius, Titan |
| `deusold` | DeusOLD | páginas públicas HTML via browser persistente | Memorium |

O DeusOT publica roster online, mortes, guilds e personagens. O DeusOLD
publica mortes, guilds e personagens, além do contador de jogadores do mundo,
mas não publica o nome de cada jogador online. Nesse provider o bot não emite
logins/logouts nem finge ter uma Hunted List online.

O provider é escolhido pelo preset ativo (`ServerPreset.bot.provider`). O
preset Rubinot é o padrão para preservar servidores antigos.

## Trocar a fonte de um servidor

1. Entre no servidor como owner.
2. Abra as configurações do servidor e selecione o preset desejado.
3. Aplique o preset.
4. Abra a aba `Bot`, informe o mundo exato do provider e salve.
5. Ligue o bot e use `Testar alerta`.

Ao trocar de provider, o bot é parado automaticamente e o mundo antigo é
limpo. Isso evita que um mundo Rubinot seja consultado no DeusOT, ou que dados
de uma fonte sejam publicados no servidor errado.

## Operação e logs

O bot faz o primeiro snapshot sem publicar falsos logins, level-ups ou mortes.
As consultas seguintes geram os mesmos eventos para qualquer provider. Falhas
de scraping aparecem no journal do serviço com o nome da fonte:

```bash
journalctl -u vox.service -f | grep -Ei 'bot|rubinot|deusot|deusold'
```

DeusOT e DeusOLD usam um contexto de navegador persistente por domínio. Ele é
iniciado somente quando o provider é usado; a primeira inicialização pode
demorar mais porque o Chromium é preparado. As consultas são serializadas e
possuem timeout para não sobrecarregar o processo nem disputar navegação entre
servidores.

Variáveis opcionais na VPS:

```ini
VOX_SCRAPER_PROFILE_DIR=/opt/vox/data/scraper-profiles
VOX_SCRAPER_HEADLESS=true
VOX_SCRAPER_FINGERPRINT=51873  # mantenha igual ao bootstrap manual
# orçamento total para resolver um challenge (ms; padrão 45000)
VOX_SCRAPER_CHALLENGE_WAIT_MS=45000
# rodadas de (esperar -> clicar -> recarregar) por request (padrão 3)
VOX_SCRAPER_CHALLENGE_ATTEMPTS=3
# 0 volta ao comportamento antigo: só esperar, nunca clicar
VOX_SCRAPER_CHALLENGE_INTERACTIVE=1
# opcional: onde gravar screenshot + HTML quando um challenge não é resolvido
VOX_SCRAPER_CHALLENGE_DEBUG_DIR=/opt/vox/data/challenge-dumps
CLOAKBROWSER_LICENSE_KEY=      # opcional; não colocar no repositório
```

Os perfis `deusot` e `deusold` ficam em subdiretórios separados e conservam a
sessão do navegador. Cada um roda em um perfil de usuário real e persistente
(`<perfil>/profile`), não em janela anônima: cookies, localStorage e os tokens
de dispositivo do Cloudflare sobrevivem ao restart, e o modo anônimo — que é
detectável — deixa de ser um sinal contra a sessão. Isso significa dois
processos Chromium quando os dois providers estão em uso. Para investigar uma
falha:

```bash
journalctl -u vox.service -n 200 --no-pager | grep -Ei 'scraper|deusot|deusold|challenge|bot'
```

Smoke test sem ligar nenhum bot ou publicar mensagens (use explicitamente o
mesmo perfil do `vox.service`):

```bash
VOX_SCRAPER_PROFILE_DIR=/opt/vox/data/scraper-profiles \
  npm run probe:deus -- Andromeda Memorium
```

### Challenge do Cloudflare

O interstitial tem dois modos. O **não-interativo** termina sozinho quando o
JavaScript da página acaba de rodar. O **gerenciado (Turnstile)** monta um
widget com a caixa "Verify you are human" e nunca libera sem um clique — era
esse que batia no timeout e derrubava o provider com
`challenge que não foi concluído automaticamente`.

O scraper agora resolve os dois. Ao detectar o interstitial ele:

1. espera até 8s, dando chance ao modo não-interativo;
2. procura o widget — o iframe de `challenges.cloudflare.com`, o checkbox
   dentro dele, ou o container (`#challenge-stage`, `.cf-turnstile`, …) quando
   o iframe está escondido em shadow DOM fechado;
3. leva o mouse até ele com as curvas humanizadas do cloakbrowser e clica. O
   clique sai do driver de input do Chromium, então chega na página como
   evento real (`isTrusted`);
4. espera a validação e, se não liberar, recarrega para pegar um token novo e
   repete até `VOX_SCRAPER_CHALLENGE_ATTEMPTS`.

Não forjamos token, não injetamos evento sintético e não resolvemos captcha de
imagem. Se o site pedir mais que o checkbox, a tentativa falha e o erro sobe
como antes — com `tentativas=`, `cliques=` e `widget=` no fim da mensagem, mais
o screenshot em `VOX_SCRAPER_CHALLENGE_DEBUG_DIR` se estiver configurado.

O log do serviço mostra o caminho percorrido:

```bash
journalctl -u vox.service -f | grep '\[challenge\]'
```

Se o modo gerenciado continuar falhando em `headless=true`, rode o Chromium com
tela virtual — é a diferença mais comum entre resolver e não resolver:

```ini
VOX_SCRAPER_HEADLESS=false
```

```ini
# vox.service
ExecStart=/usr/bin/xvfb-run -a /usr/bin/node /opt/vox/dist/server.mjs
```

### Resolver um challenge manualmente

Quando nem assim liberar — captcha de imagem, IP recém-bloqueado ou perfil que
precisa nascer com a verificação feita — existe um bootstrap para concluir a
verificação em um navegador visível e salvar a sessão. Ele usa o mesmo solver
do serviço, então normalmente resolve sozinho e só resta olhar. O navegador
precisa sair pelo mesmo IP da VPS; em Windows, abra dois terminais PowerShell:

```powershell
# terminal 1: mantenha o tunel aberto
$VPS_USER = 'root'
$VPS_HOST = 'IP_DA_VPS'
ssh -D 1080 -N "$VPS_USER@$VPS_HOST"

# terminal 2: abre o browser local usando o egress da VPS
$env:VOX_CHALLENGE_PROXY = 'socks5://127.0.0.1:1080'
npm run solve:deus -- deusot
```

Se sobrar algo para clicar, resolva na janela que abrir. O comando valida
`/community/worlds` e `/community/deaths` e salva
`data/scraper-profiles/deusot/storage-state.json`. Depois, envie somente esse
arquivo para a mesma pasta da VPS e reinicie o serviço:

```powershell
$VPS_TARGET = "$VPS_USER@$VPS_HOST"
scp data/scraper-profiles/deusot/storage-state.json "${VPS_TARGET}:/opt/vox/data/scraper-profiles/deusot/storage-state.json"
ssh "$VPS_TARGET" "systemctl restart vox.service"
```

O arquivo de sessão contém cookies do domínio e deve ser tratado como secreto:
não o versione, não o envie para terceiros e não o publique no painel. O
clearance pode expirar; nesse caso, repita o bootstrap. O mesmo fluxo aceita
`deusold` no lugar de `deusot`.

O serviço importa esse arquivo para o perfil sempre que o `mtime` for mais
novo que o da última importação — copiar por `scp` e reiniciar continua sendo
suficiente, e um restart comum não sobrescreve os cookies que o próprio perfil
renovou. Para começar do zero, apague `data/scraper-profiles/<provider>/profile`.

A solução preferida para operação 100% automática continua sendo uma API/feed
autorizado ou uma allowlist oficial do IP da Vox. Não aumente a frequência de
requests para tentar forçar um challenge.
