'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { PROVIDERS, fmtReset, ringPercent, resetRows } = require('./providers');
const THEME_GROUPS = require('./themes');

// Sizes are CSS px at Size = Large. Size scales the pill; the panel never shrinks below Large, so its
// small print stays readable (see panelScale). The renderer reports the real rects.
// The window holds the capsule fully open; everything the capsule doesn't cover is click-through.
const PANEL_W = 300; // the open panel
const PANEL_H = 600; // the open panel's tallest, pill not included; past that its rows scroll
const PILL_H = 60; // the pill's height on the top or bottom edge
const SPINE = 86; // the pill's width on a left or right edge, borders included
const EDGE_GAP = 8; // the capsule floats this far off the edge
const PAD = 16; // room for the shadow
const CHIP = { v: 56, h: 88 }; // generous length per provider along the edge
const TICK_MS = 15_000;
const CURSOR_MS = 60; // hover poll: 16/s of GetCursorPos, cheaper than it sounds
const OPEN_MS = 120; // dwell before the capsule opens, so a pass along the edge doesn't pop it
const CLOSE_MS = 420; // grace to cross the gap between the edge and the capsule
const SNAP_MS = 200;
const NOTICE_MS = 6000;
const HOTKEY = 'Control+Alt+U';
const EDGES = ['left', 'right', 'top', 'bottom'];
// Which limit each provider's summary chip reads; '' is the highest. Codex has no choice worth a menu.
const NUMBER_CHOICES = {
  claude: [['Highest limit', ''], ['Session', 'Session'], ['Weekly', 'All models'], ['Fable', 'Fable']],
  'opencode-go': [['Highest limit', ''], ['5-hour', '5h limit'], ['Weekly', 'Weekly'], ['Monthly', 'Monthly']],
};
const USAGE_PAGES = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/codex/settings/usage',
  'opencode-go': 'https://opencode.ai/workspace/wrk_01M26JF7B3TC3JG56RDM1940Q5/go',
};
const THEMES = THEME_GROUPS.flatMap(([, list]) => list); // [id, label, css]
const SIZES = [
  ['Small', 0.68],
  ['Medium', 0.85],
  ['Large', 1],
  ['Extra large', 1.25],
];
const SHOT = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice(7);
// Something outside the app can knock the capsule out of the topmost band; Chromium then sees it covered
// and stops painting, so even back on top it shows a stale frame. An overlay is never meant to be
// hidden by another window, so skip the occlusion tracking outright.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let win = null;
let tray = null;
let timer = null;
let cursorTimer = null;
let snapTimer = null;
let visible = true;
let autoHide = true;
let ignoring = true; // mirrors setIgnoreMouseEvents, so we only call it on a real change
let revealed = false;
let open = false; // the capsule is grown into the full panel
let overSince = 0; // when the cursor arrived on the capsule or its lip
let closeAt = 0; // when the grace period runs out
let noticeUntil = 0;
let drag = null; // { dx, dy } from the window origin to the grabbed point
let rects = null; // lip and capsule rects in window coordinates, measured by the renderer
let edge = 'right';
let along = 0.5; // where along that edge, 0..1
let displayId = null;
let enabled = PROVIDERS.map((p) => p.id);
let choices = {}; // provider id -> row label its summary chip reads
let theme = 'noir';
let scale = 1; // Size: the pill's zoom in the renderer, and the panel's once it is above 1
const panelScale = () => Math.max(1, scale);
const last = new Map(); // id -> last good { plan, rows, updatedAt }
const fetched = new Map(); // id -> ms of the last read attempt
const gate = new Map(); // id -> ms before which we must not ask again (a 429's Retry-After)

