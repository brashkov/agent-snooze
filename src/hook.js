// `agent-snooze init zsh|bash|fish` prints a snippet for the shell rc file.
// On load it records "<shell pid>" in <state>/hooks/<ttykey>; before each prompt it checks for
// <state>/parked/<ttykey>.json (a plain file test, no process spawned) and runs `wake --emit` if found.
// `wake --emit --lazy` prints a line that waits with shell builtins (printf + read) and only then starts Node,
// so the waiting prompt costs no memory. _agent_snooze_ask marks "prompt shown"; if Ctrl-C aborts the wait,
// the next prompt sees the mark and dismisses the parked record instead of asking again.
import { selfCommand } from './park.js';

export function initSnippet(shell, { cmd = selfCommand() } = {}) {
  const dir = '${AGENT_SNOOZE_HOME:-$HOME/.agent-snooze}';
  switch (shell) {
    case 'zsh':
      return `# agent-snooze: show the wake prompt in terminals with a snoozed agent session
_agent_snooze_dir="${dir}"
_agent_snooze_tty=$(tty 2>/dev/null) && _agent_snooze_key=\${_agent_snooze_tty#/dev/} && _agent_snooze_key=\${_agent_snooze_key//\\//_}
[[ -n $_agent_snooze_key ]] && mkdir -p "$_agent_snooze_dir/hooks" && print -r -- $$ >| "$_agent_snooze_dir/hooks/$_agent_snooze_key"
_agent_snooze_precmd() {
  [[ -n $_agent_snooze_key ]] || return 0
  local f="$_agent_snooze_dir/parked/$_agent_snooze_key.json"
  if [[ -n $_agent_snooze_ask ]]; then _agent_snooze_ask=; rm -f "$f"; return 0; fi
  [[ -f $f ]] || return 0
  _agent_snooze_ask=1
  eval "$(${cmd} wake --emit --lazy --tty "$_agent_snooze_tty")"
  _agent_snooze_ask=
  return 0
}
autoload -Uz add-zsh-hook && add-zsh-hook precmd _agent_snooze_precmd
`;
    case 'bash':
      return `# agent-snooze: show the wake prompt in terminals with a snoozed agent session
_agent_snooze_dir="${dir}"
_agent_snooze_tty=$(tty 2>/dev/null) && _agent_snooze_key=\${_agent_snooze_tty#/dev/} && _agent_snooze_key=\${_agent_snooze_key//\\//_}
[ -n "$_agent_snooze_key" ] && mkdir -p "$_agent_snooze_dir/hooks" && echo $$ > "$_agent_snooze_dir/hooks/$_agent_snooze_key"
_agent_snooze_precmd() {
  [ -n "$_agent_snooze_key" ] || return 0
  local f="$_agent_snooze_dir/parked/$_agent_snooze_key.json"
  if [ -n "$_agent_snooze_ask" ]; then _agent_snooze_ask=; rm -f "$f"; return 0; fi
  [ -f "$f" ] || return 0
  _agent_snooze_ask=1
  eval "$(${cmd} wake --emit --lazy --tty "$_agent_snooze_tty")"
  _agent_snooze_ask=
  return 0
}
case ";$PROMPT_COMMAND;" in *";_agent_snooze_precmd;"*) ;; *) PROMPT_COMMAND="_agent_snooze_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";; esac
`;
    case 'fish':
      return `# agent-snooze: show the wake prompt in terminals with a snoozed agent session
set -g _agent_snooze_dir (set -q AGENT_SNOOZE_HOME; and echo $AGENT_SNOOZE_HOME; or echo $HOME/.agent-snooze)
set -g _agent_snooze_tty (tty 2>/dev/null)
set -g _agent_snooze_key (string replace -r '^/dev/' '' -- $_agent_snooze_tty | string replace -a / _)
if test -n "$_agent_snooze_key"; and test "$_agent_snooze_key" != "not a tty"
  mkdir -p $_agent_snooze_dir/hooks; and echo $fish_pid > $_agent_snooze_dir/hooks/$_agent_snooze_key
end
function _agent_snooze_precmd --on-event fish_prompt
  test -n "$_agent_snooze_key"; or return 0
  set -l f $_agent_snooze_dir/parked/$_agent_snooze_key.json
  if set -q _agent_snooze_ask; and test -n "$_agent_snooze_ask"
    set -g _agent_snooze_ask ""; rm -f $f; return 0
  end
  test -f $f; or return 0
  set -g _agent_snooze_ask 1
  eval (${cmd} wake --emit --lazy --shell fish --tty $_agent_snooze_tty)
  set -g _agent_snooze_ask ""
end
`;
    default:
      return null;
  }
}
