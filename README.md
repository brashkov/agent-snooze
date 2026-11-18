# agent-snooze

Close idle Claude Code and Codex CLI sessions to free RAM, and leave each terminal tab on a 💤 prompt. Press Enter and the same conversation comes back.

```
$ agent-snooze
DRY WOULD-SNOOZE claude pid 48121 3f9c2a1e [tmux %4 "api:0.1"] idle 4.2d mem 190MB park=tmux
DRY WOULD-SNOOZE codex pid 51210 7d3e9b02 [iterm2 /dev/ttys012 "web"] idle 6.0d mem 175MB park=iterm2
DRY SKIP claude pid 50733 9a01bc7d [kitty 3 "docs"] idle 0.1d: active (idle 0.1d < 3d)
DRY dry run: 2 of 3 would be snoozed (add --apply)
```

## The problem

AI coding agents are long-lived terminal programs. You open one per task, move on, and the old tabs keep running. Each idle Claude Code or Codex session holds roughly 100 to 250 MB of RAM. One real machine had **51 forgotten sessions using about 6 GB**.

Closing them by hand means hunting for the right tabs and remembering each session id to resume later. agent-snooze does both for you, and keeps the tab where it was.

## Quick start

Needs Node.js 20 or newer. Tested on macOS.

```sh
npm i -g agent-snooze

agent-snooze               # dry run: lists what it would snooze, changes nothing
agent-snooze --apply       # snooze sessions idle for 3+ days
```

Later, go back to a sleeping tab:

```
💤 api refactor (claude) is asleep (idle 4d). Press Enter to resume.
```

Press **Enter**. The agent starts again with `claude --resume <id>` (or `codex resume <id>`) in the same folder.

If your terminal is not supported, the tab shows a 💤 message instead. Run this in that tab:

```sh
agent-snooze wake
```

You can try it without installing (`npx agent-snooze`), but install it globally before `--apply`: sleeping tabs call agent-snooze back later, and the npx cache can be cleaned by then. The tool warns you about this.

## How it works

```
 find sessions          check idle             skip busy
 (claude, codex)  --->  newest message   --->  working, running a
 pid, session id,       in the transcript      command, using CPU,
 tab                    older than --days      or the tab you are in
                                                     |
                                                     v
 Enter in the tab  <--- park the tab      <---  close gracefully
 resumes the same       💤 prompt waits         SIGTERM, wait up
 conversation           in the shell           to 60 s for exit
```

1. **Find.** Read the process list, match each agent process to its session id (Claude's session files, Codex's open rollout file) and to the terminal tab that owns it.
2. **Check idle.** Idle time is the timestamp of the newest message in the session transcript. File modification times are not used: they change for unrelated reasons.
3. **Skip busy.** A session is left alone if the agent reports a turn in progress, a shell command is running under it, it is using CPU, or it is the session that started agent-snooze.
4. **Close gracefully.** Send SIGTERM, the same signal as closing the tab, and wait up to 60 seconds for a clean exit. Never SIGKILL.
5. **Park the tab.** Type a small line into the tab's shell that prints the 💤 message and waits with `read`. Only the shell stays in memory, about 1 MB.
6. **Resume.** Enter runs the agent's own resume command in the original folder. The conversation, history and context are the agent's own files, untouched.

Every action is logged to `~/.agent-snooze/agent-snooze.log`.

## Safety

- **Dry run by default.** Nothing changes without `--apply`.
- **Never the calling session.** The agent session that runs agent-snooze, and anything in the same tab, is always skipped.
- **Busy sessions are skipped**, and each one is checked again right before it is closed.
- **Nothing is deleted.** Transcripts stay where the agent keeps them. agent-snooze only closes the process and remembers how to resume it.
- **`--only`** limits a run to one pid, pane id or session id prefix.
- If a process does not exit within 60 seconds, it is left alone and the failure is logged.

## Supported agents and terminals

| Agent | Status |
|---|---|
| Claude Code | Full |
| Codex CLI | Full |
| Gemini CLI | Planned |

| Terminal | Status | Notes |
|---|---|---|
| tmux | Full | |
| Herdr | Full | |
| iTerm2 | Full | macOS asks once for Automation permission |
| Terminal.app | Full | macOS asks once for Automation permission |
| Kitty | Full | Needs remote control, see below |
| WezTerm | Full | Uses the running GUI's socket |
| cmux | Experimental, off by default | Set `AGENT_SNOOZE_EXPERIMENTAL_CMUX=1` |
| Anything else | Fallback | 💤 message in the tab, then run `agent-snooze wake` |

"Full" means the 💤 prompt appears in the tab by itself and Enter resumes.

