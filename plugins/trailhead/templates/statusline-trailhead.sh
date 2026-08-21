#!/usr/bin/env bash
# Statusline trailhead-aware: "modello | progetto | branch | ticket | contesto | usage"
#
# Legge su stdin il JSON che Claude Code passa alle statusline
# (.model.display_name, .model.id, .workspace.current_dir, .cwd, .transcript_path).
#
# Ticket in lavorazione: marker locale `.trailhead/session-ticket` (scritto da
# trailhead al work-start, porta anche il titolo) -> numero dal branch
# `trailhead/t<N>` -> titolo via `gh` in cache/background (solo se origin GitHub).
#
# Contesto: barra `[BARRA] Nk/Mk (P%)`, dall'ultimo usage del transcript. Tetto:
# $CONTEXT_LIMIT -> .model.context_window -> tabella modello -> auto-bump 1M.
#
# Usage: % REALE del piano via l'API OAuth di Anthropic (come ccstatusline):
# GET https://api.anthropic.com/api/oauth/usage con il Bearer preso da
# ~/.claude/.credentials.json (claudeAiOauth.accessToken). Mostra la finestra
# 5h e la settimana (7 giorni) piu' il reset. Cache ~60s, chiamata in background
# (il render non aspetta la rete). Disabilita con TRAILHEAD_STATUSLINE_USAGE=0.
#
# Uso:
#   - standalone: settings.json -> statusLine.command = "bash ~/.claude/statusline-trailhead.sh"
#   - widget singolo (ccstatusline custom command): "--ticket-only" | "--context-only" | "--usage-only"

set -uo pipefail

MODE="${1:-full}"
input="$(cat)"

j() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

# --- colori ANSI (disattivabili con NO_COLOR) ---
if [ -n "${NO_COLOR:-}" ]; then
  C_RST= ; C_SEP= ; C_MODEL= ; C_PROJ= ; C_BRANCH= ; C_TICKET= ; C_CTX= ; C_5H= ; C_RESET= ; C_7D=
else
  e=$'\033['
  C_RST="${e}0m"        # reset
  C_SEP="${e}90m"       # separatori: grigio
  C_MODEL="${e}36m"     # modello: cyan
  C_PROJ="${e}94m"      # progetto: blu chiaro
  C_BRANCH="${e}92m"    # branch: verde chiaro
  C_TICKET="${e}93m"    # ticket: giallo chiaro
  C_CTX="${e}95m"       # contesto: magenta chiaro
  C_5H="${e}33m"        # finestra 5h: giallo
  C_RESET="${e}32m"     # reset: verde
  C_7D="${e}96m"        # settimana: cyan chiaro
fi

# --- modello ---
MODEL="$(j '.model.display_name')"
TRANSCRIPT="$(j '.transcript_path')"

# --- directory di lavoro ---
DIR="$(j '.workspace.current_dir')"
[ -z "$DIR" ] && DIR="$(j '.cwd')"
[ -z "$DIR" ] && DIR="$PWD"

# --- repo root + nome progetto ---
ROOT="$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$DIR")"
PROJ="$(basename "$ROOT")"

# --- branch (con gestione detached HEAD) ---
BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
[ "$BRANCH" = "HEAD" ] && BRANCH="@$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null)"

# --- ticket in lavorazione ---
TICKET_N=""
TITLE=""
MARKER="$ROOT/.trailhead/session-ticket"
if [ -f "$MARKER" ]; then
  line="$(head -1 "$MARKER" 2>/dev/null)"
  TICKET_N="$(printf '%s' "$line" | grep -oE '[0-9]+' | head -1)"
  TITLE="$(printf '%s' "$line" | sed -E 's/^[^0-9]*[0-9]+[[:space:]]*//')"
elif [[ "$BRANCH" =~ trailhead/t([0-9]+) ]]; then
  TICKET_N="${BASH_REMATCH[1]}"
fi