// ---- state
// v3 keeps its own state beside v2's. Its first save copies v2's settings and last readings, which are
// only ever read, so installing v3 starts where v2 was without touching v2.
const statePath = () => path.join(app.getPath('userData'), 'state.json');
const legacyPath = () => path.join(app.getPath('appData'), 'ai-usage-overlay', 'state.json');
function readState() {
  for (const file of [statePath(), legacyPath()]) {
    try {
      // trim() also drops a BOM: a state file edited by hand must not read as empty, or the next save wipes it.
      return JSON.parse(fs.readFileSync(file, 'utf8').trim());
    } catch {
      /* missing or unreadable: try the next, then start fresh */
    }
  }
  return {};
}
let saveTimer = null;
let pending = {};
function saveState(patch) {
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...pending }));
    } catch {
      /* remembering where the capsule sits is a nicety, not worth crashing over */
    }
    pending = {};
  }, 400);
}

const on = () => PROVIDERS.filter((p) => enabled.includes(p.id));
const vertical = () => edge === 'left' || edge === 'right';
const alive = () => win && !win.isDestroyed();

// ---- data

function snapshot() {
  const now = Date.now();
  return on().map((p) => {
    const d = last.get(p.id) || {};
    const until = gate.get(p.id) || 0;
    return {
      id: p.id,
      name: p.name,
      glyph: p.glyph,
      color: p.color,
      ...d,
      ringPercent: ringPercent(d.rows, choices[p.id] || ''),
      // Formatted here so "in 3h 39m" has one implementation, and stays honest between fetches.
      rows: (d.rows || []).map((r) => ({ ...r, resets: fmtReset(r.resetsAt, now) })),
      waitMs: until > now ? until - now : 0,
    };
  });
}

const push = () => alive() && win.webContents.send('data', snapshot());

function showResetNotice(p, rows) {
  if (!rows.length || !alive()) return;
  shell.beep();
  if (open) return; // the open panel already shows the fresh numbers
  noticeUntil = Date.now() + NOTICE_MS;
  closeAt = 0;
  setRevealed(true);
  win.webContents.send('reset', { id: p.id, name: p.name, glyph: p.glyph, color: p.color, rows });
}

async function readOne(p, force) {
  const now = Date.now();
  // The gate is the whole rate-limit answer: a 429's Retry-After stops every later request,
  // including the ones you ask for by hand. Refusing locally is what keeps us off the endpoint.
  if (now < (gate.get(p.id) || 0)) return;
  if (!force && now - (fetched.get(p.id) || 0) < p.everyMs) return;
  fetched.set(p.id, now);
  const res = await p.read();
  const prev = last.get(p.id);
  if (res.error && res.soft) {
    if (res.retryAfter) {
      gate.set(p.id, now + res.retryAfter * 1000);
      saveState({ gate: Object.fromEntries(gate) });
    }
    // Soft means the numbers on screen are still the best we have: keep them, add a note.
    if (prev) return last.set(p.id, { ...prev, note: res.error });
  }
  last.set(p.id, res);
  if (!res.error) {
    showResetNotice(p, resetRows(prev?.rows, res.rows));
    saveState({ cache: { ...(readState().cache || {}), [p.id]: res } });
  }
}

async function tick(force = false) {
  if (!visible) return; // hidden means hidden: no polling, no requests
  await Promise.all(on().map((p) => readOne(p, force)));
  push(); // every beat, even with no new data: the countdowns need re-rendering
}

// ---- geometry

const areaFor = (id) => (screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay()).workArea;

function windowSize() {
  const n = on().length;
  const [s, z] = [scale, panelScale()];
  const size = vertical()
    ? { width: EDGE_GAP + SPINE * s + PANEL_W * z + PAD, height: Math.max(n * CHIP.v * s, PANEL_H * z) + 2 * PAD }
    : { width: Math.max(n * CHIP.h * s, PANEL_W * z) + 2 * PAD, height: EDGE_GAP + PILL_H * s + PANEL_H * z + PAD };
  return { width: Math.ceil(size.width), height: Math.ceil(size.height) };
}

function bounds() {
  const a = areaFor(displayId);
  const { width, height } = windowSize();
  const slideX = Math.round(a.x + along * Math.max(0, a.width - width));
  const slideY = Math.round(a.y + along * Math.max(0, a.height - height));
  if (edge === 'right') return { x: a.x + a.width - width, y: slideY, width, height };
  if (edge === 'left') return { x: a.x, y: slideY, width, height };
  if (edge === 'top') return { x: slideX, y: a.y, width, height };
  return { x: slideX, y: a.y + a.height - height, width, height };
}

