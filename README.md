# AI usage overlay v3

A few numbers floating just off a screen edge, with no box behind them. For each AI subscription
there is the provider's mark, its usage and a thin bar filled to that percentage. A thin outline in
the theme's background colour keeps them readable on any wallpaper or window. Hover them and a
panel grows out with its own surface: a compact table of every provider and every limit, with
what's used and when it resets. Drag the numbers to any edge of any monitor. The rest of the window
is transparent and click-through, so the overlay never eats a click meant for whatever is under it.

```
npm install
node node_modules/electron/install.js   # npm 11 blocks postinstall scripts; this fetches the binary
npm start
npm test                                # pure-logic checks, no electron, no network
npm run test:ui                         # the renderer in headless Chrome, every edge, state and theme
npm run build                           # dist\AIUsageOverlayV3-Setup-3.0.0.exe
```

## v3 beside v2

v3 is its own app, not an upgrade. It installs as `AI Usage Overlay v3` from
`AIUsageOverlayV3-Setup-<version>.exe`, with app id `com.local.ai-usage-overlay-v3`, its own install
folder and its own settings in `%APPDATA%\ai-usage-overlay-v3`, so installing or removing it leaves
v2 as it was. On its first save it copies v2's `state.json` (edge, theme, size, providers, last
readings, rate-limit gate) and never writes to v2's file.

While both run, both poll the endpoints, and whichever started first owns Ctrl+Alt+U. The v3 tray
icon is three level rows, so you can tell the two apart.

## Providers

| Provider | Where the numbers come from | Fresh every |
|---|---|---|
| Claude | `~/.claude/.credentials.json` then `api.anthropic.com/api/oauth/usage` | 5 min |
| Codex | `~/.codex/auth.json` then the ChatGPT usage endpoint | 5 min |
| OpenCode Go | `~/.local/share/opencode/auth.json` (or `OPENCODE_API_KEY`) then `opencode.ai/zen/go/v1/usage` | 5 min |

Codex uses only `~/.codex/auth.json` for login and re-reads it on every refresh. If the request
fails, the overlay reads the newest rollout across `CODEX_HOME`, Orca's runtime home, and
`~/.codex`.

Claude re-reads the credentials file on every refresh instead of holding the token, because Claude
Code rotates it in place.

OpenCode Go reports three rolling windows, 5-hour, weekly and monthly, as percentages of the plan's
dollar caps. The key is the same one `opencode` sends with every Go request.

Adding a fourth provider is one entry in `PROVIDERS` at the bottom of `providers.js` plus its `read()`.
Return `{ plan, rows: [{ label, percent, resetsAt }], error }` and its chip, its section in the
panel, the tray checkbox and the window size all follow. Give it a usage page in `USAGE_PAGES` in
`main.js` if it has one.

## Rate limits

`/usage` throttles, and a 429 used to make the overlay look broken: the numbers stopped moving and
Refresh appeared to do nothing. Three things fix that.

The 429's `Retry-After` becomes a per-provider gate in `readOne`, and the gate blocks the manual
Refresh too. Refusing locally is the only thing that actually keeps us off the endpoint, since a
button that fires a doomed request every click is what earns the next 429.

The gate and the last good reading both persist to `state.json`, so a restart paints real numbers
immediately and does not re-hammer an endpoint that already said no.

That provider's section says `Rate limited, retry in 47s`. Refresh still asks the other providers,
and turns itself off only when every provider is gated. Nothing is hidden and nothing is silently
dropped.

The request also carries `User-Agent: claude-code/2.1.0`, which is what Claude Code and Orca both
send. Orca's other trick, a hidden pty that runs `claude`, sends `/usage` and scrapes the TUI, is
several hundred lines of terminal parsing. Not worth it here.

## Moving it

Drag the chips. The capsule closes to a pill, the window follows the cursor, and on release it snaps
to the nearest edge of whichever display it ended up on, remembering the edge, the display and how
far along that edge it sat. On a left or right edge the chips stack in a column and the panel opens
beside them. On the top or bottom edge they sit in a row and the panel opens below or above. The
chips stay where they are while the capsule grows around them. `Reset position` in the tray menu
puts the capsule back on the right of the primary display.

## Controls