**Kitty setup.** Add to `kitty.conf` and restart Kitty:

```
allow_remote_control yes
listen_on unix:/tmp/kitty-snooze.sock
```

Any socket in `/tmp` whose name starts with `kitty` is found. You can also point to one with `AGENT_SNOOZE_KITTY_SOCKET`.

## Shell hook (optional)

The hook makes every new shell check for a sleeping session on its tab and show the prompt itself. It works in any terminal, including unsupported ones. Add one line to your shell config:

```sh
# ~/.zshrc
eval "$(agent-snooze init zsh)"

# ~/.bashrc
eval "$(agent-snooze init bash)"

# ~/.config/fish/config.fish
agent-snooze init fish | source
```

The check before each prompt is a plain file test. It starts no process.

## Commands

| Command | What it does |
|---|---|
| `agent-snooze` | Dry run: list sessions and what would happen |
| `agent-snooze --apply` | Snooze idle sessions |
| `agent-snooze wake` | Resume the session parked on this terminal |
| `agent-snooze list` | Show all parked sessions and their resume commands |
| `agent-snooze init zsh\|bash\|fish` | Print the shell hook |

| Option | Default | Meaning |
|---|---|---|
| `--days N` | 3 | Idle threshold in days. `0` means any idle session |
| `--only X` | | One pid, pane id (tmux `%3`, Herdr `t5`) or session id prefix |
| `--apply` | off | Actually close and park |

| Environment variable | Meaning |
|---|---|
| `AGENT_SNOOZE_HOME` | State folder (default `~/.agent-snooze`) |
| `AGENT_SNOOZE_KITTY_SOCKET` | Kitty remote-control socket |
| `AGENT_SNOOZE_EXPERIMENTAL_CMUX=1` | Turn on the cmux connector |

## Running it on a schedule

Optional. Run a dry run by hand first and check the list.

**cron** (every day at 03:00):

```
0 3 * * * /usr/local/bin/agent-snooze --apply --days 3 >/dev/null 2>&1
```

**macOS LaunchAgent**, saved as `~/Library/LaunchAgents/dev.agent-snooze.plist`, then `launchctl load ~/Library/LaunchAgents/dev.agent-snooze.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.agent-snooze</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/agent-snooze</string>
    <string>--apply</string>
    <string>--days</string><string>3</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
```

Use the path from `which agent-snooze`. In a scheduled run, iTerm2 and Terminal.app need the Automation permission granted to the scheduler, and cmux is not reachable, so those tabs get the fallback message.

## FAQ

**Does it lose my conversation?**
No. The agent saves every conversation to disk as it goes. agent-snooze closes the process and later runs the agent's own resume command (`claude --resume <id>`, `codex resume <id>`) on that saved conversation.

**How much RAM does a sleeping tab use?**
About 1 MB: just the shell, waiting on `read`. No Node process stays behind.

**What if I press Ctrl-C at the 💤 prompt?**
You get a normal shell. Run `agent-snooze wake` in that tab to resume later. With the shell hook, Ctrl-C dismisses the prompt for good; the conversation is still on disk, and the agent's own resume picker (`claude --resume`, `codex resume`) finds it.

**What if I closed the tab?**
The conversation is still saved. Resume it with the agent's own command, for example `claude --resume`.

**Does it work on Linux?**
The code is not macOS-specific for tmux, Kitty and WezTerm, but it has only been tested on macOS so far. Reports are welcome.

## Roadmap

- Gemini CLI adapter
- cmux on by default (needs a reliable live test)
- Konsole connector (Linux)
- VS Code integrated terminal

## Contributing

Issues and pull requests are welcome. Run the tests with `npm test` (Node's built-in runner, no dependencies).

Most additions are one file:

- **A new agent** goes in `src/agents/<name>.js`. It finds the agent's processes and session ids, reports the last activity time and a busy signal, and returns the resume command. The interface is documented at the top of `src/agents/index.js`; `claude.js` and `codex.js` are examples.
- **A new terminal** goes in `src/terminals/<name>.js`. It lists panes with their tty or pid, says whether a pane is back at a shell, and types a line into a pane without stealing focus. The interface is documented at the top of `src/terminals/index.js`; `tmux.js` is the simplest example.

Register the new file in the matching `index.js` and add a parser test with a fixture in `test/fixtures/`. Fixtures must use made-up names, paths and ids.

### Development

```sh
git clone https://github.com/brashkov/agent-snooze.git
cd agent-snooze
npm test
node bin/agent-snooze.js            # dry run from the checkout
```

`package.json` has `"private": true` until the first public release, so `npm publish` is blocked by design for now.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with Anthropic or OpenAI. Claude Code and Codex are their respective owners' products.
