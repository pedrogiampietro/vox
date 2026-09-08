#!/usr/bin/env bash
set -Eeuo pipefail

artifact_dir="${1:?informe o diretorio do artefato do edge}"

if [[ -z "${EDGE_TARGETS:-}" || -z "${EDGE_TARGETS//[[:space:]]/}" ]]; then
  echo 'Nenhum edge regional cadastrado em VOX_EDGE_TARGETS; deploy de edge ignorado.'
  exit 0
fi

if [[ -z "${EDGE_SSH_KEY:-}" ]]; then
  echo 'VOX_EDGE_SSH_KEY ausente; nao e possivel atualizar os edges.' >&2
  exit 1
fi

install -m 700 -d "$HOME/.ssh"
printf '%s\n' "$EDGE_SSH_KEY" > "$HOME/.ssh/id_ed25519"
chmod 600 "$HOME/.ssh/id_ed25519"

ssh_options=(
  -i "$HOME/.ssh/id_ed25519"
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o ConnectTimeout=15
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
)

while IFS='|' read -r edge_id edge_host edge_user edge_port extra; do
  edge_id="${edge_id//$'\r'/}"
  edge_host="${edge_host//$'\r'/}"
  edge_user="${edge_user//$'\r'/}"
  edge_port="${edge_port//$'\r'/}"

  [[ -z "${edge_id//[[:space:]]/}" ]] && continue
  [[ "$edge_id" == \#* ]] && continue
  if [[ -n "${extra:-}" || -z "${edge_host:-}" || -z "${edge_user:-}" ]]; then
    echo "Entrada invalida em VOX_EDGE_TARGETS para '$edge_id'; use id|host|usuario|porta." >&2
    exit 1
  fi
  edge_port="${edge_port:-22}"
  if [[ ! "$edge_id" =~ ^[A-Za-z0-9._-]+$ || ! "$edge_host" =~ ^[A-Za-z0-9._:-]+$ || ! "$edge_user" =~ ^[A-Za-z0-9._-]+$ || ! "$edge_port" =~ ^[0-9]+$ ]]; then
    echo "Entrada insegura em VOX_EDGE_TARGETS para '$edge_id'." >&2
    exit 1
  fi

  target="$edge_user@$edge_host"
  echo "Atualizando edge $edge_id ($target:$edge_port)..."
  ssh-keyscan -p "$edge_port" -H "$edge_host" >> "$HOME/.ssh/known_hosts" 2>/dev/null
  sort -u "$HOME/.ssh/known_hosts" -o "$HOME/.ssh/known_hosts"

  scp "${ssh_options[@]}" -P "$edge_port" \
    "$artifact_dir/edge.mjs" "$artifact_dir/vox-edge.service" \
    "$target:/tmp/" >/dev/null
  ssh "${ssh_options[@]}" -p "$edge_port" "$target" 'bash -s' <<'REMOTE'
set -Eeuo pipefail

install -d -m 0755 /opt/vox/dist
timestamp="$(date +%Y%m%d%H%M%S)"
code="/opt/vox/dist/edge.mjs"
code_backup="/opt/vox/dist/edge.mjs.bak-$timestamp"
unit="/etc/systemd/system/vox-edge.service"
unit_backup="/etc/systemd/system/vox-edge.service.bak-$timestamp"
unit_changed=0

if [[ -f "$code" ]]; then
  cp -p "$code" "$code_backup"
fi

new_code="$(mktemp /opt/vox/dist/edge.mjs.new.XXXXXX)"
install -m 0644 /tmp/vox-edge.mjs "$new_code"
mv -f "$new_code" "$code"

new_unit="$(mktemp /etc/systemd/system/vox-edge.service.new.XXXXXX)"
install -m 0644 /tmp/vox-edge.service "$new_unit"
if [[ ! -f "$unit" ]] || ! cmp -s "$new_unit" "$unit"; then
  if [[ -f "$unit" ]]; then
    cp -p "$unit" "$unit_backup"
  fi
  mv -f "$new_unit" "$unit"
  unit_changed=1
else
  rm -f "$new_unit"
fi

if [[ "$unit_changed" == 1 ]]; then
  systemctl daemon-reload
fi

rm -f /tmp/vox-edge.mjs /tmp/vox-edge.service
systemctl reset-failed vox-edge.service >/dev/null 2>&1 || true
if systemctl restart vox-edge.service && systemctl is-active --quiet vox-edge.service; then
  echo "vox-edge: active"
  exit 0
fi

echo 'O edge nao ficou ativo; restaurando a versao anterior.' >&2
if [[ -f "$code_backup" ]]; then
  cp -p "$code_backup" "$code"
fi
if [[ "$unit_changed" == 1 ]]; then
  if [[ -f "$unit_backup" ]]; then
    cp -p "$unit_backup" "$unit"
  else
    rm -f "$unit"
  fi
  systemctl daemon-reload
fi
systemctl reset-failed vox-edge.service >/dev/null 2>&1 || true
systemctl restart vox-edge.service >/dev/null 2>&1 || true
exit 1
REMOTE
done <<< "$EDGE_TARGETS"
