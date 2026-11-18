# Changelog

## 0.1.0 (unreleased)

First version.

- Finds idle Claude Code and Codex CLI sessions; idle time comes from the newest message in the transcript.
- Skips busy sessions and the session running agent-snooze; dry run by default, `--apply` to act, `--only` to target one.
- Closes with SIGTERM and waits up to 60 seconds; never SIGKILL, never deletes transcripts.
- Parks the tab on a 💤 prompt that waits in the shell (about 1 MB); Enter resumes the same conversation.
- Terminal connectors: tmux, Herdr, iTerm2, Terminal.app, Kitty, WezTerm. cmux is experimental and off by default.
- Fallback for any other terminal: a 💤 message plus `agent-snooze wake`.
- Shell hook for zsh, bash and fish (`agent-snooze init`).
- Sleeping tabs call `agent-snooze` from PATH when installed globally; a run from the npx cache warns and recommends `npm i -g agent-snooze`.
