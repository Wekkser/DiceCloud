#!/usr/bin/env bash
# Avvia e ferma l'istanza DiceCloud locale, condivisa dal companion di Helder (vault ObsidianHelder, sua ADR-0003)
# e da AIMaster (`npm run avvia`). Sta nel fork perché è il motore di entrambi.
#
#   ./dicecloud.sh start    avvia in background e aspetta che risponda
#   ./dicecloud.sh stop
#   ./dicecloud.sh status
#   ./dicecloud.sh logs     ultime righe del log
#
# Il vault di Helder (HELDER_VAULT, altrimenti ../ObsidianHelder/ObsidianHelder) è facoltativo: se c'è, `start`
# collega il suo diario alla tab Journal e rinnova il token del companion.
set -euo pipefail

DC_DIR="${DICECLOUD_DIR:-$(cd "$(dirname "$0")" && pwd)}"
APP="$DC_DIR/app"
VAULT="${HELDER_VAULT:-$DC_DIR/../ObsidianHelder/ObsidianHelder}"
[[ -d "$VAULT" ]] && VAULT="$(cd "$VAULT" && pwd)" || VAULT=""
COMPANION="${VAULT:+$VAULT/mcp/dicecloud}"
PORT="${DICECLOUD_PORT:-3030}"  # la 3000 è spesso occupata da altri dev server
URL="http://localhost:$PORT"
LOG="$DC_DIR/dicecloud.log"
PIDFILE="$DC_DIR/dicecloud.pid"
# Il primo avvio compila tutto: può richiedere parecchi minuti
START_TIMEOUT="${DICECLOUD_START_TIMEOUT:-1500}"

is_up() {
  # Endpoint di salute di DiceCloud: risponde {"status":"ok"} solo se anche il DB funziona
  curl -s --max-time 3 "$URL/api/status" 2>/dev/null | tr -d ' \n' | grep -q '"status":"ok"'
}

running_pid() {
  [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && cat "$PIDFILE"
}

cmd_start() {
  if [[ ! -d "$APP" ]]; then
    echo "Non trovo DiceCloud in $DC_DIR" >&2
    exit 1
  fi
  if is_up; then
    echo "DiceCloud locale già attivo su $URL"
  else
    if ! running_pid >/dev/null; then
      [[ -f "$APP/settings.json" ]] || cp "$APP/exampleMeteorSettings.json" "$APP/settings.json"
      # Diario delle sessioni nella tab Journal: associa il personaggio di .mcp.json del vault di Helder al vault.
      # Moduli caricati a richiesta dall'origine della pagina, non dal ROOT_URL (localhost:3030): da un altro
      # dispositivo, attraverso il proxy del Master AI, la UI resterebbe vuota (AIMaster ADR-0020)
      node -e '
        const fs = require("fs");
        const [settingsFile, vault] = process.argv.slice(1);
        const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
        const before = JSON.stringify(settings);
        if (vault) {
          const id = JSON.parse(fs.readFileSync(vault + "/.mcp.json", "utf8")).mcpServers.dicecloud.env.DICECLOUD_CREATURE_ID;
          settings.vaults = { ...settings.vaults, [id]: vault };
        }
        settings.public = { ...settings.public };
        settings.public.packages = { ...settings.public.packages };
        settings.public.packages["dynamic-import"] = { ...settings.public.packages["dynamic-import"], useLocationOrigin: true };
        if (JSON.stringify(settings) !== before) fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
      ' "$APP/settings.json" "$VAULT"
      # NO_HMR: il CSS dei componenti Vue va nel bundle invece che dal server di ricaricamento a caldo (http, porta 3033),
      # che una pagina HTTPS (proxy del Master AI) blocca: la scheda restava senza colonne (AIMaster ADR-0020)
      (cd "$APP" && NO_HMR=1 nohup meteor run --port "$PORT" --settings settings.json >"$LOG" 2>&1 & echo $! >"$PIDFILE")
      echo "Avvio DiceCloud locale (log: $LOG)…"
    fi
    local waited=0
    until is_up; do
      if ! running_pid >/dev/null; then
        echo "DiceCloud si è fermato durante l'avvio. Ultime righe del log:" >&2
        tail -n 30 "$LOG" >&2
        exit 1
      fi
      if (( waited >= START_TIMEOUT )); then
        echo "DiceCloud non risponde dopo ${START_TIMEOUT}s. Controlla $LOG" >&2
        exit 1
      fi
      sleep 5
      waited=$((waited + 5))
    done
    echo "DiceCloud locale attivo su $URL"
  fi
  # Rinnova il token del companion, se esiste (i token Meteor scadono dopo 90 giorni)
  if [[ -n "$COMPANION" ]] && grep -q '^DICECLOUD_TOKEN=' "$COMPANION/.env" 2>/dev/null; then
    node "$COMPANION/local/grant_token.mjs" --refresh || echo "Attenzione: token del companion non rinnovato" >&2
  fi
}

kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null || true
}

# Processi Meteor in ascolto su una porta (il tool sulla porta dell'app, mongod su quella dopo)
meteor_listeners() {
  local pid
  for pid in $(lsof -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null); do
    ps -o command= -p "$pid" | grep -q '\.meteor/' && echo "$pid"
  done
}

cmd_stop() {
  local pid
  if pid="$(running_pid)"; then kill_tree "$pid"; fi
  for pid in $(meteor_listeners "$PORT") $(meteor_listeners $((PORT + 1))); do kill_tree "$pid"; done
  # Server Node dell'app rimasto orfano
  pkill -f "$APP/.meteor/local" 2>/dev/null || true
  for _ in {1..20}; do
    [[ -z "$(meteor_listeners "$PORT")$(meteor_listeners $((PORT + 1)))" ]] && break
    sleep 0.5
  done
  rm -f "$PIDFILE"
  echo "DiceCloud locale fermo"
}

cmd_status() {
  if is_up; then echo "attivo su $URL"
  elif running_pid >/dev/null; then echo "in avvio (log: $LOG)"
  else echo "fermo"; fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) tail -n "${2:-50}" "$LOG" ;;
  *) echo "Uso: $0 start|stop|status|logs [righe]" >&2; exit 1 ;;
esac
