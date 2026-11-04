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
| xAI | `~/.grok/auth.json` then `cli-chat-proxy.grok.com/v1/billing` | 5 min |
| CPU, RAM | This PC, through Node's `os` module. No account, no request | 15 s |

Codex uses only `~/.codex/auth.json` for login and re-reads it on every refresh. If the request
fails, the overlay reads the rollouts across `CODEX_HOME`, Orca's runtime home, and `~/.codex`, and
takes the newest usage event by that event's own time. File times only order the search, since a new
message in an old session touches the file without new usage. The reading is dated by its event. If
it is older than the numbers already on screen, the newer numbers stay, with a note saying live
refresh failed, and the drop is not announced as a reset.

Claude re-reads the credentials file on every refresh instead of holding the token, because Claude
Code rotates it in place.

OpenCode Go reports three rolling windows, 5-hour, weekly and monthly, as percentages of the plan's
dollar caps. The key is the same one `opencode` sends with every Go request.

xAI is the SuperGrok allowance that Grok Build's `/usage` shows. The overlay asks Cursor for it
first, signed in with the Cursor CLI's token in `%APPDATA%\Cursor\auth.json`. On an account merged
with xAI, Cursor's weekly included usage is the same pool, with the same reset, and Cursor kept
answering while xAI's weekly lookup returned 500 for hours. With no Cursor sign-in, no merged plan,
or no answer from Cursor, the overlay reads xAI's own endpoints. The token is the one `grok` keeps in
`~/.grok/auth.json`, re-read on every refresh. `/billing?format=credits` gives the weekly percentage
and when it resets. `/billing` gives monthly credits, and the panel adds a Monthly line only when the
plan has a monthly limit. On xAI's unified weekly pool that limit is 0, so there is one line. `grok`
renews its six-hour token only while it runs, so once it has expired the overlay renews it with the
refresh token and writes the new tokens back to `auth.json` for `grok`. Only if xAI refuses the
refresh token does the xAI section say to run `grok`, with a dash on the chip. The endpoint is the CLI's own, not a public API. If its answer changes shape,
the section says no usage windows were reported. xAI's mark is monochrome, so on both screens it
takes the theme's text colour.

CPU and RAM are this PC, so the phone can see them too. CPU is the load across every core since the
last read, so the first read samples half a second. It is Windows' "% Processor Time", and Task
Manager shows "% Processor Utility", which can read higher while the CPU boosts. RAM is what Windows
doesn't count as available, as a percentage, with the GB in use where the reset time goes and the
total in the plan tag. Both are `local`: read at every tick, never saved for the next start, and a
fall in either is never announced as a reset. Turn them off under `Providers` like any other.

Adding a provider is one entry in `PROVIDERS` at the bottom of `providers.js` plus its `read()`.
Return `{ plan, rows: [{ label, percent, resetsAt }], error }` and its chip, its section in the
panel, the tray checkbox and the window size all follow. Give it a usage page in `USAGE_PAGES` in
`main.js` if it has one.

## Rate limits

Claude's `/usage` throttles hard, and nothing documents its limit. Every Claude Code session asks
the same endpoint with the same account, so they and the overlay share one budget. On a Max plan a
single request can draw a 429, and the overlay used to say `Rate limited, retry in 47s` for it.

The overlay asks the endpoint first, every five minutes, so its numbers are live whenever it
answers. It also does what Claude Code does for its own sessions. Claude Code keeps its last answer
in `~/.claude.json`, as `cachedUsageUtilization`, dated by `fetchedAtMs`. Its sessions share it:
one fetches, the others reuse it for a minute and, when the endpoint says no, fall back on it for up
to an hour. Between its own reads, and whenever the endpoint is throttling, the overlay reads that
copy too, at no request, and shows it when it is newer than its own reading.

The copy counts only for the account signed in now, by account id. One over an hour old, written
halfway, or changed in shape counts as no copy.

A copy's date need not hold for every line in it, so each line is judged on its own. A line from
the copy counts only when its reset time is still ahead. One from a period that has ended, or with
no reset time, never replaces a line on screen. A current line replaces one on screen that is
undated or whose period has ended. When both are current, a later reset time is a new period;
otherwise it is one period, where usage only climbs, so the higher number wins. A stale line can't
roll a number back, and a number only drops when its period does, which is announced as a reset.
A line not on screen yet joins only when its reset time is still ahead, or as a window not
started, at 0% with none. The reading takes the copy's
date, and an old failure note goes, only when the copy vouches for every line on screen: each one
moved to the copy's or agrees with it. A line the copy lacks or disputes may be stale, so then the
lines that moved land and the reading keeps its age and note.
Only the usage lines move: a line the copy lacks keeps its number, and the plan, the API credit and
the banked resets stay as the endpoint last gave them.

A 429's `Retry-After` becomes a per-provider gate in `readOne`. The gate blocks the manual Refresh
too, since a button that fires a doomed request every click earns the next 429. It persists to
`state.json` with the last good reading, so a restart paints real numbers at once and doesn't ask
an endpoint that already said no. Meanwhile the local sources keep the numbers moving. When the
gate lifts, the next tick reads the endpoint again rather than waiting out the rest of the five
minutes.

