#!/bin/bash
# Live cmux test. Run it FROM INSIDE a cmux tab: cmux only accepts commands from its own tabs.
# It creates its own throwaway workspace and touches nothing else (always --only <test pid>).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SNOOZE="node $ROOT/bin/agent-snooze.js"
CM="$(command -v cmux || echo /Applications/cmux.app/Contents/Resources/bin/cmux)"
DIR="$ROOT/.tmp-cmux-test-$$"   # inside an already-trusted folder, so Claude skips the trust screen
ok()   { echo "  ✅ $*"; }
fail() { echo "  ❌ $*"; cleanup; exit 1; }
cleanup() { [ -n "${WS:-}" ] && "$CM" close-workspace --workspace "$WS" >/dev/null 2>&1; rm -rf "$DIR"; }
pid_in_dir() { for p in $(pgrep -x claude); do
  [ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$DIR" ] && echo "$p"; done | tail -1; }
sid_of() { python3 -c "import json;print(json.load(open('$HOME/.claude/sessions/$1.json'))['sessionId'])" 2>/dev/null; }
status_of() { python3 -c "import json;print(json.load(open('$HOME/.claude/sessions/$1.json')).get('status',''))" 2>/dev/null; }

[ -n "${CMUX_SURFACE_ID:-}${CMUX_WORKSPACE_ID:-}" ] || { echo "Run this inside a cmux tab."; exit 1; }
mkdir -p "$DIR"; DIR="$(cd "$DIR" && pwd -P)"
trap 'echo; echo "Interrupted"; cleanup; exit 1' INT
echo "1. Starting a throwaway Claude in a new cmux workspace..."
OUT=$("$CM" new-workspace --name "snooze-test" --cwd "$DIR" --focus false \
  --command "unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT; claude 'say hi in 3 words'" 2>&1)
WS=$(echo "$OUT" | grep -oE 'workspace:[0-9]+|[0-9A-Fa-f-]{36}' | head -1)
[ -n "$WS" ] || fail "could not create workspace: $OUT"
ok "workspace $WS"

for _ in $(seq 1 45); do PID=$(pid_in_dir); [ -n "$PID" ] && break; sleep 2; done
[ -n "${PID:-}" ] || { echo "  screen of the test tab:"; "$CM" read-screen --workspace "$WS" --lines 20 2>&1 | sed 's/^/    | /'; fail "claude did not start"; }
for _ in $(seq 1 15); do [ -f "$HOME/.claude/sessions/$PID.json" ] && break; sleep 2; done
[ -f "$HOME/.claude/sessions/$PID.json" ] || { echo "  screen of the test tab:"; "$CM" read-screen --workspace "$WS" --lines 20 2>&1 | sed 's/^/    | /'; fail "claude $PID wrote no session file"; }
for _ in $(seq 1 45); do [ "$(status_of "$PID")" = "idle" ] && break; sleep 2; done
SID=$(sid_of "$PID"); ok "claude pid $PID, session $SID, status $(status_of "$PID")"

echo "2. Dry run:"; $SNOOZE --days 0 --only "$PID" 2>&1 | tail -3
echo "3. Snooze:";  $SNOOZE --days 0 --only "$PID" --apply 2>&1 | tail -3
sleep 3
kill -0 "$PID" 2>/dev/null && fail "pid $PID still alive" || ok "pid $PID closed"
"$CM" read-screen --workspace "$WS" --lines 15 2>/dev/null | grep -q "💤" && ok "💤 prompt on screen" || fail "no 💤 prompt on screen"

echo "4. Wake (Enter):"
"$CM" send-key --workspace "$WS" enter >/dev/null 2>&1
for _ in $(seq 1 30); do NEW=$(pid_in_dir); [ -n "$NEW" ] && [ "$NEW" != "$PID" ] && break; sleep 2; done
[ -n "${NEW:-}" ] && [ "$NEW" != "$PID" ] || fail "claude did not come back"
sleep 3; NSID=$(sid_of "$NEW")
[ "$NSID" = "$SID" ] && ok "resumed the SAME session $SID (pid $NEW)" || echo "  ⚠️ new pid $NEW has session $NSID (expected $SID; claude may fork the id on resume)"

echo "5. Cleanup"; kill "$NEW" 2>/dev/null; sleep 2; cleanup; ok "test workspace closed"
echo "DONE"
