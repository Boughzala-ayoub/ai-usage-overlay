# Worth adding

From the audit of 2026-11-09. None of these is built. Each says what is missing, why it matters and
roughly how big the change is. The README's "Not built yet" list is separate and still stands.

## Start with Windows

Nothing launches the overlay at login: no Run key, no Startup shortcut, no scheduled task. After a
reboot the phone has no PC to read, and Keep PC awake is off, until you open the overlay by hand.
A tray checkbox on `app.setLoginItemSettings({ openAtLogin })` is about six lines in `main.js`.

## Reload on renderer crash

The window has no `render-process-gone` handler. A crashed renderer leaves a blank, click-through
window until you quit from the tray and start again. `win.webContents.on('render-process-gone',
() => win.reload())` is one line: the page asks for its data again as it loads, and
`did-finish-load` already re-sends the layout, reveal and open state.

## Origin check on `POST /api/usage`

Any web page open on this PC can send that POST without a preflight, and each one forces a read of
every provider. A page that loops it burns Claude's `/usage` budget until the 429 gate closes.
`/api/settings` is already safe, because it takes JSON only. Reject a request whose `Origin` header
is present and differs from its `Host`. The bubble's page loads from `http://localhost:7430`, so
its own requests pass.

## One command for every check

`npm test` runs only `test.js`. `npm run test:ui`, `node phone/check.mjs` and
`node phone/link-check.mjs offline` are separate, which is how the flaky phone check went
unnoticed. A `check` script in `package.json` that runs all four is one line.

## Stale user agent

`providers.js` sends `User-Agent: claude-cli/2.1.280` to Claude's `/usage`. Claude Code on this PC
was 2.1.319 on the day of the audit. The endpoint throttles unknown clients first, so a version
that falls far behind may start to count as one. Bump the string, or read the installed version
once at startup.

## Stop the phone's stream while its screen is off

The bubble keeps its event stream open all day and hears from the PC every 15 s while CPU or RAM
is on, screen lit or not. The battery cost is not measured. If it shows up in Android's battery
stats, a screen-off receiver in `Bubble.java` can close the stream and stop the minute's read, and
a screen-on one can start them again.

## Async safeStorage, before Electron 46

Electron 45 marks `safeStorage.encryptString` and `decryptString` as deprecated, and prints a
warning for each at startup. The overlay uses both for the Console session key, in `loadState` and
`pasteConsoleKey` in `main.js`. The async versions change the startup order, since the key has to
be decrypted before the first Claude read. Check that a key sealed by the sync call still opens
with `decryptStringAsync`, or the saved key is lost on upgrade and has to be pasted again.

## Left alone on purpose

Not proposals. Listed so the next audit doesn't hand them back.

- No pairing token on the phone server. The tailnet is the lock, as the README says.
- The overlay never renews Claude's token, so it never writes Claude's credentials (decided
  2026-10-12). The cost is a blank Claude chip when the token lapses while Claude Code is idle.
- The panel code is copied between `index.html` and `bubble.html`, and `Link.java` is copied into
  Loom's Android app.
- Encrypting the phone link's pipe. The audit's relay finding is closed by keeping the secret off
  the pipe. A relay on a hostile network can still read the usage numbers and change the shared
  settings while it lasts.
