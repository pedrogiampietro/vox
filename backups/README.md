# Backups remotos

Esta pasta guarda somente cópias cifradas do banco. Os arquivos `.db` originais
nunca entram no GitHub: eles podem conter contas, configurações e dados dos
usuários.

O workflow `Backup remoto criptografado` envia a cópia mais recente para esta
pasta do próprio repositório, sempre cifrada com GPG/AES-256. A senha de
cifragem deve ser mantida fora do GitHub e guardada também em um local offline.

Não coloque aqui arquivos `.db`, `.env`, certificados ou chaves privadas. O
histórico do Git pode manter versões antigas dos arquivos cifrados; por isso,
esta pasta é destinada somente ao banco e o workflow mantém 14 arquivos atuais.