- Right-click the capsule, or click the tray icon, for the menu.
- `Providers` in that menu has a checkbox per provider. Unchecking one drops its chip and its section.
- Ctrl+Alt+U hides and shows the overlay. Hidden means hidden: no polling, no requests.
- `Size` sets how much room the pill takes on the edge, from Small to Extra large. The open panel
  never shrinks below Large, because at Small its reset times would be 7px; it only grows, at Extra
  large. Both are CSS `zoom` on their own element, and main sizes the window from the two.
- A chip reads the highest of that provider's limits, since that one stops you first. `Summary
  shows` picks a specific limit instead, for Claude and OpenCode Go.
- Every reading, in the pill or the panel, is a number with a thin bar filled to the percentage.
  Both turn amber at 75% and red at 90%, and a chip's bar pulses above 90%.
- The panel opens after the cursor rests on the capsule for 120ms, so running the mouse along the
  edge to reach a scrollbar doesn't pop it. It closes 420ms after the cursor leaves.
- The panel is a table with one line per limit: name, bar, percentage, and time to reset (`in 3h
  39m`, `in 2d 4h`), with the columns lined up across every provider. Limits at 0% dim, so the ones
  in use read first, and the numbers count up with their bars as the panel opens.
- Banked resets are one line under their provider: `4 banked resets expire Oct 4, 5, 22 and 29`.
  At zero the line is left out.
- A provider says so in its own section when it is rate limited (in amber), erroring (in red, with
  any command set as code), showing a fallback, or more than ten minutes stale. The two icons in the
  footer refresh and open the same menu as right-click.
- When a limit resets, the capsule beeps and opens for six seconds to say which one. Hovering it
  swaps the notice for the full panel.
- With Auto-hide on, the capsule slides away and leaves a lip on the edge: one small level per
  provider, pulsing above 90% and dim when there is no data. Hover the lip to bring it back.
- The type is Geist, bundled in `fonts/` under the SIL Open Font License (`fonts/OFL.txt`), so it
  looks the same on every machine.
- `Theme` offers 96 themes. Each one is a line of CSS custom properties in `themes.js`, which both
  the menu and the renderer read. The animated Showpiece themes also need their keyframes, which
  live at the bottom of `index.html`.

## Why main polls the cursor

`setIgnoreMouseEvents(true, { forward: true })` is the documented way to keep a click-through window
that still sees hovers. It does not work here. A window created with `focusable: false` and shown
with `showInactive()` never takes focus, and the forwarded moves never arrive, so the renderer can
never ask for the mouse back and every click falls through to the desktop. That was the original
"Refresh does nothing" bug, and a synthetic `sendInputEvent` will not reproduce it, because it
injects straight into Chromium and skips the OS path entirely.

So main polls `screen.getCursorScreenPoint()` every 60ms instead, which needs no window input at
all. It hit-tests against rects the renderer measures and reports, then toggles
`setIgnoreMouseEvents` and tells the renderer when to open. The renderer owns no mouse logic
beyond mousedown and mouseup for dragging. The same poll drives the drag, so moving the capsule
came almost for free.

## Verifying a change

`--shot=<file>` launches the app, waits for the first data, writes a PNG of the window and quits.
Put `hover` in the filename and it opens the panel before the capture.

`npm run test:ui` loads `index.html` in headless Chrome with a fake `window.api` and runs every state
(loading, error, rate limited, banked resets, a reset notice, a long panel) on all four edges. It
covers widths from 320 to 1280 plus the two native window sizes, and every theme hidden, at rest,
open and mid-notice. It fails on horizontal scroll, anything outside the window, or text overflowing
the panel. A second pass runs the real animations and fails if the chips move while the capsule
grows or shrinks, or if Small shrinks anything but the pill. Screenshots land in `%TEMP%\ai-usage-overlay-ui`.

```
node_modules\electron\dist\electron.exe . --shot=%TEMP%\hover.png
```

Real input is worth driving from PowerShell (`SetCursorPos` plus `mouse_event`) when you touch the
hover or drag paths, since that is the only way to test the parts Chromium does not own.

## Not built yet

Drag to reorder the chips, more than one account per provider, and any provider whose usage is not
already on disk. Copilot's quota needs a live call to `api.github.com/copilot_internal/user`, and
Cursor's needs a pasted session cookie.