# --- titolo via gh, solo se manca e se l'origin e' GitHub (cache + background) ---
if [ -n "$TICKET_N" ] && [ -z "$TITLE" ] && command -v gh >/dev/null 2>&1; then
  ORIGIN="$(git -C "$ROOT" remote get-url origin 2>/dev/null)"
  REPO=""
  case "$ORIGIN" in
    *github.com[:/]*) REPO="$(printf '%s' "$ORIGIN" | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$#\1#')" ;;
  esac
  if [ -n "$REPO" ]; then
    CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/trailhead-statusline"
    mkdir -p "$CACHE" 2>/dev/null
    CF="$CACHE/$(printf '%s' "$REPO" | tr -c 'a-zA-Z0-9' '_')_${TICKET_N}.title"
    [ -f "$CF" ] && TITLE="$(cat "$CF" 2>/dev/null)"
    if [ ! -f "$CF" ] || [ -n "$(find "$CF" -mmin +10 2>/dev/null)" ]; then
      ( t="$(gh issue view "$TICKET_N" -R "$REPO" --json title -q .title 2>/dev/null)" \
          && [ -n "$t" ] && printf '%s' "$t" > "$CF" ) >/dev/null 2>&1 &
    fi
  fi
fi

# --- composizione ticket ---
TICKET=""
if [ -n "$TICKET_N" ]; then
  if [ -n "$TITLE" ]; then
    # titolo intero di default (riga 2 dedicata); tetto opzionale con TICKET_TITLE_MAX
    TMAX="${TICKET_TITLE_MAX:-}"
    [ -n "$TMAX" ] && [ "${#TITLE}" -gt "$TMAX" ] && TITLE="${TITLE:0:$((TMAX-1))}…"
    TICKET="#${TICKET_N} ${TITLE}"
  else
    TICKET="#${TICKET_N}"
  fi
fi

# --- barra dimensione contesto: "[BARRA] 364k/1000k (36%)" ---
# Fonte primaria (come ccstatusline): .context_window del JSON di Claude Code
# (context_window_size = tetto reale, current_usage = token). Fallback: ultimo
# usage del transcript + tabella modello. $CONTEXT_LIMIT forza il tetto.
# Denominatore = finestra * 0.8 (soglia auto-compact, come ccstatusline); il
# rapporto e' regolabile con CONTEXT_USABLE_RATIO (1 = tetto pieno).
CTX="$(
  { [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] && tail -n 300 "$TRANSCRIPT" 2>/dev/null | tac | grep -m1 'cache_read_input_tokens'; } | \
  CTX_MODEL_ID="$(j '.model.id')" \
  CTX_CW_SIZE="$(j '.context_window.context_window_size')" \
  CTX_USAGE="$(printf '%s' "$input" | jq -c '.context_window.current_usage // empty' 2>/dev/null)" \
  python3 -c '
import sys, os, json, re

def as_int(x):
    try: return int(float(x))
    except Exception: return 0

def sum_usage(u):
    # "context length" = input + cache_creation + cache_read (esclude output), come ccstatusline
    if isinstance(u, (int, float)):
        return int(u)
    if isinstance(u, dict):
        return (as_int(u.get("input_tokens")) + as_int(u.get("cache_creation_input_tokens"))
                + as_int(u.get("cache_read_input_tokens")))
    return 0

tok = 0
# 1) fonte primaria: .context_window.current_usage dal JSON di Claude Code
cw = os.environ.get("CTX_USAGE","")
if cw:
    try: tok = sum_usage(json.loads(cw))
    except Exception: tok = 0
# 2) fallback: ultimo usage del transcript
if tok <= 0:
    line = sys.stdin.readline()
    if line:
        try:
            u = json.loads(line).get("message", {}).get("usage", {})
        except Exception:
            m = re.search(r"\"usage\":\{.*?\}\}", line) or re.search(r"\"usage\":\{[^}]*\}", line)
            u = json.loads("{"+m.group(0)+"}")["usage"] if m else {}
        tok = sum_usage(u)
if tok <= 0:
    raise SystemExit

# tetto: CONTEXT_LIMIT (override) > context_window_size (autorevole) > tabella modello
limit = as_int(os.environ.get("CONTEXT_LIMIT"))
if not limit:
    limit = as_int(os.environ.get("CTX_CW_SIZE"))
if not limit:
    mid = (os.environ.get("CTX_MODEL_ID") or "").lower()
    table = [("haiku",200000),("sonnet",200000),("opus",200000)]
    limit = next((v for k,v in table if k in mid), 200000)
    if tok > limit and limit <= 200000:   # auto-bump 1M solo nel fallback
        limit = 1000000