A rate limit is never shown, for any provider. The numbers on screen stay as they were, with no
note, and a section with no numbers yet waits for them. A provider more than ten minutes behind,
gated or not, says how old its numbers are, as it always did. Refresh still asks the other
providers, and turns itself off only when every provider is gated.

The request also carries `User-Agent: claude-cli/2.1.280 (external, cli)`, the one Claude Code
sends. Orca's other trick, a hidden pty that runs `claude`, sends `/usage` and scrapes the TUI, is
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
- Ctrl+Alt+U hides and shows the overlay. Hidden means no polling and no new requests. A request
  already under way still finishes and updates the numbers, but it can't beep or bring the overlay back.
- `Size` sets how much room the pill takes on the edge, from Small to Extra large. The open panel
  never shrinks below Large, because at Small its reset times would be 7px; it only grows, at Extra
  large. Both are CSS `zoom` on their own element, and main sizes the window from the two. On a top
  or bottom edge too narrow for a row of chips at that size, as six are at Extra large on a 600px
  portrait monitor, the pill shrinks to fit. The window is never bigger than its display, so on a short
  one the panel's rows scroll. A display that turns, rescales, or is unplugged or plugged back in puts
  the capsule back on its edge at once.
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
- A provider says so in its own section when it is erroring (in red, with any command set as
  code), showing a fallback, or more than ten minutes stale. A rate limit isn't shown (see Rate limits). The two icons in the
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

## Phone bubble

`phone/` is an Android app that floats a slim tab above every other app, docked on the screen's
edge. Per provider the tab shows its logo inside a ring that fills clockwise to the same number as
its chip on the PC, with the number under it. A ring turns amber at 75% and red at 90%, and pulses
when red. The logos are Claude's and OpenAI's from Simple Icons, OpenCode's from its favicon and
xAI's from LobeHub's icons. A provider without one keeps the PC's glyph. Drag the tab anywhere: it
lifts as a whole capsule, and on release it glides to the nearer side and the corners on that edge
square off as it docks, with a tick of the phone's vibration. Tap it and the panel pulls out of its
inner side, level with it, with every limit and reset. Tap anywhere outside the panel, or press
Back, to close it.

The `⋯` in the panel's footer opens the settings. The theme (all 96), which providers show, and which
limit each summary number reads are the PC's tray menu, shared both ways: change one on the phone
and the PC's overlay follows at once, and the other way round. The bubble's size (Small, Medium,
Large), hiding at the edge when idle, links to each usage page and Remove bubble are the phone's
own. Hidden at the edge, the tab slides off after 3 seconds untouched and leaves a 12dp lip with
one level per provider, as the PC's lip does; a tap on it brings the tab back.

The scissors in the footer snip part of the screen to the phone's clipboard, as Win+Shift+S does on
the PC. The panel and the tab get out of the way and the screen dims. Drag over what you want and
let go. The bubble hides its window, takes a screenshot, copies that rectangle as a PNG and docks
again with a short buzz. A tap instead of a drag, or Back, cancels. The screenshot comes from an
accessibility service, `Snipper.java`. It asks for no events and no window content, so the screenshot
for a snip is all it ever sees. Turn it on once under Settings, Accessibility, Installed apps, AI
Usage snipping. For a sideloaded app Android greys that switch out until you open App info, tap ⋮
and pick Allow restricted settings. Until the service is on, the scissors show a note with a button
for each screen. The clipboard gets a `content://com.local.aiusage.snips/` URI, which `Snips.java`
serves from the app's cache. The provider isn't exported, so only the app the clipboard hands the
snip to can read it. Each new snip deletes the ones older than a day.

The credentials never leave the PC. The overlay serves the phone on `127.0.0.1:7430`, and Tailscale
carries the port to the phone. Run this once and it survives reboots:

```
tailscale serve --bg --https=8443 http://127.0.0.1:7430
```

| Route | What it does |
|---|---|
| `GET /api/usage` | What the panel shows, the theme's colours, the shared settings, and the snapshot's `run` and `rev`. Reads what is due first, through `readOne`, so the phone obeys the same 5-minute floor and 429 gate as the PC. `POST` is the panel's Refresh. |
| `GET /api/events` | The same, as a stream: once on connecting, then on every change. CPU and RAM move at most every tick, so a phone hears at most every 15 s, or once a minute with both off. A `ping` event every 20 s lets the page replace a stream that died without closing. |
| `GET /api/options` | The tray menu's choices: themes, providers, summary limits, usage pages. |
| `POST /api/settings` | `{ theme, enabled, choices }`, any of them, applied as the tray menu applies them. JSON only. |

Requests for any host but loopback or a `*.ts.net` name get a 403. That stops a web page that points
its own domain at 127.0.0.1 from reading anything. Settings take `application/json` only, which a
form or a no-cors fetch from another page can't send without a CORS preflight that this server never
answers. There is no pairing token, unlike Loom's phone remote: anyone on your tailnet can read the
percentages and the PC's CPU and RAM, change the shared settings, and turn Keep PC awake on or off,
which keeps the PC from sleeping until it is turned off again. Nothing more.

