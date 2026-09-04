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
CLOAKBROWSER_LICENSE_KEY=      # opcional; não colocar no repositório
```

Os perfis `deusot` e `deusold` ficam em subdiretórios separados e conservam a
sessão do navegador. Para investigar uma falha:

```bash
journalctl -u vox.service -n 200 --no-pager | grep -Ei 'scraper|deusot|deusold|challenge|bot'
```

Smoke test sem ligar nenhum bot ou publicar mensagens:

```bash
npm run probe:deus -- Andromeda Memorium
```

Se aparecer `challenge não foi concluído`, a sessão não foi liberada pelo
site. A solução preferida continua sendo API ou allowlist oficial do IP da
Vox. Não aumente a frequência de requests para tentar forçar um challenge.
