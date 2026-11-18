// macOS Terminal.app connector (AppleScript via osascript).
// listPanes: every tab with its tty. typeLine: `do script "<text>" in <tab>`, which types into the tab as input.
// Tabs are found by tty each time (tab/window indexes shift), and the text travels as argv so it needs no escaping.
// Terminal's own `busy` flag is true whenever ANY foreground process runs (claude itself), so it is not used;
// busy detection comes from the agent adapter (pidfile status, CPU).
// Focus: `do script ... in <tab>` does not activate Terminal nor select the tab (verified live, see PROGRESS.md).
import { appRunning, listViaOsa, typeViaOsa, ttyAtShell } from './applescript.js';

const APP = 'Terminal';

const LIST = `
set US to character id 31
set out to ""
tell application "${APP}"
  repeat with w in windows
    set wid to id of w
    repeat with t in tabs of w
      set ttl to ""
      try
        set ttl to custom title of t
      end try
      set out to out & wid & US & (tty of t) & US & "" & US & ttl & linefeed
    end repeat
  end repeat
end tell
return out`;

const TYPE = `
on run argv
  set wantTty to item 1 of argv
  set txt to item 2 of argv
  tell application "${APP}"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is wantTty then
          do script txt in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

export default {
  name: 'terminal-app',
  canType: true,

  available({ run, env = process.env } = {}) { return appRunning('Terminal', { run, env }); },

  listPanes({ run, env = process.env } = {}) { return listViaOsa(APP, 'terminal-app', LIST, { run, env }); },

  atShell(pane, { run, env = process.env } = {}) { return ttyAtShell(pane.tty, { run, env }); },

  typeLine(pane, text, { run, env = process.env } = {}) { return typeViaOsa(APP, TYPE, pane, text, { run, env }); },
};