function place(animate) {
  if (!alive()) return;
  const to = bounds();
  sendLayout();
  clearInterval(snapTimer);
  if (!animate) return win.setBounds(to);
  const from = win.getBounds();
  const t0 = Date.now();
  snapTimer = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / SNAP_MS);
    const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
    const mix = (a, b) => Math.round(a + (b - a) * e);
    win.setBounds({ x: mix(from.x, to.x), y: mix(from.y, to.y), width: mix(from.width, to.width), height: mix(from.height, to.height) });
    if (k === 1) clearInterval(snapTimer);
  }, 16);
}

function sendLayout() {
  if (!alive()) return;
  const t = THEMES.find(([id]) => id === theme);
  win.webContents.send('layout', { edge, count: on().length, theme, css: t ? t[2] : '', scale });
}

// ---- hover, click-through and dragging, all driven by the cursor position
// setIgnoreMouseEvents(true, { forward: true }) never delivers mouse moves to a window that never takes
// focus, so the renderer can't hit-test for us. GetCursorPos needs no window input at all.

const inRect = (r, x, y) => r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

function setIgnore(next) {
  if (next === ignoring) return;
  ignoring = next;
  win.setIgnoreMouseEvents(next, { forward: true });
}

function setRevealed(next) {
  if (next === revealed) return;
  revealed = next;
  win.webContents.send('reveal', next);
  if (!next) setOpen(false);
}

function setOpen(next) {
  if (next === open) return;
  open = next;
  win.webContents.send('open', next);
}

function pollCursor() {
  if (!alive() || !visible) return;
  // isAlwaysOnTop reads the live window style, so this catches the flag being cleared from outside.
  if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver');
  const pt = screen.getCursorScreenPoint();
  if (drag) return win.setPosition(pt.x - drag.dx, pt.y - drag.dy);
  const b = win.getBounds();
  const x = pt.x - b.x;
  const y = pt.y - b.y;
  const now = Date.now();
  // The lip counts even while it is faded out, so the edge itself stays part of the capsule.
  const over = inRect(rects && rects.island, x, y) || inRect(rects && rects.lip, x, y);
  if (!autoHide) setRevealed(true);
  if (over) {
    closeAt = 0;
    overSince = overSince || now;
    if (now - overSince >= OPEN_MS) {
      noticeUntil = 0;
      setRevealed(true);
      setOpen(true);
    }
  } else {
    overSince = 0;
    if (noticeUntil > now) {
      closeAt = 0;
      setRevealed(true);
    } else if (open || (autoHide && revealed)) {
      if (!closeAt) closeAt = now + CLOSE_MS;
      else if (now >= closeAt) {
        closeAt = 0;
        setOpen(false);
        if (autoHide) setRevealed(false);
      }
    }
  }
  setIgnore(!over);
}

// ---- chrome