# soglia usabile (auto-compact): denominatore = finestra * ratio (0.8 come ccstatusline)
try:
    ratio = float(os.environ.get("CONTEXT_USABLE_RATIO") or 0.8)
except Exception:
    ratio = 0.8
denom = round(limit * ratio) if limit else 0
pct = min(100, round(tok*100/denom)) if denom else 0   # % contro la soglia 0.8
n = 10; filled = round(pct*n/100)
bar = "█"*filled + "░"*(n-filled)
# numeri REALI: token effettivi / tetto pieno; la percentuale riflette auto-compact 0.8
print(f"[{bar}] {round(tok/1000)}k/{round(limit/1000)}k ({pct}%)")
' 2>/dev/null
)"

# --- usage: % reale del piano via l'API OAuth di Anthropic (come ccstatusline) ---
# five_hour.utilization (finestra 5h) e seven_day.utilization (settimana), piu' i reset.
# Backoff variabile (come ccstatusline): cache success 180s; su 429 rispetta l'header
# Retry-After (default 300s); altri errori 30s. Timeout 5s (USAGE_API_TIMEOUT lo cambia).
# Chiamata in background: il render non attende mai. Off con TRAILHEAD_STATUSLINE_USAGE=0.
USAGE_RAW=""
CREDS="$HOME/.claude/.credentials.json"
if [ "${TRAILHEAD_STATUSLINE_USAGE:-1}" != "0" ] && [ -f "$CREDS" ]; then
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/trailhead-statusline"
  mkdir -p "$CACHE" 2>/dev/null
  UF="$CACHE/usage.txt"
  # cache RAW (una parte per riga, senza colori): i colori si applicano al render
  [ -f "$UF" ] && USAGE_RAW="$(cat "$UF" 2>/dev/null)"
  # refresh solo dopo il "next" (epoch): backoff diverso per success / 429 / errore
  NOW="$(date +%s)"; NEXT=0
  [ -f "$UF.next" ] && NEXT="$(tr -dc 0-9 < "$UF.next" 2>/dev/null)"
  [ -z "$NEXT" ] && NEXT=0
  if [ "$NOW" -ge "$NEXT" ]; then
    # lock atomico (mkdir): con piu' terminali che renderizzano insieme, un solo
    # processo acquisisce e chiama; gli altri saltano. Il background rilascia il
    # lock a fine chiamata. Rimuovo prima un lock stantio (processo morto, >60s).
    LOCK="$CACHE/.lock"
    [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$LOCK" 2>/dev/null
    if command mkdir "$LOCK" 2>/dev/null; then
    printf '%s' "$((NOW + 15))" > "$UF.next" 2>/dev/null
    ( UF="$UF" CREDS="$CREDS" USAGE_TIMEOUT="${USAGE_API_TIMEOUT:-5}" python3 - >/dev/null 2>&1 <<'PY'
import os, json, time, datetime, urllib.request, urllib.error
uf = os.environ["UF"]; creds = os.environ["CREDS"]
now = int(time.time())
try: timeout = float(os.environ.get("USAGE_TIMEOUT") or 5)
except Exception: timeout = 5

def set_next(ttl):
    try:
        with open(uf + ".next", "w") as f:
            f.write(str(now + int(ttl)))
    except Exception:
        pass

try:
    o = json.load(open(creds)).get("claudeAiOauth", {})
    tok = o.get("accessToken")
    if not tok:
        set_next(60); raise SystemExit
    req = urllib.request.Request(
        "https://api.anthropic.com/api/oauth/usage",
        headers={"Authorization": f"Bearer {tok}", "anthropic-beta": "oauth-2025-04-20"})
    r = json.load(urllib.request.urlopen(req, timeout=timeout))
    parts = []  # RAW, una per riga; i colori li mette bash al render
    fh = r.get("five_hour") or {}
    if fh.get("utilization") is not None:
        parts.append(f"5h ({round(fh['utilization'])}%)")
        ra = fh.get("resets_at")
        if ra:
            try:
                t = datetime.datetime.fromisoformat(str(ra).replace("Z", "+00:00"))
                mins = int((t - datetime.datetime.now(datetime.timezone.utc)).total_seconds() // 60)
                if mins > 0:
                    parts.append(f"⏳ {mins//60}h{mins%60:02d}m")
            except Exception:
                pass
    sd = r.get("seven_day") or {}
    if sd.get("utilization") is not None:
        parts.append(f"7d ({round(sd['utilization'])}%)")
    out = "\n".join(parts)
    if out:
        with open(uf + ".tmp", "w") as f:
            f.write(out)
        os.replace(uf + ".tmp", uf)
    set_next(180)                       # success: 3 min (come ccstatusline)
except urllib.error.HTTPError as e:
    if e.code == 429:                   # rate limit: Retry-After (>0) o default 300s
        ra = e.headers.get("Retry-After") if e.headers else None
        ttl = 300
        try:
            v = int(str(ra).strip())
            if v > 0: ttl = v
        except Exception:
            pass
        set_next(ttl)
    else:
        set_next(30)                    # altri errori HTTP
except SystemExit:
    pass
except Exception:
    set_next(30)                        # timeout / rete / parse
PY
      rmdir "$LOCK" 2>/dev/null
    ) >/dev/null 2>&1 &
    fi
  fi
fi

# --- colora le parti dell'usage al render (cache RAW -> segmenti colorati) ---
USAGE=""
if [ -n "$USAGE_RAW" ]; then
  while IFS= read -r part; do
    [ -z "$part" ] && continue
    case "$part" in
      "5h "*)  c="$C_5H" ;;
      "⏳"*)   c="$C_RESET" ;;
      "7d "*)  c="$C_7D" ;;
      *)       c="" ;;
    esac
    if [ -z "$USAGE" ]; then
      USAGE="${c}${part}${C_RST}"
    else
      USAGE="${USAGE}${C_SEP} | ${C_RST}${c}${part}${C_RST}"
    fi
  done <<< "$USAGE_RAW"
