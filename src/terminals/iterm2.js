// iTerm2 connector (AppleScript via osascript).
// listPanes: every session with its tty. typeLine: `write text` on the session, found by tty.
// Focus: `write text` targets the session directly and does not select the tab or raise the window.
// The app is addressed by bundle id so the script never depends on the app name.
import { appRunning, listViaOsa, typeViaOsa, ttyAtShell } from './applescript.js';

const APP = 'iTerm2';
const ID = 'com.googlecode.iterm2';

const LIST = `
set US to character id 31
set out to ""
tell application id "${ID}"
  repeat with w in windows
    set wid to id of w
    repeat with t in tabs of w
      repeat with s in sessions of t
        set nm to ""
        try
          set nm to name of s
        end try
        set out to out & wid & US & (tty of s) & US & "" & US & nm & linefeed
      end repeat
    end repeat
  end repeat
end tell
return out`;

const TYPE = `
on run argv
  set wantTty to item 1 of argv
  set txt to item 2 of argv
  tell application id "${ID}"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is wantTty then
            tell s to write text txt
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

export default {
  name: 'iterm2',
  canType: true,

  available({ run, env = process.env } = {}) { return appRunning('iTerm2', { run, env }); },

  listPanes({ run, env = process.env } = {}) { return listViaOsa(APP, 'iterm2', LIST, { run, env }); },

  atShell(pane, { run, env = process.env } = {}) { return ttyAtShell(pane.tty, { run, env }); },

  typeLine(pane, text, { run, env = process.env } = {}) { return typeViaOsa(APP, TYPE, pane, text, { run, env }); },
};
