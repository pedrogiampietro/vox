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
| `deusot` | DeusOT | páginas públicas HTML | Andromeda, Eclipse, Sirius, Titan |

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
journalctl -u vox.service -f | grep -Ei 'bot|rubinot|deusot'
```

O provider DeusOT tem timeout de 15 segundos e cacheia o mapa de mundos por 30
minutos. A resolução de guilds usa o nome exato retornado na busca, evitando
selecionar a primeira guild quando existem resultados parecidos.
