# Instruções para agentes do v0x

Estas regras valem para qualquer IA ou agente que altere este repositório.

## Versionamento e release do desktop

- A versão oficial do aplicativo Windows fica em
  `packages/desktop/src-tauri/tauri.conf.json`, no campo `version`.
- Não aumente a versão em todo commit. Alterações apenas web/server devem
  continuar usando a versão atual; o deploy da VPS acontece normalmente.
- Se a solicitação incluir uma nova versão do aplicativo, novo instalador,
  publicação do desktop ou release, aumente a versão seguindo SemVer antes do
  commit. Use `patch` para correções, `minor` para funcionalidades compatíveis
  e `major` somente quando houver quebra de compatibilidade.
- Antes de publicar, execute pelo menos `npm run typecheck` e `npm run build`.
  Em um runner Windows, o CI também executará o build do Tauri e gerará NSIS e
  MSI.
- Faça commit da alteração de versão junto com o código e envie para a
  `master`. O workflow `.github/workflows/ci-cd.yml` cria automaticamente a
  release com a tag `v<versão>` no repositório
  `pedrogiampietro/v0x-desktop`, anexando o instalador `.exe`, o `.msi` e
  `SHA256SUMS.txt`.
- Não crie manualmente a release no repositório de desktop como substituição
  do CI. Depois do push, confira a execução do GitHub Actions e a release
  gerada.
- Se a tag já existir, não reutilize a versão. Escolha a próxima versão; o CI
  falha quando detecta que a versão foi alterada para uma tag já publicada.

## Escopo do commit

- Preserve alterações existentes e não faça reset destrutivo.
- Para mudanças que só afetam o site, não faça bump do desktop apenas para
  forçar um instalador novo.
- Se o usuário pedir explicitamente `commit` e `push`, publique na `master`
  depois de validar o código; caso contrário, entregue a alteração local e
  informe o que ainda precisa ser publicado.

Mais detalhes operacionais estão em `docs/PRODUCAO.md`, na seção
"Instaladores do desktop".
