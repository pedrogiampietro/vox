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
# opcional: tempo para uma interstitial concluir o JavaScript (ms; padrao 45000)
VOX_SCRAPER_CHALLENGE_WAIT_MS=45000
CLOAKBROWSER_LICENSE_KEY=      # opcional; não colocar no repositório
```

Os perfis `deusot` e `deusold` ficam em subdiretórios separados e conservam a
sessão do navegador. Para investigar uma falha:

```bash
journalctl -u vox.service -n 200 --no-pager | grep -Ei 'scraper|deusot|deusold|challenge|bot'
```

Smoke test sem ligar nenhum bot ou publicar mensagens (use explicitamente o
mesmo perfil do `vox.service`):

```bash
VOX_SCRAPER_PROFILE_DIR=/opt/vox/data/scraper-profiles \
  npm run probe:deus -- Andromeda Memorium
```

### Resolver um challenge manualmente

Quando o DeusOT desafiar o IP da VPS, o bot não tenta contornar a proteção.
Existe um bootstrap para concluir a verificação em um navegador visível e
salvar a sessão. O navegador precisa sair pelo mesmo IP da VPS; em Windows,
abra dois terminais PowerShell:

```powershell
# terminal 1: mantenha o tunel aberto
$VPS_USER = 'root'
$VPS_HOST = 'IP_DA_VPS'
ssh -D 1080 -N "$VPS_USER@$VPS_HOST"

# terminal 2: abre o browser local usando o egress da VPS
$env:VOX_CHALLENGE_PROXY = 'socks5://127.0.0.1:1080'
npm run solve:deus -- deusot
```

Resolva o challenge na janela que abrir. O comando valida `/community/worlds`
e `/community/deaths` e salva `data/scraper-profiles/deusot/storage-state.json`.
Depois, envie somente esse arquivo para a mesma pasta da VPS e reinicie o
serviço:

```powershell
$VPS_TARGET = "$VPS_USER@$VPS_HOST"
scp data/scraper-profiles/deusot/storage-state.json "${VPS_TARGET}:/opt/vox/data/scraper-profiles/deusot/storage-state.json"
ssh "$VPS_TARGET" "systemctl restart vox.service"
```

O arquivo de sessão contém cookies do domínio e deve ser tratado como secreto:
não o versione, não o envie para terceiros e não o publique no painel. O
clearance pode expirar; nesse caso, repita o bootstrap. O mesmo fluxo aceita
`deusold` no lugar de `deusot`.

Se aparecer `challenge não foi concluído`, a sessão não foi liberada pelo
site, expirou ou foi associada a outro IP/perfil. O scraper aguarda redirects
e interstitials por até 45 segundos, mas não tenta contornar a proteção. A
solução preferida para operação 100% automática continua sendo uma API/feed
autorizado ou uma allowlist oficial do IP da Vox. Não aumente a frequência de
requests para tentar forçar um challenge.