fi

# --- output ---
if [ "$MODE" = "--ticket-only" ]; then
  printf '%s\n' "$TICKET"; exit 0
fi
if [ "$MODE" = "--context-only" ]; then
  printf '%s\n' "$CTX"; exit 0
fi
if [ "$MODE" = "--usage-only" ]; then
  printf '%s\n' "$USAGE"; exit 0
fi

SEP="${C_SEP} | ${C_RST}"

# riga 1: modello | progetto | branch | usage | contesto
OUT="${C_MODEL}${MODEL}${C_RST}"
[ -n "$PROJ" ]   && OUT="${OUT}${SEP}${C_PROJ}${PROJ}${C_RST}"
[ -n "$BRANCH" ] && OUT="${OUT}${SEP}${C_BRANCH}${BRANCH}${C_RST}"
[ -n "$USAGE" ]  && OUT="${OUT}${SEP}${USAGE}"
[ -n "$CTX" ]    && OUT="${OUT}${SEP}${C_CTX}${CTX}${C_RST}"
printf '%s\n' "$OUT"

# riga 2: ticket / operazione trailhead in corso (solo se presente)
if [ -n "$TICKET" ]; then
  # larghezza terminale, per non far wrappare la riga 2 (STATUSLINE_COLS la forza).
  # Un valore assente/0/troppo piccolo e' considerato "sconosciuto" -> provo il metodo dopo.
  valid_cols() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; [ "$1" -ge 10 ]; }
  COLS="${STATUSLINE_COLS:-${COLUMNS:-}}"
  valid_cols "$COLS" || COLS="$(tput cols 2>/dev/null)"
  valid_cols "$COLS" || COLS="$(stty size 2>/dev/null </dev/tty | awk '{print $2}')"
  valid_cols "$COLS" || COLS=0
  L2="▸ ${TICKET}"
  # taglio a COLS-1 (margine per emoji a doppia cella), aggiungendo l'ellissi
  if [ "$COLS" -gt 3 ] 2>/dev/null && [ "${#L2}" -gt "$((COLS-1))" ]; then
    L2="${L2:0:$((COLS-2))}…"
  fi
  printf '%s\n' "${C_TICKET}${L2}${C_RST}"
fi

# exit 0 sempre: Claude Code scarta l'output della statusline se l'exit non e' 0
exit 0