After the PC has been on the phone's hotspot, the overlay watches Tailscale's tunnel to the phone
(`heal` in `link.js`). Tailscale on the PC can come back from the hotspot with a frozen session: the
phone answers `tailscale ping` through a relay, but `tailscale ping --tsmp` gets nothing, and the
bubble, Loom's phone app and Taildrop all stop. Frozen for 90 s, the overlay runs `tailscale down`
and then `tailscale up` with no flags, which keeps Tailscale's settings. It does this once per 10
minutes at most, never while the PC is still on the hotspot, and never while Tailscale is off,
unless the overlay turned it off itself. Until one of its ups works, it tries another every 15 s,
and quitting waits for one. `%LOCALAPPDATA%\phone-link\tailscale-down` stays until then, so after a
crash, a kill or a shutdown in between, the overlay's next start brings Tailscale back up.

```
node phone/build.mjs                       # phone\out\ai-usage-bubble.apk
node phone/check.mjs                       # bubble.html in headless Chrome against a stand-in PC
tailscale file cp phone/out/ai-usage-bubble.apk <phone>:
```

The build uses the bare SDK tools (aapt2, javac, d8, zipalign, apksigner), with no Gradle. It wants
a JDK 17+ and build-tools plus a platform under `%LOCALAPPDATA%\Android\Sdk`. It bakes the PC's
tailnet address in as the app's default and signs with `~/.android/debug.keystore`, so each new
build installs over the last.

On the phone, install the APK, open AI Usage, check the address and tap Show bubble. Android asks
once for "Display over other apps". A quiet notification keeps the bubble alive, and its Remove
button takes it away.

`bubble.html` is both states. Collapsed, `Bubble.java` sizes the window to the tab plus 12dp beside
it and above and below for the shadow (50x154 dp at Medium with three providers, 40.5 dp more
or less for each provider added or hidden; the page sends the size with `Android.size()`), and handles
every touch itself, so a drag never reaches the page. Where the screen between its bars is shorter than
the tab, as with six providers at Large in landscape, the page shrinks the tab to the room `Android.room()`
reports, and fits it again whenever the screen turns. It calls
`press()`, `lift()`, `dock(side)` and `peek()` as the finger and the idle timer move the tab. A tap
first tells the page where the window sits, then gives the window the whole screen. The page's
layout follows the window's width, so it can never draw the panel in the small window or the tab
alone in the big one. When the screen turns or the bubble's size changes with the panel open,
`Bubble.java` works out the tab's place again for the new screen, its insets and density, and sends it
with `anchor()`, so the tab stays flush with its edge and closing lands it there. Closing runs the
other way: the panel shrinks back into the tab, then the page calls `Android.collapse()`. The page keeps the last answer in localStorage. When the PC is off or
out of reach, the tab greys out and the panel says how old the numbers are. Every snapshot the overlay
sends carries `run`, an id for this run of the overlay, and `rev`, one higher than the last snapshot it
made. The page keeps the newest by `rev`, whichever way it came and in whatever order: a read snapshots
only after its provider answers, so it can be newer than a stream message that reached the phone first,
and an old answer landing late is dropped. A new `run` (the overlay restarted) wins whatever its
`rev`, and the run it replaced is retired, so a late snapshot from before the restart can't come back.
A snapshot without numbers counts as the oldest. A stream that got a 502 while the overlay was down starts
again on the next good read.

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
open and mid-notice, with all six providers. It fails on horizontal scroll, anything outside the
window, or text overflowing the panel. The one exception is a top or bottom capsule at 320 and
375px. Six chips make it about 490px wide, so its ends clip, the end chips with them, though both
buttons stay in view. main sizes that window to hold the capsule and never under 560px, so the run
prints the case as a LIMIT line instead of failing. Above or below a pill that wide, the panel
stretches to match it. A second pass runs the real animations and fails if the chips move while the
capsule grows or shrinks, or if Small shrinks anything but the pill. Screenshots land in
`%TEMP%\ai-usage-overlay-ui`.

```
node_modules\electron\dist\electron.exe . --shot=%TEMP%\hover.png
```

Real input is worth driving from PowerShell (`SetCursorPos` plus `mouse_event`) when you touch the
hover or drag paths, since that is the only way to test the parts Chromium does not own.

## Not built yet

Drag to reorder the chips, more than one account per provider, and any provider whose usage is not
already on disk. On the phone: drag-to-dismiss (use the notification's Remove), starting the bubble at
boot, an iPhone version (iOS lets no app draw over others), reset notices, and sending a snip
anywhere but the phone's clipboard (the share sheet, the Gallery, the PC's clipboard). Copilot's quota needs a live call to `api.github.com/copilot_internal/user`, and
Cursor's needs a pasted session cookie. xAI's weekly pool also comes split by product (`productUsage`
in `/billing?format=credits`); the panel shows only the total, which is the limit that stops you.