function menu() {
  const rebuild = () => tray.setContextMenu(menu());
  const numberMenus = on().filter((p) => NUMBER_CHOICES[p.id]).map((p) => ({
    label: p.name,
    submenu: NUMBER_CHOICES[p.id].map(([label, row]) => ({
      label,
      type: 'radio',
      checked: (choices[p.id] || '') === row,
      click: () => {
        choices = { ...choices, [p.id]: row };
        saveState({ rings: choices }); // the key predates the redesign, so old settings carry over
        push();
      },
    })),
  }));
  return Menu.buildFromTemplate([
    { label: visible ? 'Hide overlay' : 'Show overlay', accelerator: HOTKEY, registerAccelerator: false, click: toggle },
    { label: 'Refresh now', click: () => tick(true) },
    { type: 'separator' },
    {
      label: 'Providers',
      submenu: PROVIDERS.map((p) => ({
        label: p.name,
        type: 'checkbox',
        checked: enabled.includes(p.id),
        click: (item) => {
          const ids = item.checked ? [...enabled, p.id] : enabled.filter((id) => id !== p.id);
          // Keep the declared order however you toggle them, so cells never shuffle.
          enabled = PROVIDERS.filter((q) => ids.includes(q.id)).map((q) => q.id);
          saveState({ enabled, known: PROVIDERS.map((q) => q.id) });
          rebuild();
          setOpen(false);
          place(true);
          tick();
        },
      })),
    },
    ...(numberMenus.length ? [{ label: 'Summary shows', submenu: numberMenus }] : []),
    {
      label: 'Size',
      submenu: SIZES.map(([label, k]) => ({
        label,
        type: 'radio',
        checked: scale === k,
        click: () => {
          scale = k;
          saveState({ scale });
          setOpen(false);
          place(true);
        },
      })),
    },
    {
      label: `Theme: ${THEMES.find(([id]) => id === theme)[1]}`,
      submenu: THEME_GROUPS.map(([group, list]) => ({
        label: group,
        submenu: list.map(([id, label]) => ({
          label,
          type: 'checkbox', // radio groups don't span submenus; the rebuild unticks the old one
          checked: theme === id,
          click: () => {
            theme = id;
            saveState({ theme });
            sendLayout();
            rebuild();
          },
        })),
      })),
    },
    {
      label: 'Auto-hide',
      type: 'checkbox',
      checked: autoHide,
      click: (item) => {
        autoHide = item.checked;
        saveState({ autoHide });
        closeAt = 0;
        if (!autoHide) setRevealed(true);
        rebuild();
      },
    },
    { type: 'separator' },
    { label: 'Drag the pill to any screen edge', enabled: false },
    {
      label: 'Reset position',
      click: () => {
        edge = 'right';
        along = 0.5;
        displayId = screen.getPrimaryDisplay().id;
        saveState({ edge, along, displayId });
        place(true);
      },
    },
    {
      label: 'Open usage page',
      submenu: PROVIDERS.map((p) => ({ label: p.name, click: () => shell.openExternal(USAGE_PAGES[p.id]) })),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function toggle() {
  visible = !visible;
  if (visible) {
    win.showInactive();
    if (!autoHide) setRevealed(true);
    tick();
  } else {
    noticeUntil = 0;
    win.webContents.send('reset', null);
    win.hide();
    setRevealed(false);
  }
  tray.setContextMenu(menu());
}

function loadState() {
  const st = readState();
  // A provider added after the state was saved starts on; `known` is what the saving build had.
  if (Array.isArray(st.enabled)) enabled = PROVIDERS.filter((p) => st.enabled.includes(p.id) || !(st.known || ['claude', 'codex']).includes(p.id)).map((p) => p.id);
  const saved = { claude: st.claudeRing, ...(st.rings || {}) }; // claudeRing is the oldest key
  for (const [id, list] of Object.entries(NUMBER_CHOICES)) if (list.some(([, row]) => row === saved[id])) choices[id] = saved[id];
  if (THEMES.some(([id]) => id === st.theme)) theme = st.theme;
  if (SIZES.some(([, k]) => k === st.scale)) scale = st.scale;
  if (typeof st.autoHide === 'boolean') autoHide = st.autoHide;
  if (EDGES.includes(st.edge)) edge = st.edge;
  if (typeof st.along === 'number') along = Math.max(0, Math.min(1, st.along));
  displayId = screen.getAllDisplays().some((d) => d.id === st.displayId) ? st.displayId : screen.getPrimaryDisplay().id;
  // Last good numbers, so a restart paints real levels before the first request comes back.
  for (const [id, v] of Object.entries(st.cache || {})) last.set(id, v);
  for (const [id, v] of Object.entries(st.gate || {})) if (v > Date.now()) gate.set(id, v);
}

function createWindow() {
  loadState();
  win = new BrowserWindow({
    ...bounds(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false, // we move it ourselves, from the cursor poll
    skipTaskbar: true,
    focusable: false, // an overlay that steals focus off a click is worse than one you can't focus
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // above fullscreen apps, unlike the plain alwaysOnTop flag
  win.setVisibleOnAllWorkspaces(true);
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile('index.html');
  // The renderer can't lay out until it knows its edge, and it may finish loading before or after
  // ready-to-show fires. Anything sent before its listeners exist is lost, so say it all again: with
  // Auto-hide off nothing else would ever re-send the reveal, and the capsule would stay away.
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(1); // Size is CSS zoom on parts of the page now, never the whole page
    sendLayout();
    win.webContents.send('reveal', revealed);
    win.webContents.send('open', open);
  });
  win.once('ready-to-show', () => {
    win.showInactive();
    sendLayout();
    if (!autoHide) setRevealed(true);
    tick(true).then(() => SHOT && captureAndQuit());
  });
}

function captureAndQuit() {
  // ponytail: fixed settle delay beats wiring a paint-ack IPC for a verification-only path.
  setTimeout(async () => {
    try {
      if (SHOT.includes('hover')) {
        clearInterval(cursorTimer); // or the poll closes the panel again before the shutter
        setRevealed(true);
        await new Promise((r) => setTimeout(r, 900)); // let the chips sweep up first
        setOpen(true);
        await new Promise((r) => setTimeout(r, 1200));
      }
      fs.writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG());
      console.log('wrote ' + SHOT);
    } catch (e) {
      console.error(e);
    }
    app.exit(0);
  }, 1200);
}

app.whenReady().then(() => {
  createWindow();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))); // tray@2x.png is picked up on HiDPI
  tray.setToolTip('AI Usage Overlay v3');
  tray.setContextMenu(menu());
  tray.on('click', () => tray.popUpContextMenu());
  globalShortcut.register(HOTKEY, toggle); // false when another copy already holds it; the menu still works
  timer = setInterval(tick, TICK_MS);
  cursorTimer = setInterval(pollCursor, CURSOR_MS);
});

ipcMain.on('rects', (_e, r) => {
  rects = r; // the page is never zoomed as a whole, so its CSS px are the window's px
});
ipcMain.on('menu', () => tray.popUpContextMenu());
ipcMain.on('refresh', () => tick(true));
ipcMain.handle('data', () => snapshot());

ipcMain.on('drag-start', () => {
  const pt = screen.getCursorScreenPoint();
  const b = win.getBounds();
  drag = { dx: pt.x - b.x, dy: pt.y - b.y };
  setOpen(false); // you carry the pill, not the panel
  clearInterval(snapTimer);
  win.webContents.send('dragging', true);
});

// Snap to whichever edge of whichever display the capsule ended up nearest.
ipcMain.on('drag-end', () => {
  if (!drag) return;
  drag = null;
  win.webContents.send('dragging', false);
  const b = win.getBounds();
  // Decide from the capsule's centre, not the window's: most of the window is transparent room for the
  // open panel, so its centre can sit on a different monitor from the thing you are holding.
  const s = (rects && rects.island) || { x: 0, y: 0, w: b.width, h: b.height };
  const cx = Math.round(b.x + s.x + s.w / 2);
  const cy = Math.round(b.y + s.y + s.h / 2);
  const d = screen.getDisplayNearestPoint({ x: cx, y: cy });
  const a = d.workArea;
  const dist = { left: cx - a.x, right: a.x + a.width - cx, top: cy - a.y, bottom: a.y + a.height - cy };
  displayId = d.id;
  edge = EDGES.reduce((best, e) => (dist[e] < dist[best] ? e : best), 'right');
  // The capsule is centred in the window along its edge, so this leaves it where you dropped it.
  const size = windowSize();
  along = vertical()
    ? (cy - size.height / 2 - a.y) / Math.max(1, a.height - size.height)
    : (cx - size.width / 2 - a.x) / Math.max(1, a.width - size.width);
  along = Math.max(0, Math.min(1, along));
  saveState({ edge, along, displayId });
  place(true);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  clearInterval(timer);
  clearInterval(cursorTimer);
  clearInterval(snapTimer);
  globalShortcut.unregisterAll();
});
