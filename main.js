'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, ipcMain, screen, shell, safeStorage, clipboard, dialog } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PROVIDERS, setConsoleKey, creditExpired, fmtReset, ringPercent, resetRows } = require('./providers');
const THEME_GROUPS = require('./themes');
const link = require('./link');

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
const PHONE_PORT = 7430; // `tailscale serve --bg --https=8443 http://127.0.0.1:7430` carries it to the phone
const EDGES = ['left', 'right', 'top', 'bottom'];
// Which limit each provider's summary chip reads; '' is the highest. Codex has no choice worth a menu.
const NUMBER_CHOICES = {
  claude: [['Highest limit', ''], ['Session', 'Session'], ['Weekly', 'All models'], ['Fable', 'Fable']],
  'opencode-go': [['Highest limit', ''], ['5-hour', '5h limit'], ['Weekly', 'Weekly'], ['Monthly', 'Monthly']],
  antigravity: [['Highest limit', ''], ['Gemini 5h', 'gemini-5h'], ['Gemini weekly', 'gemini-weekly'], ['Other 5h', '3p-5h'], ['Other weekly', '3p-weekly']],
};
const USAGE_PAGES = {
  claude: 'https://claude.ai/settings/usage',
  codex: 'https://chatgpt.com/codex/settings/usage',
  'opencode-go': 'https://opencode.ai/workspace/wrk_01M26JF7B3TC3JG56RDM1940Q5/go',
  xai: 'https://grok.com/?_s=usage',
};
const THEMES = THEME_GROUPS.flatMap(([, list]) => list); // [id, label, css]
const SIZES = [
  ['Small', 0.68],
  ['Medium', 0.85],
  ['Large', 1],
  ['Extra large', 1.25],
];
const SHOT = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice(7);
// A --shot run beside the installed copy only reads that copy's profile: its state.json, for the settings and the last
// numbers. It saves nothing there, and Chromium keeps its own files (caches, storage, network state) in a folder of
// its own, set before ready as Electron requires.
const LIVE_DATA = app.getPath('userData');
if (SHOT) {
  const own = path.join(require('os').tmpdir(), 'ai-usage-overlay-shot');
  fs.mkdirSync(own, { recursive: true });
  for (const name of ['userData', 'sessionData']) app.setPath(name, own);
}
// Something outside the app can knock the capsule out of the topmost band; Chromium then sees it covered
// and stops painting, so even back on top it shows a stale frame. An overlay is never meant to be
// hidden by another window, so skip the occlusion tracking outright.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// One copy at a time. A second would fight the first for port 7430, the link and the hotkey, and, holding the
// sleep timers on its own, could save over the first's record of them. A second launch shows the first instead.
// A --shot run is exempt: it runs beside the installed copy to check a change.
const firstCopy = !!SHOT || app.requestSingleInstanceLock();
if (!firstCopy) app.exit(0);

let win = null;
let tray = null;
let timer = null;
let stopLink = null;
let cursorTimer = null;
let snapTimer = null;
let visible = true;
let autoHide = true;
let awakeBlocker = null;
let sleepAc = {}; // power plan GUID -> its own plugged-in sleep timer in seconds, while Keep PC awake holds it at 0
let ignoring = true; // mirrors setIgnoreMouseEvents, so we only call it on a real change
let revealed = false;
let open = false; // the capsule is grown into the full panel
let overSince = 0; // when the cursor arrived on the capsule or its lip
let closeAt = 0; // when the grace period runs out
let noticeUntil = 0;
let noticeFor = null; // provider id currently displayed in the desktop reset notice
let drag = null; // { dx, dy } from the window origin to the grabbed point
let rects = null; // lip and capsule rects in window coordinates, measured by the renderer
let edge = 'right';
let along = 0.5; // where along that edge, 0..1
let displayId = null;
let enabled = PROVIDERS.map((p) => p.id);
let choices = {}; // provider id -> row label its summary chip reads
let theme = 'noir';
let scale = 1; // Size: the pill's zoom in the renderer, and the panel's once it is above 1
let hasConsoleKey = false; // a Console session is saved, so the tray offers to forget it
const panelScale = () => Math.max(1, scale);
// The pill's zoom: Size's, or smaller where a row or column of chips at that size exceeds the display it sits on,
// as seven providers at Extra large do on a 600px portrait monitor or a 320px-tall work area. The panel keeps its own.
const pillScale = () => {
  const n = on().length;
  if (!n) return scale;
  const a = areaFor(displayId);
  return Math.min(scale, ((vertical() ? a.height : a.width) - 2 * PAD) / (n * (vertical() ? CHIP.v : CHIP.h)));
};
const last = new Map(); // id -> last good { plan, rows, updatedAt }
const fetched = new Map(); // id -> ms of the last quota read attempt
const fetchedFor = new Map(); // id -> { renewsFor, gateKeys } of the account that made the last quota attempt
const credChecked = new Map(); // id -> ms of the last credential check (independent of quota attempts)
const credRetryAt = new Map(); // id -> ms before which a failed credential lookup will not auto-retry
const credFails = new Map(); // id -> credential lookups failed in a row since the last that answered
const gate = new Map(); // id -> ms before which we must not ask again (a 429's Retry-After)
const accountGates = new Map(); // id -> [{ until, keys, origin }] for providers that track 429 gates per account (p.gateUntil)
const unverified = new Set(); // providers whose startup cache waits for credential verification before publishing
// Providers that pre-toggleProvider phone APKs can manage with whole-list `{ enabled: [...] }` writes.
const LEGACY_PROVIDERS = new Set(['claude', 'codex', 'opencode-go', 'xai', 'cpu', 'ram']);
const inflight = new Map(); // id -> the read in progress; a second refresh joins it rather than racing it
const inflightKeys = new Map(); // id -> backoff keys of the credential the in-flight read was started with
const inflightToken = new Map(); // id -> bearer token hash the in-flight read was started with
let publishSeq = 0;
const publishedQuota = new Map(); // id -> { seq, tokenHash } of the last confirmed non-error quota publish
const activeKeys = new Map(); // id -> backoff keys of the credential the last accepted check found
const activeToken = new Map(); // id -> { tokenHash, expiry, hasRefresh } of the last verified unexpired credential
const expiredCred = new Set(); // providers whose refreshable token is locally expired (paces cred checks without surfacing an error)
const accountGen = new Map(); // id -> incremented on account switch/sign-out so abandoned in-flight responses are discarded
// id -> how many times it was switched off. A lookup begun before one never retries, though it is back on by then: the
// credential check after the switch-on may still be out, and the bearer the lookup carries may be another account's.
const disableGen = new Map();
const signedIn = new Map(); // id -> last confirmed account (renewsFor), saved separately from unverified readings
// id -> Map<tokenHash, { error, authError }> of bearers refused with 401/auth-403 or 403 permission denial, saved per
// bearer so restarts and account switches (A -> B -> A) keep the error note during a cooldown instead of flashing
// cached data or waiting indefinitely.
const authRejected = new Map();
let authSeq = 0; // counts quota requests as they begin
const authAnswered = new Map(); // bearer hash -> the newest-begun request whose answer set or cleared its refusal
const rateCleared = new Map(); // id -> { seq, account, gateKeys } of the newest 429 or good 200 that supersedes a non-bearer error
let cache = {}; // id -> last good reading, as saved. Kept here: building it from disk loses readings that land within one save debounce.

// ---- state
// v3 keeps its own state beside v2's. Its first save copies v2's settings and last readings, which are
// only ever read, so installing v3 starts where v2 was without touching v2.
const statePath = () => path.join(LIVE_DATA, 'state.json');
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
const ANTIGRAVITY_IDENTITY_VERSION = 2; // v2 rejects whitespace-only refresh/access tokens in identity, links & gates
let saveTimer = null;
let pending = {};
function saveState(patch) {
  // A --shot run started from the same state.json as the installed copy, which may have saved since: anything it wrote
  // back would be older, as a Keep PC awake it read on and the installed copy has since switched off.
  if (SHOT) return;
  Object.assign(pending, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushState, 400);
}
// Also called on quit, which doesn't wait for the debounce. The whole state goes to a sibling file that
// replaces state.json only once it is complete, so a write that fails partway (a full disk) can't leave
// half a file where the settings were. The changes stay pending until a save actually lands.
function flushState() {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length) return;
  const tmp = statePath() + '.tmp';
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ...readState(), ...pending, antigravityIdentityVersion: ANTIGRAVITY_IDENTITY_VERSION }), { flush: true });
    fs.renameSync(tmp, statePath());
    pending = {};
  } catch {
    // Remembering settings is a nicety, not worth crashing over. Try again later, not in a tight loop;
    // the next save and quit try too.
    // ponytail: retries every 30s for as long as the disk refuses; a backoff if that ever matters.
    saveTimer = setTimeout(flushState, 30_000);
  }
}

const on = () => PROVIDERS.filter((p) => enabled.includes(p.id));
const vertical = () => edge === 'left' || edge === 'right';
const alive = () => win && !win.isDestroyed();

// ---- data

function prunedAccountGates(now = Date.now()) {
  const out = {};
  for (const [id, list] of accountGates) {
    for (let i = list.length; i--;) if (list[i].until <= now) list.splice(i, 1);
    if (list.length) out[id] = list;
  }
  return out;
}
// A 429's deadline, kept per account by the provider (p.gateUntil, p.gateSet): over every key the account has shown,
// with whose it is. A lookup copies it onto the credential's keys and saves it, so the record names them itself, whatever
// the saved links (128 keys at most) have since let go.
function accountGateUntil(p, keys, now = Date.now()) {
  const list = accountGates.get(p.id);
  if (!list || !keys?.length) return 0;
  const { until, changed } = p.gateUntil(list, keys, now);
  if (changed) saveState({ accountGates: prunedAccountGates(now) });
  return until;
}
function setAccountGate(p, keys, until) {
  if (!accountGates.has(p.id)) accountGates.set(p.id, []);
  p.gateSet(accountGates.get(p.id), keys, until);
  saveState({ accountGates: prunedAccountGates() });
}
// loadCodeAssist's deadlines are the provider's, saved here apart from quota's: they hold back no quota read.
const tierGatesState = () => Object.fromEntries(PROVIDERS.filter((p) => p.tierGates).map((p) => [p.id, p.tierGates()]));
for (const p of PROVIDERS) p.watchTierGates?.(() => saveState({ tierGates: tierGatesState() }));
// Which keys are one account's, saved apart from readings and waits: a verified account may have neither yet.
const linksState = () => Object.fromEntries(PROVIDERS.filter((p) => p.links).map((p) => [p.id, p.links()]));
// Holds the provider back until the deadline the credential's account is under and returns it, or lifts a wait that
// was another account's.
function armGate(p, keys, now = Date.now()) {
  const until = accountGateUntil(p, keys, now);
  if (until > now) {
    gate.set(p.id, until);
    fetched.delete(p.id); // the gate alone holds it back, so polling resumes as soon as Retry-After lifts
    fetchedFor.delete(p.id);
    // A failed credential look's next one waits no longer than the wait either (credRetry caps it the same way).
    if ((credRetryAt.get(p.id) || 0) > until) credRetryAt.set(p.id, until);
  } else gate.delete(p.id);
  return until;
}
// Each credential read links the keys it carries (p.gateAliases), so a deadline any of them is under is copied onto
// all of them at once: a restart straight after still finds it under whichever key the next credential has.
// Checks count in the order they began. One that lands after a later one has holds an older snapshot (a refresh that
// joins the read in flight moves no generation, so nothing else would tell), and looks again rather than be acted on.
let credSeq = 0;
const credLanded = new Map(); // id -> the latest-begun credential check that has landed
async function peekCred(p) {
  for (let i = 0; i < 3; i++) {
    const seq = ++credSeq;
    const cred = await p.peekCred();
    if (cred.linked) saveState({ accountLinks: linksState() }); // a fact about the account, even from an overtaken check
    if (cred.status === 'ok') accountGateUntil(p, cred.gateKeys);
    if (seq < (credLanded.get(p.id) || 0)) continue;
    credLanded.set(p.id, seq);
    return cred;
  }
  return { status: 'error', error: 'Credential check overtaken', soft: true };
}

// A row as the screens get it: without what only main compares by (an Antigravity bucket's key, pool, window, ambiguity, disabled flag).
const shownRow = ({ ambiguous, bucketId, disabled, key, win: _win, ...r }) => r;

function snapshot() {
  const now = Date.now();
  return on().map((p) => {
    // Do not publish restored cached data for an account-checked provider until its live credentials confirm the account.
    // With nothing verified to show, a lookup that has failed twice running says why, so the section never waits forever
    // on a helper that cannot run; once is a hiccup, and stays quiet.
    // One fixed line: the helper's own message can carry its whole PowerShell command line or a local path.
    const lookupError = credFails.get(p.id) >= 2 && (unverified.has(p.id) || !last.get(p.id)) ? `${p.name} credential lookup failing — retrying every minute.` : '';
    if (unverified.has(p.id) || lookupError) {
      return { id: p.id, name: p.name, glyph: p.glyph, color: p.color, local: p.local, ringPercent: 0, rows: [], waitMs: 0, ...(lookupError ? { error: lookupError } : {}) };
    }
    const d = last.get(p.id) || {};
    const until = gate.get(p.id) || 0;
    return {
      id: p.id,
      name: p.name,
      glyph: p.glyph,
      color: p.color,
      local: p.local, // CPU and RAM, which the footers leave out of "Updated"
      ...d,
      // Past its deadline a balance isn't funds, whatever kept the reading: a gated or skipped read, a soft
      // failure, the startup cache. Only the deadline goes out, and the panels say it expired.
      ...(creditExpired(d.apiCredit, now) ? { apiCredit: { expired: true, expiresAt: d.apiCredit.expiresAt } } : {}),
      // A banked reset with no deadline would read "3 banked resets expire Nov 30 and Dec 1", so the count shows alone.
      ...(d.bankedResetExpiries?.some((t) => !Number.isFinite(t)) ? { bankedResetExpiries: undefined } : {}),
      // When the plan next bills, with its countdown. A date that has passed (a reading kept through failed reads,
      // or from before a restart) says nothing about the next one, so it goes.
      ...(d.renewsAt > now ? { renewsIn: fmtReset(d.renewsAt, now) } : { renewsAt: undefined, renewsGuess: undefined }),
      renewsFor: undefined, // the account a date belongs to: main's to check, not the screens'
      gateFor: undefined,
      gateKeys: undefined,
      retryAfter: undefined, // a failed read's wait, which waitMs shows
      expired: undefined,
      accountUnknown: undefined,
      signedOut: undefined,
      authError: undefined,
      tokenHash: undefined, // the refused/denied bearer's hash, main's to compare
      errSeq: undefined, // the request sequence of a non-bearer error, main's to compare
      ringPercent: ringPercent(d.rows, choices[p.id] || ''),
      // Formatted here so "in 3h 39m" has one implementation, and stays honest between fetches.
      rows: (d.rows || []).map(shownRow).map((r) => ({ ...r, resets: r.resets || fmtReset(r.resetsAt, now) })), // a local row brings its own
      // Keep Refresh enabled beside an error (sign-in note or permission denial) so a user who signs in, rotates
      // tokens, or switches accounts can re-verify immediately without waiting out the old account's cooldown.
      waitMs: until > now && !d.error ? until - now : 0,
    };
  });
}

function push() {
  if (alive()) win.webContents.send('data', snapshot());
  tellPhones();
}

function clearResetNotice(id) {
  if (noticeFor !== id) return;
  noticeFor = null;
  noticeUntil = 0;
  if (alive()) win.webContents.send('reset', null);
}

function showResetNotice(p, rows) {
  // A read still in flight when you hid the overlay or dropped the provider must not beep or reveal it.
  if (!rows.length || !alive() || !visible || !enabled.includes(p.id)) return;
  shell.beep();
  if (open) return; // the open panel already shows the fresh numbers
  noticeFor = p.id;
  noticeUntil = Date.now() + NOTICE_MS;
  closeAt = 0;
  setRevealed(true);
  win.webContents.send('reset', { id: p.id, name: p.name, glyph: p.glyph, color: p.color, rows: rows.map(shownRow) });
}

function bumpGen(id) {
  const next = (accountGen.get(id) || 0) + 1;
  accountGen.set(id, next);
  return next;
}

const authRejectedState = () => Object.fromEntries(
  [...authRejected]
    .filter(([, m]) => m.size)
    .map(([id, m]) => [id, Object.fromEntries([...m].map(([h, v]) => [h, {
      error: v.error,
      ...(v.authError ? { authError: true } : {}),
      ...(v.fallbackError ? { fallbackError: v.fallbackError } : {}),
    }]))]),
);
const rejectedReading = (rej, tokenHash, account, gateKeys) => ({
  error: rej.error,
  ...(rej.authError ? { authError: true } : {}),
  tokenHash,
  renewsFor: account,
  gateKeys,
});
// Whether a bearer is refused/denied is the newest-begun request's say: an older one landing after it (A -> B -> A,
// its 403's body slow) says nothing, however late. Requests count in the order they began (authSeq).
function newestAuthAnswer(tokenHash, seq) {
  if (seq < (authAnswered.get(tokenHash) || 0)) return false;
  authAnswered.delete(tokenHash);
  authAnswered.set(tokenHash, seq);
  if (authAnswered.size > 64) authAnswered.delete(authAnswered.keys().next().value);
  return true;
}
function setAuthRejected(id, tokenHash, error, seq, authError = false) {
  if (!tokenHash || typeof error !== 'string' || !newestAuthAnswer(tokenHash, seq)) return false;
  let m = authRejected.get(id);
  if (!m) authRejected.set(id, (m = new Map()));
  const cur = m.get(tokenHash);
  // Preserve an existing non-auth permission denial behind a newer auth refusal so a soft 401 on a refreshable
  // bearer keeps the permission denial visible while a non-refreshable bearer still shows Session expired.
  const fallbackError = authError ? (cur && !cur.authError ? cur.error : cur?.fallbackError) : undefined;
  const next = { error, authError: !!authError, ...(fallbackError ? { fallbackError } : {}) };
  if (cur && cur.error === next.error && !!cur.authError === next.authError && cur.fallbackError === next.fallbackError && [...m.keys()].at(-1) === tokenHash) return true;
  m.delete(tokenHash);
  m.set(tokenHash, next);
  while (m.size > 20) m.delete(m.keys().next().value);
  saveState({ authRejected: authRejectedState() });
  return true;
}
function clearAuthRejected(id, tokenHash, seq) {
  if (!newestAuthAnswer(tokenHash, seq)) return false;
  const m = authRejected.get(id);
  if (!m) return true;
  const changed = tokenHash ? m.delete(tokenHash) : (m.size > 0 && (m.clear(), true));
  if (!m.size) authRejected.delete(id);
  if (changed) saveState({ authRejected: authRejectedState() });
  return true;
}

// A 401/auth-403 rejection stored for a bearer is hidden while the credential carries a refresh_token (its 1-hour
// access token only needs Antigravity to rotate it when next used), while any preserved 403 permission denial stays visible.
function bearerRejection(id, cred) {
  const rej = authRejected.get(id)?.get(cred.tokenHash);
  if (!rej) return null;
  if (cred.hasRefresh && rej.authError) {
    return rej.fallbackError ? { error: rej.fallbackError, authError: false } : null;
  }
  return rej;
}

function restoreAccountCache(p, account, gateKeys) {
  const saved = cache[p.id];
  if (saved && !otherAccount(p, saved, account, gateKeys)) {
    const mergedKeys = p.gateAliases ? provenKeys(p, saved.gateKeys, gateKeys) : saved.gateKeys;
    const renamed = account && (saved.renewsFor !== account || (mergedKeys && !sameSet(mergedKeys, saved.gateKeys)))
      ? { ...saved, renewsFor: account, ...(mergedKeys ? { gateKeys: mergedKeys } : {}) }
      : saved;
    if (renamed !== saved) {
      cache[p.id] = renamed;
      saveState({ cache });
    }
    last.set(p.id, renamed);
  } else {
    last.delete(p.id);
  }
}

function applySignedOut(p, error, now = Date.now()) {
  bumpGen(p.id);
  p.onSignedOut?.();
  publishedQuota.delete(p.id);
  activeKeys.delete(p.id);
  activeToken.delete(p.id);
  expiredCred.delete(p.id);
  rateCleared.delete(p.id);
  fetched.delete(p.id);
  fetchedFor.delete(p.id);
  const prevLast = last.get(p.id);
  const unchanged = prevLast?.signedOut && prevLast.error === error && !cache[p.id] && !signedIn.has(p.id) && !gate.has(p.id) && !unverified.has(p.id);
  clearResetNotice(p.id);
  if (unchanged) return;
  unverified.delete(p.id);
  signedIn.delete(p.id);
  gate.delete(p.id);
  delete cache[p.id];
  last.set(p.id, { error, signedOut: true });
  saveState({ cache, signedIn: Object.fromEntries(signedIn), gate: Object.fromEntries(gate), accountGates: prunedAccountGates(now) });
  push();
}

// The credential's token has run out. When a refresh_token is present the session is still signed in and the 1-hour
// access token simply lapsed while Antigravity sat idle, so keep this account's last good numbers quietly (preserving
// any 403 permission denial and active cooldown) and pace credential checks on the normal cadence. Without a
// refresh_token the bearer cannot self-renew, so surface the sign-in note, under the account's keys so a replacement
// under its other name (an email gone) still counts as this account.
function applyExpired(p, cred, now = Date.now()) {
  bumpGen(p.id);
  // Retain the verified bearer and refresh flag through both soft and hard expiry so late in-flight responses for
  // this bearer still reconcile against the latest verified credential metadata rather than stale pre-join state.
  activeToken.set(p.id, { tokenHash: cred.tokenHash, expiry: cred.expiry, hasRefresh: !!cred.hasRefresh });
  unverified.delete(p.id);
  signedIn.set(p.id, cred.account);
  armGate(p, cred.gateKeys, now);
  if (cred.hasRefresh) {
    expiredCred.add(p.id);
    credChecked.set(p.id, now);
    const rej = bearerRejection(p.id, cred);
    const curLast = last.get(p.id);
    if (rej) {
      if (curLast?.error !== rej.error || !!curLast?.authError !== !!rej.authError || curLast?.tokenHash !== cred.tokenHash) {
        clearResetNotice(p.id);
        last.set(p.id, rejectedReading(rej, cred.tokenHash, cred.account, cred.gateKeys));
      }
    } else {
      if (curLast?.error && !curLast.signedOut) restoreAccountCache(p, cred.account, cred.gateKeys);
      foldBgPlan(p, cred.account);
    }
    saveState({ signedIn: Object.fromEntries(signedIn), gate: Object.fromEntries(gate) });
    push();
    return;
  }
  expiredCred.delete(p.id);
  clearResetNotice(p.id);
  last.set(p.id, { error: 'Session expired — open Antigravity.', renewsFor: cred.account, gateKeys: cred.gateKeys, expired: true });
  saveState({ signedIn: Object.fromEntries(signedIn), gate: Object.fromEntries(gate) });
  push();
}

function foldBgPlan(p, confirmedAccount) {
  if (!confirmedAccount || unverified.has(p.id)) return;
  const cur = last.get(p.id);
  if (!cur || cur.error || cur.renewsFor !== confirmedAccount) return;
  const bgPlan = p.cachedPlan?.(confirmedAccount);
  if (!bgPlan || bgPlan === cur.plan) return;
  const updated = { ...cur, plan: bgPlan };
  last.set(p.id, updated);
  if (cache[p.id]?.renewsFor === confirmedAccount) {
    cache[p.id] = updated;
    saveState({ cache });
  }
}

// When a credential lookup fails after the last verified bearer's stored expiry has passed, surface Session expired
// right away (keeping Refresh enabled while any account cooldown still blocks quota requests) rather than leaving
// stale cached rows behind a cooldown.
function expireActiveToken(p, now = Date.now(), fallbackAccount = null, fallbackKeys = null) {
  const curTok = activeToken.get(p.id);
  if (!curTok || unverified.has(p.id)) return false;
  if (!(Number.isFinite(curTok.expiry) && curTok.expiry <= now)) return false;
  const curLast = last.get(p.id);
  const keys = activeKeys.get(p.id) || fallbackKeys || curLast?.gateKeys;
  const account = curLast?.renewsFor || signedIn.get(p.id) || fallbackAccount;
  if (curTok.hasRefresh) {
    // Retain verified refreshable metadata for in-flight response reconciliation, and restore same-account cache if
    // a prior non-bearer error is still hiding it and no bearer denial applies.
    if (curLast?.error && !curLast.signedOut && !bearerRejection(p.id, curTok)) {
      restoreAccountCache(p, account, keys);
      return true;
    }
    return false;
  }
  // Retain verified non-refreshable metadata too so a late in-flight response whose lookup also fails never falls
  // back to an older pre-join credential that still had hasRefresh: true.
  if (curLast?.authError || curLast?.expired) return false;
  clearResetNotice(p.id);
  last.set(p.id, { error: 'Session expired — open Antigravity.', ...(account ? { renewsFor: account } : {}), ...(keys ? { gateKeys: keys } : {}), expired: true });
  return true;
}

// A failed credential lookup is tried again in a minute, or as the wait it fell inside lifts if that is sooner (a wait
// recorded before a restart or re-enable and not yet armed counts too): a valid token installed meanwhile is found the
// moment reads may resume.
function credRetry(p, now, also = 0) {
  const recorded = accountGateUntil(p, activeKeys.get(p.id) || last.get(p.id)?.gateKeys || cache[p.id]?.gateKeys, now);
  const until = Math.max(gate.get(p.id) || 0, also, recorded);
  return until > now ? Math.min(now + 60_000, until) : now + 60_000;
}
// A failed lookup: its retry is set, and it counts toward the error snapshot shows once two have failed running.
function credFailed(p, now, also = 0) {
  credRetryAt.set(p.id, credRetry(p, now, also));
  const n = (credFails.get(p.id) || 0) + 1;
  credFails.set(p.id, n);
  if (n === 2) push();
}
// A lookup that answered (signed in or out): no retry pending, and the failures counted end. Returns whether a visible
// failure message was cleared so callers can push immediately rather than waiting for the quota request to finish.
function credAnswered(p) {
  const had = (credFails.get(p.id) || 0) >= 2;
  credRetryAt.delete(p.id);
  credFails.delete(p.id);
  return had;
}

// One read per provider at a time. Two overlapping refreshes used to race, and a slow older answer
// landing last rolled the numbers back and beeped a reset that never happened. Each read pushes as it
// settles, whoever asked for it: a read can take over a minute to give up, and the other providers' numbers,
// CPU and RAM and the countdowns used to wait for it.
// For account-checked providers (Antigravity), a refresh while an earlier request is in flight still verifies
// credentials so an account switch, token rotation, or sign-out supersedes the old in-flight request instead of joining it.
function readOne(p, force) {
  if (p.peekCred && inflight.has(p.id)) {
    if (!force) return inflight.get(p.id);
    return (async () => {
      const startPublished = publishedQuota.get(p.id)?.seq || 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!enabled.includes(p.id)) return;
        const startGen = accountGen.get(p.id) || 0;
        credChecked.set(p.id, Date.now());
        const cred = await peekCred(p);
        const now = Date.now(); // when the check landed
        if (!enabled.includes(p.id)) return;
        // If another read advanced the generation while this lookup was pending, discard this potentially stale
        // result and recheck current credentials so a newer sign-out or switch is never dropped.
        if (startGen !== (accountGen.get(p.id) || 0)) continue;
        if (cred.status === 'error') {
          const expiredNow = expireActiveToken(p, now);
          credFailed(p, now);
          if (expiredNow) push();
          return inflight.get(p.id);
        }
        if (credAnswered(p) && cred.status === 'ok' && !last.get(p.id) && !unverified.has(p.id)) push();
        if (cred.status === 'signed_out') {
          inflight.delete(p.id);
          inflightKeys.delete(p.id);
          inflightToken.delete(p.id);
          applySignedOut(p, cred.error, now);
          return;
        }
        // The same bearer, for the same account under whatever name the credential gives it now (an email gone or come),
        // joins the request in flight; the keys it shows are already linked and saved (peekCred). An expired token joins
        // nothing: the fresh read below shows the expiry and supersedes the request in flight.
        if (inflight.has(p.id) && !cred.expired && cred.tokenHash === inflightToken.get(p.id) && sameKeys(p, { gateKeys: inflightKeys.get(p.id) }, cred.gateKeys)) {
          activeKeys.set(p.id, cred.gateKeys);
          expiredCred.delete(p.id);
          activeToken.set(p.id, { tokenHash: cred.tokenHash, expiry: cred.expiry, hasRefresh: !!cred.hasRefresh });
          const curLast = last.get(p.id);
          const rej = bearerRejection(p.id, cred);
          if (rej && (curLast?.error !== rej.error || !!curLast?.authError !== !!rej.authError || curLast?.tokenHash !== cred.tokenHash)) {
            clearResetNotice(p.id);
            last.set(p.id, rejectedReading(rej, cred.tokenHash, cred.account, cred.gateKeys));
            push();
          } else if (!rej && (curLast?.expired || (cred.hasRefresh && curLast?.authError && curLast?.tokenHash === cred.tokenHash))) {
            restoreAccountCache(p, cred.account, cred.gateKeys);
            foldBgPlan(p, cred.account);
            push();
          }
          return inflight.get(p.id);
        }
        // On a recheck after another read published a fresh quota result for this exact account + bearer token
        // during this refresh, skip a duplicate fetch (tier-only folds do not bump publishedQuota).
        const pub = publishedQuota.get(p.id);
        const cur = last.get(p.id);
        if (attempt > 0 && !inflight.has(p.id) && !cred.expired && cur && !cur.error && !otherAccount(p, cur, cred.account, cred.gateKeys) && pub && pub.seq > startPublished && pub.tokenHash === cred.tokenHash) {
          activeKeys.set(p.id, cred.gateKeys);
          expiredCred.delete(p.id);
          activeToken.set(p.id, { tokenHash: cred.tokenHash, expiry: cred.expiry, hasRefresh: !!cred.hasRefresh });
          return;
        }
        // Account switched, bearer token rotated, or no read in flight for current credentials: start a fresh read.
        const gen = bumpGen(p.id);
        let runP;
        inflightKeys.set(p.id, cred.gateKeys);
        inflightToken.set(p.id, cred.tokenHash);
        runP = readFresh(p, force, cred, gen).finally(() => {
          if (inflight.get(p.id) === runP) {
            inflight.delete(p.id);
            inflightKeys.delete(p.id);
            inflightToken.delete(p.id);
          }
          push();
        });
        inflight.set(p.id, runP);
        return runP;
      }
      return inflight.get(p.id);
    })();
  }
  if (!inflight.has(p.id)) {
    const gen = p.peekCred ? bumpGen(p.id) : (accountGen.get(p.id) || 0);
    let runP;
    runP = readFresh(p, force, null, gen).finally(() => {
      if (inflight.get(p.id) === runP) {
        inflight.delete(p.id);
        inflightKeys.delete(p.id);
        inflightToken.delete(p.id);
      }
      push();
    });
    inflight.set(p.id, runP);
  }
  return inflight.get(p.id);
}

async function readFresh(p, force, suppliedCred = null, gen = accountGen.get(p.id) || 0) {
  // A --shot run paints the numbers the installed copy saved, and asks no provider: a read can renew a token on disk or
  // draw a 429 that every client of the account then waits out. CPU and RAM are this PC's, read as always.
  if (SHOT && !p.local) return;
  let now = Date.now();
  // Providers with peekCred (Antigravity) verify credentials on their own cadence (independent of quota attempts)
  // BEFORE releasing startup/re-enabled cache, folding in background tier updates, checking per-account gates, or
  // awaiting a quota request.
  let preCred = suppliedCred;
  if (p.peekCred) {
    if (!preCred) {
      const cur = last.get(p.id);
      const pendingPlan = !!(cur && !cur.error && cur.renewsFor && p.cachedPlan?.(cur.renewsFor) && p.cachedPlan(cur.renewsFor) !== cur.plan);
      const signedOutNow = !!cur?.signedOut;
      const until = gate.get(p.id) || 0;
      const gatedNow = now < until;
      const lastCheck = credChecked.get(p.id) || 0;
      const retryAt = credRetryAt.get(p.id) || 0;
      // A failed lookup's retry is due as its wait ends, beside a sign-in note too: never a whole cadence after the failure.
      const credDue = force || (
        retryAt > now ? false :
        retryAt > 0 ? true :
        unverified.has(p.id) || pendingPlan ? true :
        signedOutNow ? now - lastCheck >= p.everyMs :
        gatedNow ? now - lastCheck >= 60_000 :
        // An expired token: looked at again on the cadence, and as soon as a wait looked at under has lifted.
        (cur?.expired || expiredCred.has(p.id)) ? now - lastCheck >= p.everyMs || lastCheck < until :
        now - (fetched.get(p.id) || 0) >= p.everyMs
      );
      if (!credDue) return takeLocal(p);
      credChecked.set(p.id, now);
      preCred = await peekCred(p);
      // What follows acts on when the check landed, not when it began: a wait that lifted meanwhile holds nothing, and
      // the request goes now, so `fetched` must say now or the next scheduled one comes early.
      now = Date.now();
    }
    if (gen !== (accountGen.get(p.id) || 0)) return;
    if (preCred.status === 'error') {
      expireActiveToken(p, now);
      credFailed(p, now);
      return takeLocal(p);
    }
    const clearedCredErr = credAnswered(p);
    if (preCred.status === 'signed_out') {
      applySignedOut(p, preCred.error, now);
      return;
    }
    const switched = otherAccount(p, last.get(p.id), preCred.account, preCred.gateKeys) ||
      otherAccount(p, cache[p.id], preCred.account, preCred.gateKeys) ||
      otherAccount(p, fetchedFor.get(p.id), preCred.account, preCred.gateKeys);
    if (!suppliedCred || switched) gen = bumpGen(p.id);
    activeKeys.set(p.id, preCred.gateKeys);
    if (switched) {
      publishedQuota.delete(p.id);
      rateCleared.delete(p.id);
      clearResetNotice(p.id);
      unverified.delete(p.id);
      fetched.delete(p.id);
      fetchedFor.delete(p.id);
    }
    // Another account's reading goes; this one's, named anew (an email gone), takes the new name.
    forgetAccount(p, preCred.account, preCred.gateKeys);
    if (signedIn.get(p.id) !== preCred.account && (switched || signedIn.has(p.id))) {
      signedIn.set(p.id, preCred.account);
      saveState({ signedIn: Object.fromEntries(signedIn) });
    }
    // Check local token expiry BEFORE releasing unverified startup/re-enabled cache or folding background tier,
    // so a matching expired token never flashes stale cached quota before reporting session expiry.
    if (preCred.expired) return applyExpired(p, preCred, now);
    expiredCred.delete(p.id);
    activeToken.set(p.id, { tokenHash: preCred.tokenHash, expiry: preCred.expiry, hasRefresh: !!preCred.hasRefresh });
    // The account's deadline under any key it has shown, so a rotated bearer or a dropped email can't skip the wait. Armed
    // before anything shows, so a wait left from another account (one before a switch-off) never shows beside this one.
    const held = armGate(p, preCred.gateKeys, now) > now;
    const rej = bearerRejection(p.id, preCred);
    let restoredRej = false;
    const curLast = last.get(p.id);
    if (rej && (curLast?.error !== rej.error || !!curLast?.authError !== !!rej.authError || curLast?.tokenHash !== preCred.tokenHash)) {
      // The same bearer the endpoint already refused/denied (after a restart, a failed post-fetch check, or switching
      // A -> B -> A during its cooldown): keep its error note instead of releasing cached quota or waiting indefinitely.
      clearResetNotice(p.id);
      last.set(p.id, rejectedReading(rej, preCred.tokenHash, preCred.account, preCred.gateKeys));
      restoredRej = true;
    }
    if (switched) push();
    else {
      const shown = unverified.delete(p.id);
      // A valid token after one that expired, after a bearer whose error was already superseded by a newer 429/200
      // (whose post-fetch lookup failed), or after a different bearer's auth/permission error (held under a Retry-After):
      // the account's last numbers come back in place of the stale error, whether a wait holds the read or it fails.
      const was = last.get(p.id);
      const rc = rateCleared.get(p.id);
      const rcMatch = !!(rc && rc.seq > (was?.errSeq || 0) && !otherAccount(p, { renewsFor: rc.account, gateKeys: rc.gateKeys }, preCred.account, preCred.gateKeys));
      const lifted = !rej && (!!was?.expired || !!(was?.error && !was.signedOut && (was.tokenHash || rcMatch)));
      if (lifted) cache[p.id] ? last.set(p.id, cache[p.id]) : last.delete(p.id);
      foldBgPlan(p, preCred.account);
      if (shown || lifted || restoredRej || clearedCredErr) push();
    }
    if (held) return takeLocal(p);
    if (!force && !switched && now - (fetched.get(p.id) || 0) < p.everyMs) return takeLocal(p);
  } else {
    // The gate is the whole rate-limit answer: a 429's Retry-After stops every later request,
    // including the ones you ask for by hand. Refusing locally is what keeps us off the endpoint. Meanwhile, and between
    // reads, a provider with local numbers (Claude: other clients' files) shows them when they are newer.
    if (now < (gate.get(p.id) || 0)) return takeLocal(p);
    if (!force && now - (fetched.get(p.id) || 0) < p.everyMs) return takeLocal(p);
  }
  let curCred = preCred;
  let res;
  let recordedUntil = 0;
  let fetchedAt = 0;
  let reqSeq = 0;
  const offs = disableGen.get(p.id) || 0;
  const isOn = () => enabled.includes(p.id) && (disableGen.get(p.id) || 0) === offs;
  for (let retry = 0; ; retry++) {
    if (p.peekCred) {
      inflightKeys.set(p.id, curCred.gateKeys);
      inflightToken.set(p.id, curCred.tokenHash);
      fetchedFor.set(p.id, { renewsFor: curCred.account, gateKeys: curCred.gateKeys });
    }
    fetched.set(p.id, (fetchedAt = retry === 0 ? now : Date.now()));
    // A transport retry goes only while this read is still the current one (a sign-out, another account or the provider
    // switched off moves the generation) and no wait has come meanwhile for its keys.
    const canRetry = (keys) => gen === (accountGen.get(p.id) || 0) && enabled.includes(p.id) && accountGateUntil(p, keys) <= Date.now();
    // A Retry-After is recorded as its headers land, before a 403's body is read, so a refresh made meanwhile (a rotated
    // bearer's, which joins no request in flight) finds it. Once per answer: each check since copies it onto its keys.
    recordedUntil = 0;
    const onRetryAfter = (secs, keys) => {
      recordedUntil = Date.now() + secs * 1000;
      setAccountGate(p, keys, recordedUntil);
    };
    reqSeq = ++authSeq;
    res = await p.read(curCred || undefined, { canRetry, isOn, onRetryAfter });
    if (!p.peekCred) break;
    // Record any 429 Retry-After on arrival, BEFORE awaiting the post-fetch credential check, so a concurrent refresh
    // can't slip past it. It goes on every key linked to the request's by now, and on `__weak__` when a check saw the
    // account's bearer bare while the request was out (res.gateKeys, from providers.js).
    if (!recordedUntil && res.retryAfter > 0 && Number.isFinite(res.retryAfter)) {
      recordedUntil = Date.now() + res.retryAfter * 1000;
      setAccountGate(p, res.gateKeys || curCred.gateKeys, recordedUntil);
    }
    // Record a bearer refusal/denial (401/auth-403 or 403 permission denial) or definitive non-error / 429 / non-bearer
    // answer on arrival alongside any cooldown, BEFORE the post-fetch check, so switching away (A -> B -> A), restarting,
    // or a failed post-fetch check never loses the error AND a newer answer always beats a late older one even if superseded.
    let rejectedNow = false;
    let clearedNow = false;
    if (res.error && res.tokenHash && (!res.soft || res.authError)) {
      rejectedNow = setAuthRejected(p.id, res.tokenHash, res.error, reqSeq, !!res.authError);
    } else if (curCred?.tokenHash && (!res.error || res.error === 'Rate limited' || !res.soft)) {
      clearedNow = clearAuthRejected(p.id, curCred.tokenHash, reqSeq);
      if (clearedNow && (!res.error || res.error === 'Rate limited') && reqSeq >= (rateCleared.get(p.id)?.seq || 0)) {
        rateCleared.set(p.id, { seq: reqSeq, account: curCred.account, gateKeys: curCred.gateKeys });
      }
    }
    // Require a successful post-fetch credential check matching the same generation and account before publishing.
    // A failed lookup, sign-out, account switch, or superseded generation discards the response. The account may have
    // another name by now (an email gone or come, the bearer or refresh token kept): a key both show says it is the same.
    let staleGen = gen !== (accountGen.get(p.id) || 0);
    const afterCred = staleGen ? null : await peekCred(p);
    if (!staleGen && gen !== (accountGen.get(p.id) || 0)) staleGen = true;
    // Re-check after awaiting peekCred(p): a newer response for this bearer may have arrived while the lookup was pending.
    const stillNewest = !!curCred?.tokenHash && authAnswered.get(curCred.tokenHash) === reqSeq;
    const movedAway = staleGen ||
      afterCred?.status !== 'ok' ||
      (afterCred.account !== curCred.account && !sameKeys(p, curCred, afterCred.gateKeys));
    if (movedAway) {
      if (staleGen) {
        let changed = false;
        if (recordedUntil && activeKeys.has(p.id)) {
          // A superseded request's late Retry-After holds the provider only when it holds back the credential in use now:
          // the same account under any key, or a bare bearer nothing names under `__weak__`. Either way it is already
          // recorded. Beside an error note it holds off screen (snapshot), so the next look for a valid token comes as it lifts.
          const before = gate.get(p.id) || 0;
          if (armGate(p, activeKeys.get(p.id)) > before) {
            saveState({ gate: Object.fromEntries(gate) });
            changed = true;
          }
        }
        // If this late response is still the newest answer for the currently verified bearer (e.g., A1 in flight ->
        // rotated to A2 with a 503 Retry-After -> switched back to A1 during cooldown -> original A1 returns 401/403),
        // reflect the bearer's refusal or lift on screen right away instead of waiting for the next 60s poll or leaving
        // Refresh disabled under stale numbers. Once the active bearer's local expiry has passed, show Session expired
        // (keeping Refresh enabled) rather than lifting back to cached quota or overwriting expiry with a 403.
        const curTok = activeToken.get(p.id);
        if (curTok && curTok.tokenHash === curCred.tokenHash && !unverified.has(p.id)) {
          const tokExpired = Number.isFinite(curTok.expiry) && curTok.expiry <= Date.now();
          const curLast = last.get(p.id);
          if (tokExpired && !curTok.hasRefresh) {
            if (!curLast?.authError && !curLast?.expired) {
              clearResetNotice(p.id);
              const keys = p.gateAliases ? provenKeys(p, curCred.gateKeys, activeKeys.get(p.id)) : (activeKeys.get(p.id) || curCred.gateKeys);
              last.set(p.id, { error: 'Session expired — open Antigravity.', renewsFor: curLast?.renewsFor || signedIn.get(p.id) || curCred.account, gateKeys: keys, expired: true });
              changed = true;
            }
          } else if (stillNewest) {
            if (rejectedNow && res.tokenHash === curCred.tokenHash) {
              const rej = bearerRejection(p.id, { tokenHash: res.tokenHash, hasRefresh: curTok.hasRefresh });
              if (rej) {
                if (curLast?.error !== rej.error || !!curLast?.authError !== !!rej.authError || curLast?.tokenHash !== res.tokenHash) {
                  clearResetNotice(p.id);
                  const keys = p.gateAliases ? provenKeys(p, curCred.gateKeys, activeKeys.get(p.id)) : (activeKeys.get(p.id) || curCred.gateKeys);
                  last.set(p.id, rejectedReading(rej, res.tokenHash, curLast?.renewsFor || signedIn.get(p.id) || curCred.account, keys));
                  changed = true;
                }
              } else if (curTok.hasRefresh && res.authError && curLast?.error && !curLast.signedOut && (curLast.tokenHash === curCred.tokenHash || curLast.expired || (!curLast.tokenHash && (!curLast.errSeq || reqSeq > curLast.errSeq)))) {
                restoreAccountCache(p, curCred.account, curCred.gateKeys);
                changed = true;
              }
            } else if (clearedNow && curLast?.error && !curLast.signedOut && (curLast.tokenHash === curCred.tokenHash || (!curLast.tokenHash && (!res.error || res.error === 'Rate limited') && reqSeq > (curLast.errSeq || 0)))) {
              restoreAccountCache(p, curCred.account, curCred.gateKeys);
              changed = true;
            } else if (tokExpired && curTok.hasRefresh && curLast?.error && !curLast.signedOut && !bearerRejection(p.id, curTok)) {
              restoreAccountCache(p, curLast?.renewsFor || signedIn.get(p.id) || curCred.account, curCred.gateKeys);
              changed = true;
            }
          } else if (tokExpired && curTok.hasRefresh && curLast?.error && !curLast.signedOut && !bearerRejection(p.id, curTok)) {
            restoreAccountCache(p, curLast?.renewsFor || signedIn.get(p.id) || curCred.account, curCred.gateKeys);
            changed = true;
          }
        }
        if (changed) push();
      }
      if (!staleGen) {
        if (afterCred?.status === 'error') {
          fetched.delete(p.id);
          fetchedFor.delete(p.id);
          // A wait from this response (429/503/401/403 Retry-After) is already recorded for the account on arrival;
          // arm the live gate too so desktop and phone reflect the active cooldown right away when cached numbers stay
          // on screen (beside an error note, snapshot keeps waitMs at 0 so Refresh stays enabled).
          if (recordedUntil) {
            const before = gate.get(p.id) || 0;
            if (armGate(p, activeKeys.get(p.id) || curCred.gateKeys) > before) {
              saveState({ gate: Object.fromEntries(gate) });
            }
          }
          // The refused/denied bearer's reading goes at once, though the check failed: its error note, and no numbers.
          // Had another account signed in meanwhile, the next check that answers drops the note for it.
          // Once a non-refreshable bearer's local expiry has passed, show Session expired (keeping Refresh enabled)
          // rather than leaving cached rows behind a cooldown or overwriting expiry with a non-auth 403.
          const curTok = activeToken.get(p.id);
          const exp = curTok?.tokenHash === curCred.tokenHash ? curTok.expiry : curCred.expiry;
          const hasRefresh = curTok?.tokenHash === curCred.tokenHash ? curTok.hasRefresh : !!curCred.hasRefresh;
          const curLast = last.get(p.id);
          const tokExpired = !!curLast?.expired || (Number.isFinite(exp) && exp <= Date.now());
          if (tokExpired && !hasRefresh) {
            if (!curLast?.authError && !curLast?.expired) {
              clearResetNotice(p.id);
              last.set(p.id, { error: 'Session expired — open Antigravity.', renewsFor: curCred.account, gateKeys: curCred.gateKeys, expired: true });
            }
          } else if (rejectedNow && stillNewest && res.tokenHash) {
            const rej = bearerRejection(p.id, { tokenHash: res.tokenHash, hasRefresh });
            if (rej) {
              if (curLast?.error !== rej.error || !!curLast?.authError !== !!rej.authError || curLast?.tokenHash !== res.tokenHash) {
                clearResetNotice(p.id);
                last.set(p.id, rejectedReading(rej, res.tokenHash, curCred.account, curCred.gateKeys));
              }
            } else if (hasRefresh && res.authError && curLast?.error && !curLast.signedOut && (curLast.tokenHash === curCred.tokenHash || curLast.expired || (!curLast.tokenHash && (!curLast.errSeq || reqSeq > curLast.errSeq)))) {
              restoreAccountCache(p, curCred.account, curCred.gateKeys);
            }
          } else if (tokExpired && hasRefresh && curLast?.error && !curLast.signedOut && !bearerRejection(p.id, { tokenHash: curCred.tokenHash, hasRefresh })) {
            restoreAccountCache(p, curCred.account, curCred.gateKeys);
          }
          credFailed(p, Date.now(), recordedUntil);
        } else if (afterCred?.status === 'signed_out') {
          credAnswered(p);
          applySignedOut(p, afterCred.error);
        } else if (afterCred?.status === 'ok') {
          bumpGen(p.id);
          publishedQuota.delete(p.id);
          rateCleared.delete(p.id);
          activeKeys.set(p.id, afterCred.gateKeys);
          credAnswered(p);
          clearResetNotice(p.id);
          forgetAccount(p, afterCred.account, afterCred.gateKeys);
          unverified.delete(p.id);
          signedIn.set(p.id, afterCred.account);
          fetched.delete(p.id);
          fetchedFor.delete(p.id);
          if (afterCred.expired) return applyExpired(p, afterCred);
          expiredCred.delete(p.id);
          activeToken.set(p.id, { tokenHash: afterCred.tokenHash, expiry: afterCred.expiry, hasRefresh: !!afterCred.hasRefresh });
          // The account now in use may be under a wait of its own, or, a bare bearer, under `__weak__`.
          armGate(p, afterCred.gateKeys);
          const rej = bearerRejection(p.id, afterCred);
          if (rej) last.set(p.id, rejectedReading(rej, afterCred.tokenHash, afterCred.account, afterCred.gateKeys));
          saveState({ signedIn: Object.fromEntries(signedIn) });
          push();
        }
      }
      return;
    }
    credAnswered(p);
    activeKeys.set(p.id, afterCred.gateKeys);
    // The token ran out while its request was out: the answer goes unshown and unsaved (a 429 in it is recorded above).
    if (afterCred.expired) {
      forgetAccount(p, afterCred.account, afterCred.gateKeys);
      return applyExpired(p, afterCred);
    }
    expiredCred.delete(p.id);
    activeToken.set(p.id, { tokenHash: afterCred.tokenHash, expiry: afterCred.expiry, hasRefresh: !!afterCred.hasRefresh });
    // The bearer was replaced while its request was out (the same account): the screens follow the one installed now,
    // whatever the old one got. One the endpoint has refused/denied shows its error note; any other lifts a note left
    // for another bearer, the old one's included.
    if (afterCred.tokenHash !== curCred.tokenHash) {
      const was = last.get(p.id);
      const rej = bearerRejection(p.id, afterCred);
      const rc = rateCleared.get(p.id);
      const rcMatch = !!(rc && rc.seq > (was?.errSeq || 0) && !otherAccount(p, { renewsFor: rc.account, gateKeys: rc.gateKeys }, afterCred.account, afterCred.gateKeys));
      const softAuthLift = !!(afterCred.hasRefresh && res.authError && was?.error && !was.signedOut && (!was.errSeq || reqSeq > was.errSeq));
      const lifted = !rej && (!!was?.expired || softAuthLift || !!(was?.error && !was.signedOut && (was.tokenHash || rcMatch)));
      if (rej) {
        clearResetNotice(p.id);
        last.set(p.id, rejectedReading(rej, afterCred.tokenHash, afterCred.account, afterCred.gateKeys));
      } else if (lifted) restoreAccountCache(p, afterCred.account, afterCred.gateKeys);
      // The old bearer hit a hard error (401, 403 permission/scope error, etc.) or a soft auth error while a
      // replacement bearer is already installed: never keep the old bearer's failure when a new bearer is ready.
      // Advance the generation and retry once with the current token unless a cooldown holds it back.
      if (res.error && (!res.soft || res.authError)) {
        gen = bumpGen(p.id);
        forgetAccount(p, afterCred.account, afterCred.gateKeys);
        const tNow = Date.now();
        if (armGate(p, afterCred.gateKeys, tNow) > tNow) {
          if (lifted || rej) push();
          return takeLocal(p);
        }
        if (lifted || rej) push();
        if (retry < 1) {
          curCred = afterCred;
          continue;
        }
        fetched.delete(p.id);
        fetchedFor.delete(p.id);
        return;
      }
      // Any other answer, a reading included, goes unshown and unsaved beside the refused/denied bearer's note: it
      // only says the old bearer is not refused. A wait it brought is recorded above.
      if (rej) {
        bumpGen(p.id);
        armGate(p, afterCred.gateKeys);
        return;
      }
    } else {
      const curLast = last.get(p.id);
      const rej = bearerRejection(p.id, afterCred);
      if (res.authError) {
        // Align a 401/auth-403 with the post-fetch credential's refresh_token state and latest bearer answer.
        if (afterCred.hasRefresh || !stillNewest) {
          res = { ...res, soft: true };
          delete res.tokenHash;
          if (rej) {
            if (curLast?.error !== rej.error || !!curLast?.authError !== !!rej.authError || curLast?.tokenHash !== afterCred.tokenHash) {
              clearResetNotice(p.id);
              last.set(p.id, rejectedReading(rej, afterCred.tokenHash, afterCred.account, afterCred.gateKeys));
            }
          } else if (afterCred.hasRefresh && curLast?.error && !curLast.signedOut && (curLast.tokenHash === afterCred.tokenHash || curLast.expired || (!curLast.tokenHash && (!curLast.errSeq || reqSeq > curLast.errSeq)))) {
            restoreAccountCache(p, afterCred.account, afterCred.gateKeys);
          }
        } else {
          res = { ...res, soft: false, tokenHash: afterCred.tokenHash };
        }
      } else if (rej && ((res.error && res.soft && res.error !== 'Rate limited') || curLast?.expired)) {
        if (curLast?.error !== rej.error || !!curLast?.authError !== !!rej.authError || curLast?.tokenHash !== afterCred.tokenHash) {
          clearResetNotice(p.id);
          last.set(p.id, rejectedReading(rej, afterCred.tokenHash, afterCred.account, afterCred.gateKeys));
        }
      } else if (!rej && (curLast?.expired || (afterCred.hasRefresh && curLast?.authError && curLast?.tokenHash === afterCred.tokenHash))) {
        restoreAccountCache(p, afterCred.account, afterCred.gateKeys);
      }
    }
    // The answer goes under the account's name now, with every key it was read under; forgetAccount renames the rest.
    if (afterCred.account !== curCred.account) Object.assign(res, { renewsFor: afterCred.account, gateFor: afterCred.gateKey, gateKeys: provenKeys(p, res.gateKeys, afterCred.gateKeys) });
    // The bearer that fetched, which can be the one the credential has just replaced.
    if (!res.error) publishedQuota.set(p.id, { seq: ++publishSeq, tokenHash: curCred.tokenHash });
    bumpGen(p.id);
    break;
  }
  preCred = curCred;
  if (res.signedOut) {
    applySignedOut(p, res.error);
    return;
  }
  if (res.renewsFor && !res.accountUnknown) signedIn.set(p.id, res.renewsFor);
  // One that knows no account leaves the last one known, which after a restart is the reading on hand's, before it goes.
  else if (res.accountUnknown && !signedIn.has(p.id) && !last.get(p.id)?.accountUnknown && last.get(p.id)?.renewsFor) signedIn.set(p.id, last.get(p.id).renewsFor);
  if (res.renewsFor) saveState({ signedIn: Object.fromEntries(signedIn) });
  forgetAccount(p, res.renewsFor, res.gateKeys);
  const prev = last.get(p.id);
  // A 429's Retry-After, whether or not a reading came with it: nothing is asked before it, and the read is due
  // again the moment it lifts rather than a whole cadence later, so the numbers fall behind as little as they can.
  // A delay of 0 is due at once.
  const delayed = Number.isFinite(res.retryAfter) && res.retryAfter >= 0;
  const nowAfter = Date.now();
  const knownWait = p.peekCred ? accountGateUntil(p, activeKeys.get(p.id) || res.gateKeys || preCred.gateKeys, nowAfter) : 0;
  if (delayed || knownWait > nowAfter) {
    // From the 429's arrival, not the request's start. An account-checked provider recorded it per account on arrival,
    // and shows the longest wait that account is under (including one discovered when the post-fetch credential check
    // linked another key to this account), so a shorter or un-gated answer never hides an active wait.
    const until = Math.max(delayed ? (recordedUntil || nowAfter + res.retryAfter * 1000) : 0, knownWait);
    gate.set(p.id, until);
    fetched.delete(p.id); // the gate alone holds it back now
    fetchedFor.delete(p.id);
    saveState({ gate: Object.fromEntries(gate), accountGates: prunedAccountGates(nowAfter) });
  } else if (p.peekCred) {
    // A late 429 for another account may have temporarily armed `__weak__` (wiping `fetched`) while this request was
    // out, and a second late response may already have cleared that expired gate before publish: always restore the
    // polling floor and clear any stale live gate when the verified account has no active cooldown.
    if (!fetched.has(p.id)) {
      fetched.set(p.id, fetchedAt || nowAfter);
      fetchedFor.set(p.id, { renewsFor: res.renewsFor || preCred.account, gateKeys: activeKeys.get(p.id) || res.gateKeys || preCred.gateKeys });
    }
    if (gate.delete(p.id)) saveState({ gate: Object.fromEntries(gate) });
  }
  if (res.error && res.soft) {
    // A rate limit, a timeout, a server error, no network: none is news or anything to act on, so none shows a
    // message. The numbers on screen stay, or the section waits for its first, and only their age says they've
    // fallen behind, past ten minutes, as for any provider. A 429 also ends an earlier error, since the endpoint
    // did answer; other failures leave one that asks you to act (a sign-in), a 503 with a Retry-After too. Every
    // provider's 429, and only its 429, comes back as 'Rate limited'.
    if (res.error === 'Rate limited') {
      if (!prev?.rows?.length) p.peekCred && cache[p.id] && !otherAccount(p, cache[p.id], res.renewsFor, res.gateKeys) ? last.set(p.id, cache[p.id]) : last.delete(p.id);
    }
    return takeLocal(p);
  }
  // A fallback (it carries `why`) is an old observation, and can be older than the numbers on screen.
  // Then it's no news: keep the newer ones and never read the drop as a reset.
  // Undated counts as oldest. Live readings skip this: they are "now", whatever the clock did.
  if (res.why && prev?.rows?.length && (res.updatedAt ?? -Infinity) < (prev.updatedAt ?? -Infinity)) return;
  // A reading that says nothing of the next bill (its lookup failed, a restart hasn't asked yet, or there was no sign-in
  // to read) keeps the date on hand while it is ahead, and whose it is. One that says there is none (null) drops it.
  if (res.renewsAt === undefined && prev?.renewsAt > Date.now() && (res.renewsFor === undefined || res.renewsFor === prev.renewsFor)) {
    Object.assign(res, { renewsAt: prev.renewsAt, renewsGuess: prev.renewsGuess, renewsFor: prev.renewsFor });
  }
  // Use the newest verified tier for this account (including one linked or settled while the post-fetch check was out),
  // or preserve the same account's cached plan while a background tier lookup (loadCodeAssist) is still in flight.
  const latestPlan = !res.error && res.renewsFor ? p.cachedPlan?.(res.renewsFor) : '';
  if (latestPlan) res.plan = latestPlan;
  else if (!res.error && !res.plan && prev?.plan && res.renewsFor && res.renewsFor === prev.renewsFor) {
    res.plan = prev.plan;
  }
  if (res.error) clearResetNotice(p.id);
  if (p.peekCred && res.error && !res.tokenHash) res.errSeq = reqSeq;
  // A reading keeps every key its account was proven by, not just the ones this credential carried.
  if (p.gateAliases && !res.error) res.gateKeys = provenKeys(p, [...(prev?.gateKeys || []), ...(cache[p.id]?.gateKeys || [])], res.gateKeys);
  last.set(p.id, res);
  // CPU and RAM fall all the time, which is no reset, and a reading from before a restart is no use. Nor is one
  // account's usage falling below another's.
  // ponytail: Codex keeps its old behaviour, so a Codex account switch can still beep; drop the id check to cover it.
  if (!res.error && !p.local) {
    if (!((p.id === 'claude' || p.id === 'antigravity') && otherAccount(p, prev, res.renewsFor))) showResetNotice(p, resetRows(prev?.rows, res.rows));
    cache[p.id] = res;
    saveState({ cache });
  }
}

// Whether a reading on hand is another account's than the one a read or local copy names. A reading that can't tell
// whose it is (no sign-in to read) says nothing either way, but Claude's and Antigravity's saved before readings named
// theirs can't be shown to be this account's, so they count as another's. An account-checked provider's reading stays
// this account's when it was read with a key the credential's keys are, or are proven to be (p.gateAliases): a dropped
// email or a named bearer changes the account's name, not the account. `__weak__` proves nothing.
const sameKeys = (p, r, keys) => !!(keys && p.gateAliases && r.gateKeys) && p.gateAliases(keys).some((k) => k !== '__weak__' && r.gateKeys.includes(k));
const otherAccount = (p, r, account, keys) => !!(r && account && (r.renewsFor ? r.renewsFor !== account && !sameKeys(p, r, keys) : p.id === 'claude' || p.id === 'antigravity'));
// Every key proven to be one account's: the named ones a reading had, the credential's, and all linked to them. A bearer
// it had stays while linked (agAliases keeps 128, and a restart links the saved reading's), so the list stays bounded.
const provenKeys = (p, had, keys) => p.gateAliases([...(had || []).filter((k) => !k.startsWith('tok:')), ...(keys || [])]).filter((k) => k !== '__weak__');
const sameSet = (a, b) => a.length === b?.length && a.every((k) => b.includes(k));

// Drop data that belongs to a different account. For Antigravity, drop the entire stale reading and cache so a soft
// failure for the new account never keeps the previous account's numbers on screen or triggers a false reset. The same
// account's reading under its old name takes the new one, with every key it was read under, and stays.
// Per-account 429 deadlines remain in accountGates so switching A -> B -> A still respects A's deadline.
function forgetAccount(p, account, keys) {
  if (p.id === 'antigravity') {
    const kept = (r) => {
      if (!r || !account) return r;
      if (otherAccount(p, r, account, keys)) return undefined;
      const gateKeys = provenKeys(p, r.gateKeys, keys);
      return r.renewsFor === account && sameSet(gateKeys, r.gateKeys) ? r : { ...r, renewsFor: account, gateKeys };
    };
    const shown = kept(last.get(p.id));
    if (shown !== last.get(p.id)) shown ? last.set(p.id, shown) : last.delete(p.id);
    const saved = kept(cache[p.id]);
    if (saved !== cache[p.id]) {
      if (saved) cache[p.id] = saved;
      else delete cache[p.id];
      saveState({ cache });
    }
    return;
  }
  const fields = ['renewsAt', 'renewsGuess'];
  if (p.id === 'claude') fields.push('plan', 'bankedResets', 'bankedResetExpiries');
  const forget = (r) => {
    if (!otherAccount(p, r, account) || !fields.some((field) => Object.hasOwn(r, field))) return r;
    const rest = { ...r };
    for (const field of fields) delete rest[field];
    return rest;
  };
  if (last.has(p.id)) last.set(p.id, forget(last.get(p.id)));
  const kept = forget(cache[p.id]);
  if (kept !== cache[p.id]) {
    cache[p.id] = kept;
    saveState({ cache });
  }
}

// Which of two sightings of one usage line is the later truth: the one on screen (mine) or a local source's (theirs).
// A source's date need not hold for every line it carries, so each line is judged on its own, and a local line counts only when it is provably in the period under way now: its
// reset time is still ahead. One whose period has ended, or with no reset time, never displaces ours, unless neither
// side is dated. Ours, undated (a window not started) or ended, gives way to a current one. Both current: a later reset
// time is a new period; otherwise it is one period, where usage only climbs, so the higher number is the later one.
// Two sources write one period's reset time a few milliseconds apart; the next period's is hours on.
const PERIOD_SLACK = 30 * 60_000;
function laterLine(mine, theirs, now = Date.now()) {
  const [a, b] = [Date.parse(mine.resetsAt), Date.parse(theirs.resetsAt)];
  const current = (t) => t > now; // NaN, no reset time, is never current
  if (!current(b)) return Number.isNaN(a) && Number.isNaN(b) && theirs.percent > mine.percent ? theirs : mine;
  if (!current(a)) return theirs;
  if (Math.abs(b - a) > PERIOD_SLACK) return b > a ? theirs : mine;
  return theirs.percent > mine.percent ? theirs : mine;
}

// A provider's local numbers (readLocal: no request), from a snapshot newer than the reading on screen, line by line
// (laterLine). A line not on screen yet is added only when it is current: its reset time still ahead, or a window
// not started (0% with none). The reading is dated by the copy, and a failed read's note goes, only when the copy
// vouches for every line on screen: each one moved to the copy's or agrees with it. A line it lacks or disputes may be
// stale, so then the lines that moved land, and the reading keeps its age and note. Only the usage moves: the plan,
// the API credit and the banked resets stay as last read. A drop can only be a new period, so it is announced as a
// reset, as from the endpoint.
// A copy counts only for the account signed in: the one the last read that knew it named, or before any the reading's own. Any
// other (Claude Code's record of who signed in can lag its token) is left alone, and never takes the plan away. A copy
// for that account, with a reading still on hand from another (the read that named it failed), replaces that reading
// but for its API credit: its lines are never weighed against another account's, nor its drop announced as a reset.
function takeLocal(p) {
  const local = p.readLocal?.();
  if (!local) return;
  let prev = last.get(p.id);
  const account = signedIn.get(p.id) ?? prev?.renewsFor;
  if (account !== undefined && local.renewsFor !== account) return;
  // A live reading no account vouches for yet may well be this one's, so only a newer copy displaces it.
  if (prev?.accountUnknown && !(local.updatedAt > (prev.updatedAt ?? -Infinity))) return;
  if (otherAccount(p, prev, local.renewsFor)) prev = prev.apiCredit ? { apiCredit: prev.apiCredit } : undefined; // the Console key's, not the account's
  if (prev?.rows?.length && !(local.updatedAt > (prev.updatedAt ?? -Infinity))) return;
  const now = Date.now();
  const current = (r) => Date.parse(r.resetsAt) > now || (!r.resetsAt && r.percent === 0);
  const theirs = new Map(local.rows.map((r) => [r.label, r]));
  const samePeriod = (a, b) => (!a.resetsAt && !b.resetsAt) || Math.abs(Date.parse(a.resetsAt) - Date.parse(b.resetsAt)) <= PERIOD_SLACK;
  let changed = false;
  let unverified = 0; // lines on screen the copy doesn't vouch for
  const rows = (prev?.rows || []).map((r) => {
    const t = theirs.get(r.label);
    const next = t ? laterLine(r, t, now) : r;
    if (next !== r) changed = true;
    else if (!(t && current(t) && t.percent === r.percent && samePeriod(r, t))) unverified++;
    return next;
  });
  const added = local.rows.filter((r) => !rows.some((k) => k.label === r.label) && current(r));
  rows.push(...added);
  if (added.length) changed = true;
  if (!rows.length || (!changed && unverified)) return; // nothing it says is newer than ours
  const { note, error, ...rest } = prev || {};
  const next = unverified ? { ...prev, rows } : { ...rest, rows, updatedAt: local.updatedAt, ...(local.renewsFor ? { renewsFor: local.renewsFor } : {}) };
  last.set(p.id, next);
  showResetNotice(p, resetRows(prev?.rows, next.rows));
  cache[p.id] = next;
  saveState({ cache });
}

// No push of its own: each read pushes as it settles (readOne), which re-renders the countdowns too.
async function tick(force = false) {
  if (!visible) return; // hidden means hidden: no polling, no requests
  await Promise.all(on().map((p) => readOne(p, force)));
}

// ---- the phone bubble (phone/), over Tailscale. It gets what the panel shows, and shares the theme,
// the providers and what each summary number reads with this overlay, both ways. The credentials stay in
// this process. The tailnet is the lock, and settings take JSON only (below), so a web page open on this
// PC can't post them.
// The tailnet also authorizes the keep-awake setting; the hotspot link authenticates with its shared secret.
const phones = new Set(); // open /api/events streams
let toldPhones = '';
// Every snapshot carries this run of the overlay and a number one higher than the last snapshot made, so a
// phone keeps the newest however they reach it: a read snapshots only once its providers answer or its wait runs
// out, so it can be newer than a stream message that left while it waited, though it arrives after it.
const run = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let snapshots = 0;
function phoneState() {
  const t = THEMES.find(([id]) => id === theme);
  // restoringSleep: switched off, and Windows still has some plugged-in sleep timers at Never (restoreLater).
  return { css: t ? t[2] : '', theme, enabled, choices, keepAwake: awakeBlocker !== null, restoringSleep: restoring(), providers: snapshot() };
}
const numbered = (state) => JSON.stringify({ ...state, run, rev: ++snapshots });
function phonePayload() {
  return numbered(phoneState());
}
// On every push and theme change, but only when something changed: the countdowns move once a minute,
// and a phone shouldn't wake every 15 s for the same numbers.
function tellPhones() {
  if (!phones.size) return;
  const state = phoneState();
  const same = JSON.stringify(state);
  if (same === toldPhones) return;
  toldPhones = same;
  const body = numbered(state);
  for (const res of phones) res.write('data: ' + body + '\n\n');
}

function servePhone() {
  const json = (res, body) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const answer = async (req, res) => {
    // A site that points its own name at 127.0.0.1 can't read this: only loopback and tailnet names.
    if (!/^(127\.0\.0\.1|localhost|[\w-]+\.[\w-]+\.ts\.net)(:\d+)?$/.test(req.headers.host || '')) return res.writeHead(403).end();
    const url = req.url.split('?')[0];
    if (url === '/fonts/geist.woff2') {
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' });
      return res.end(fs.readFileSync(path.join(__dirname, 'fonts', 'geist.woff2')));
    }
    if (url === '/api/usage') {
      // GET reads only what is due, as the tick would; POST is the phone's Refresh. Both stop at a 429's gate.
      // Neither waits on a slow read past its cap, since one can take 75 s to give up: the answer is what there is,
      // and the stream brings each later reading as it lands. The phone gives up on a GET at 20 s, and on a
      // Refresh at 60 s.
      let cap;
      const capped = new Promise((r) => (cap = setTimeout(r, req.method === 'POST' ? 45_000 : 5000)));
      await Promise.race([Promise.allSettled(on().map((p) => readOne(p, req.method === 'POST'))), capped]);
      clearTimeout(cap);
      return json(res, phonePayload());
    }
    if (url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('data: ' + phonePayload() + '\n\n');
      phones.add(res);
      return req.on('close', () => phones.delete(res));
    }
    if (url === '/api/link') {
      // The phone link's secret (link.js), for the phone over Tailscale only: the tailnet is what vouches for it.
      // Never down the link itself, whatever Host it says: a gateway that relays the handshake between this PC and
      // the phone can send its own GO and get a pipe to this port. Pipes come from link.PIPE_FROM, and
      // tailscale serve from 127.0.0.1.
      if (!/\.ts\.net(:\d+)?$/.test(req.headers.host) || [link.PIPE_FROM, '::ffff:' + link.PIPE_FROM].includes(req.socket.remoteAddress)) return res.writeHead(403).end();
      return json(res, { secret: link.secret() });
    }
    if (url === '/api/options') {
      // Only expose providers added after toggleProvider (Antigravity) to clients that request ?toggle=1 and can operate them.
      const supportsToggle = new URL(req.url, 'http://localhost').searchParams.get('toggle') === '1';
      const list = supportsToggle ? PROVIDERS : PROVIDERS.filter((p) => LEGACY_PROVIDERS.has(p.id));
      const choices = supportsToggle
        ? NUMBER_CHOICES
        : Object.fromEntries(Object.entries(NUMBER_CHOICES).filter(([id]) => LEGACY_PROVIDERS.has(id)));
      return json(res, { themes: THEME_GROUPS, providers: list.map(({ id, name, glyph, color }) => ({ id, name, glyph, color })), choices, pages: USAGE_PAGES, capabilities: { toggleProvider: true } });
    }
    if (url === '/api/settings' && req.method === 'POST') {
      // A form or a no-cors fetch from a page can't send JSON without a preflight, which this server never answers.
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return res.writeHead(415).end();
      let body = '';
      for await (const chunk of req) if ((body += chunk).length > 10_000) return res.writeHead(413).end();
      let want;
      try {
        want = JSON.parse(body);
      } catch {
        return res.writeHead(400).end();
      }
      if (!want || typeof want !== 'object' || Array.isArray(want)) return res.writeHead(400).end(); // null, a list, a bare value
      if (Object.hasOwn(want, 'keepAwake') && typeof want.keepAwake !== 'boolean') return res.writeHead(400).end();
      const hasToggle = Object.hasOwn(want, 'toggleProvider');
      if (hasToggle) {
        const tp = want.toggleProvider;
        if (!tp || typeof tp !== 'object' || Array.isArray(tp) || typeof tp.id !== 'string' || typeof tp.enabled !== 'boolean') return res.writeHead(400).end();
        if (PROVIDERS.some((p) => p.id === tp.id)) {
          setEnabled(tp.enabled ? [...enabled, tp.id] : enabled.filter((id) => id !== tp.id));
        }
      }
      if (typeof want.keepAwake === 'boolean') setKeepAwake(want.keepAwake);
      if (typeof want.theme === 'string') setTheme(want.theme);
      // When toggleProvider is present, ignore any companion legacy `enabled` list sent for older-PC compatibility.
      if (!hasToggle && Array.isArray(want.enabled)) {
        // Whole-list writes only manage the provider catalog that client version knows (LEGACY_PROVIDERS unless
        // `known` is passed); unmanaged providers strictly keep the PC's current enabled state so a legacy APK can
        // neither silently disable nor re-enable newer providers like Antigravity.
        const managed = Array.isArray(want.known)
          ? new Set(want.known.filter((id) => typeof id === 'string'))
          : LEGACY_PROVIDERS;
        const next = PROVIDERS
          .filter((p) => (managed.has(p.id) ? want.enabled.includes(p.id) : enabled.includes(p.id)))
          .map((p) => p.id);
        setEnabled(next);
      }
      if (want.choices && typeof want.choices === 'object') for (const [id, row] of Object.entries(want.choices)) setChoice(id, row);
      return json(res, phonePayload());
    }
    res.writeHead(404).end();
  };
  http
    .createServer((req, res) =>
      // An upload cut off midway, or a fault of ours: answer if there is still anyone to answer, and never
      // let it escape as an unhandled rejection in the main process.
      answer(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }))
    .on('error', () => {}) // the port is taken (a second copy): that copy just has no phone
    .listen(PHONE_PORT, '127.0.0.1');
  // A switch of network (the PC asleep, off the phone's hotspot, Tailscale stuck) leaves a stream open on the
  // phone with nothing coming: its pings are how the page tells that from a quiet PC.
  setInterval(() => phones.forEach((res) => res.write('event: ping\ndata: 1\n\n')), 20_000).unref();
}

// ---- geometry

const areaFor = (id) => (screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay()).workArea;

// A display turned, rescaled, unplugged or plugged back in: the capsule goes back on its edge at the size that
// display now allows (pillScale), on the primary one while its own is gone. Not mid-drag: the drop places it.
function watchDisplays() {
  for (const e of ['display-metrics-changed', 'display-removed', 'display-added']) screen.on(e, () => drag || place(false));
}

function windowSize() {
  const n = on().length;
  const [s, z] = [pillScale(), panelScale()];
  const size = vertical()
    ? { width: EDGE_GAP + SPINE * s + PANEL_W * z + PAD, height: Math.max(n * CHIP.v * s, PANEL_H * z) + 2 * PAD }
    : { width: Math.max(n * CHIP.h * s, PANEL_W * z) + 2 * PAD, height: EDGE_GAP + PILL_H * s + PANEL_H * z + PAD };
  // Never bigger than the display: on a short one the panel's rows scroll instead, since its max-height follows the window.
  const a = areaFor(displayId);
  return { width: Math.min(Math.ceil(size.width), a.width), height: Math.min(Math.ceil(size.height), a.height) };
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
  tellPhones();
  if (!alive()) return;
  const t = THEMES.find(([id]) => id === theme);
  win.webContents.send('layout', { edge, count: on().length, theme, css: t ? t[2] : '', scale: pillScale(), panel: panelScale() });
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
      noticeFor = null;
      setRevealed(true);
      setOpen(true);
    }
  } else {
    overSince = 0;
    if (noticeUntil > now) {
      closeAt = 0;
      setRevealed(true);
    } else {
      noticeFor = null;
      if (open || (autoHide && revealed)) {
        if (!closeAt) closeAt = now + CLOSE_MS;
        else if (now >= closeAt) {
          closeAt = 0;
          setOpen(false);
          if (autoHide) setRevealed(false);
        }
      }
    }
  }
  setIgnore(!over);
}

// ---- chrome
// The settings the phone shares, set from the tray menu or the phone alike. Each ignores what it doesn't know.

// Keep PC awake. Electron's powerSaveBlocker can't: its 'prevent-app-suspension' is Windows'
// PowerRequestExecutionRequired, which means "system required" only on S3 PCs, so this Modern Standby laptop
// slept on idle anyway; 'prevent-display-sleep' would keep the screen lit. A hidden PowerShell holds
// ES_SYSTEM_REQUIRED instead until its stdin closes: we kill it, quit, or crash. That kept every plugged-in
// screen-off spell of 2026-11-15 running (Kernel-Power 507: SleepEntered false), yet on 2026-11-16 the PC
// slept 38 min on mains with the switch on. So while it is on, every power plan's plugged-in sleep timer is
// Never too (holdSleep). Windows still sleeps when the lid closes, and on battery, where the timers stay,
// it drops the request 5 min after the sleep timeout.
const AWAKE_PS = `Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern int SetThreadExecutionState(int f);'; [void][W.P]::SetThreadExecutionState(0x80000001); [void][Console]::In.ReadToEnd()`;

function holdAwake() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', AWAKE_PS], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', (e) => console.error('keep awake:', e.message));
  // ponytail: one that dies while wanted comes back 10 s later, forever if PowerShell can't run at all
  child.on('exit', () => setTimeout(() => awakeBlocker === child && (awakeBlocker = holdAwake()), 10_000));
  return child;
}

// powercfg's labels are in the PC's language, so only GUIDs and hex numbers are read. /q of one setting has
// five numbers, minimum, maximum, step, plugged-in and battery; anything else is refused, never guessed at.
// No elevation needed, for any plan. The calls run on the main thread, so one hold or release gets 3 s in all
// (a call takes ~16 ms here), not 5 s for each call a hung powercfg would time out.
const PLAN = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;
let powercfgUntil = 0;
function powercfg(...args) {
  const left = powercfgUntil - Date.now();
  if (left <= 0) throw new Error('powercfg out of time');
  return execFileSync('powercfg', args, { windowsHide: true, encoding: 'utf8', timeout: left, stdio: ['ignore', 'pipe', 'pipe'] });
}
function plans() {
  const found = powercfg('/list').match(PLAN);
  if (!found) throw new Error('no power plans in powercfg /list');
  return found.map((p) => p.toLowerCase());
}
const setAcSleep = (plan, seconds) => powercfg('/setacvalueindex', plan, 'SUB_SLEEP', 'STANDBYIDLE', String(seconds));
function acSleep(plan) {
  const numbers = powercfg('/q', plan, 'SUB_SLEEP', 'STANDBYIDLE').match(/0x[0-9a-f]{1,8}\b/gi) || [];
  if (numbers.length !== 5) throw new Error(`no sleep timer in powercfg /q ${plan}`);
  return parseInt(numbers[3], 16);
}
const each = (list, fn) => list.forEach((x) => {
  try {
    fn(x);
  } catch (e) {
    console.error('keep awake:', e.message);
  }
});

// Each plan's own timer goes to disk before any changes. A plan on record that reads 0 is ours from before a
// crash, so its record stands; one that reads anything else has its own timer again (put back by a release
// that couldn't finish, or changed in Settings since), and that is the one to keep. A plan at Never and not
// on record has nothing to put back. Only a plan read just now goes to Never: one whose read failed may
// hold a timer its record doesn't know, so it is left alone, record and all.
// ponytail: plans are listed once per switch-on; one created while it is on keeps its own timer.
function holdSleep() {
  const read = [];
  each(plans(), (plan) => {
    const seconds = acSleep(plan);
    if (seconds > 0) sleepAc[plan] = seconds;
    read.push(plan);
  });
  saveState({ sleepAc: { ...sleepAc } });
  flushState();
  if (Object.keys(pending).length) throw new Error('state.json not written, sleep timers left alone');
  each(read.filter((plan) => Object.hasOwn(sleepAc, plan)), (plan) => setAcSleep(plan, 0));
  powercfg('/setactive', 'SCHEME_CURRENT'); // the active plan's timers apply only once it is set active again
}

// A timer that no longer reads 0 was changed by someone else meanwhile and keeps their value. A deleted
// plan drops off. The rest stay on record until they are back and the active plan applied them, for the next
// switch-off, quit or start to finish.
function releaseSleep() {
  const now = plans();
  const back = [];
  each(Object.entries(sleepAc), ([plan, seconds]) => {
    if (now.includes(plan) && acSleep(plan) === 0) setAcSleep(plan, seconds);
    back.push(plan);
  });
  try {
    powercfg('/setactive', 'SCHEME_CURRENT');
    for (const plan of back) delete sleepAc[plan];
  } finally {
    saveState({ sleepAc: { ...sleepAc } });
  }
}

// powercfg missing, hung or answering oddly must not stop startup, a switch, or quit's flush. A --shot run
// beside the installed copy leaves the power settings to that copy.
function keepSleep(hold) {
  if (SHOT) return;
  powercfgUntil = Date.now() + 3000;
  try {
    if (hold) holdSleep();
    else if (Object.keys(sleepAc).length) releaseSleep();
  } catch (e) {
    console.error('keep awake:', e.message);
  }
}

// Switched off with timers still on record, because powercfg refused or ran out of time: Windows keeps them at Never
// until a release goes through, though the switch says off. So the release is tried again by itself, a minute on,
// then 2, 4 and so on up to every 30 (a hung powercfg costs the main thread its 3 s each time), until Windows has them
// all; the menu and the phone say so meanwhile. A try is the same release as a switch-off's, so a timer changed in
// Settings since keeps the new value. Switching on or quitting cancels the next try, which also checks it is still off.
let restoreTimer = null;
let restoreDelay = 0;
const restoring = () => !SHOT && awakeBlocker === null && Object.keys(sleepAc).length > 0;
function restoreLater(first) {
  clearTimeout(restoreTimer);
  restoreTimer = null;
  if (!restoring()) return;
  restoreDelay = first ? 60_000 : Math.min(2 * restoreDelay, 30 * 60_000);
  restoreTimer = setTimeout(() => {
    restoreTimer = null;
    if (awakeBlocker !== null) return;
    keepSleep(false);
    restoreLater(false);
    tray?.setContextMenu(menu());
    tellPhones();
  }, restoreDelay);
  restoreTimer.unref?.();
}

function setKeepAwake(next) {
  // A --shot run leaves keeping the PC awake to the installed copy: no helper, no timers, nothing saved.
  if (SHOT || typeof next !== 'boolean' || next === (awakeBlocker !== null)) return;
  if (next) awakeBlocker = holdAwake();
  else {
    awakeBlocker.kill();
    awakeBlocker = null;
  }
  keepSleep(next);
  restoreLater(true);
  saveState({ keepAwake: next });
  tray?.setContextMenu(menu());
  tellPhones();
}

function setTheme(id) {
  if (!THEMES.some(([t]) => t === id)) return;
  theme = id;
  saveState({ theme });
  sendLayout();
  tray.setContextMenu(menu()); // radio groups don't span submenus; the rebuild unticks the old one
}

function setEnabled(ids) {
  const prev = new Set(enabled);
  // Keep the declared order however you toggle them, so cells never shuffle.
  enabled = PROVIDERS.filter((q) => ids.includes(q.id)).map((q) => q.id);
  for (const p of PROVIDERS) {
    if (!p.peekCred) continue;
    const nowOn = enabled.includes(p.id);
    if (!nowOn && prev.has(p.id)) {
      bumpGen(p.id);
      disableGen.set(p.id, (disableGen.get(p.id) || 0) + 1);
      if (inflightToken.has(p.id)) {
        fetched.delete(p.id);
        fetchedFor.delete(p.id);
      }
      inflight.delete(p.id);
      inflightKeys.delete(p.id);
      inflightToken.delete(p.id);
      activeKeys.delete(p.id);
      activeToken.delete(p.id);
      expiredCred.delete(p.id);
      clearResetNotice(p.id);
    } else if (nowOn && !prev.has(p.id)) {
      // Hide any prior state until live credentials confirm the account, and clear backoff so tick() verifies immediately.
      unverified.add(p.id);
      credAnswered(p);
    }
  }
  const st = readState();
  const extra = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string' && !PROVIDERS.some((q) => q.id === id)) : []);
  const savedEnabled = [...enabled, ...extra(st.enabled)];
  const known = [...extra(st.known), ...PROVIDERS.map((q) => q.id)];
  const disabled = [...extra(st.disabled), ...PROVIDERS.filter((q) => !enabled.includes(q.id)).map((q) => q.id)];
  saveState({ enabled: savedEnabled, known, disabled });
  tray.setContextMenu(menu());
  setOpen(false);
  place(true);
  push(); // the phones hear now, not after the readings the tick may wait on
  tick();
}

function setChoice(id, row) {
  // Own keys only: a "constructor" or "__proto__" from the phone names nothing here.
  if (!Object.hasOwn(NUMBER_CHOICES, id) || !NUMBER_CHOICES[id].some(([, r]) => r === row)) return;
  choices = { ...choices, [id]: row };
  saveState({ rings: choices }); // the key predates the redesign, so old settings carry over
  tray.setContextMenu(menu());
  push();
}

// The Console's sessionKey cookie, for the Claude API credit line. It unlocks the whole Console account,
// so it is checked before it can reach a request header, saved only encrypted to this Windows user, and
// taken off the clipboard. Electron 44 made reading the clipboard asynchronous.
async function pasteConsoleKey() {
  const key = (await clipboard.readText()).trim();
  if (!/^sk-ant-sid[\w-]+$/.test(key)) {
    dialog.showErrorBox('No Console session key on the clipboard', 'In Chrome, open platform.claude.com, press F12, and under Application > Cookies copy the value of sessionKey. Then pick Paste Console session key again.');
    return;
  }
  clipboard.clear();
  useConsoleKey(key, safeStorage.encryptString(key).toString('base64'));
}

// An undefined consoleSession drops the key from state.json, since JSON.stringify leaves it out.
function useConsoleKey(key, sealed) {
  hasConsoleKey = !!key;
  setConsoleKey(key);
  dropCredit();
  saveState({ consoleSession: sealed, cache });
  tray.setContextMenu(menu());
  push(); // now, whatever the gate, visibility or provider list: the old session's balance is gone
  // A read in flight began under the old session, and providers drops its credit; read again after it.
  Promise.resolve(inflight.get('claude')).then(() => tick(true));
}

// The credit belongs to one Console session. Usage rows stay; only the balance goes, shown and saved.
function dropCredit() {
  const without = ({ apiCredit, ...reading }) => reading;
  if (last.get('claude')?.apiCredit) last.set('claude', without(last.get('claude')));
  if (cache.claude?.apiCredit) cache.claude = without(cache.claude);
}

function menu() {
  const rebuild = () => tray.setContextMenu(menu());
  const numberMenus = on().filter((p) => NUMBER_CHOICES[p.id]).map((p) => ({
    label: p.name,
    submenu: NUMBER_CHOICES[p.id].map(([label, row]) => ({
      label,
      type: 'radio',
      checked: (choices[p.id] || '') === row,
      click: () => setChoice(p.id, row),
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
        click: (item) => setEnabled(item.checked ? [...enabled, p.id] : enabled.filter((id) => id !== p.id)),
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
          type: 'checkbox',
          checked: theme === id,
          click: () => setTheme(id),
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
    { label: 'Keep PC awake', type: 'checkbox', checked: awakeBlocker !== null, click: (item) => setKeepAwake(item.checked) },
    ...(restoring() ? [{ label: 'Sleep timers still at Never, retrying', enabled: false }] : []),
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
      submenu: PROVIDERS.filter((p) => USAGE_PAGES[p.id]).map((p) => ({ label: p.name, click: () => shell.openExternal(USAGE_PAGES[p.id]) })),
    },
    { label: 'Paste Console session key', click: pasteConsoleKey },
    ...(hasConsoleKey ? [{ label: 'Forget Console session key', click: () => useConsoleKey('', undefined) }] : []),
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
    noticeFor = null;
    noticeUntil = 0;
    win.webContents.send('reset', null);
    win.hide();
    setRevealed(false);
  }
  tray.setContextMenu(menu());
}

// A reading as an older build saved it, without what such a build said about a failed refresh: a note, or a
// warning on the API credit. The balance and an error you must act on stay.
function savedReading(v) {
  const { note, ...reading } = v || {};
  if (/^API credit not refreshed/.test(reading.apiCredit?.error)) {
    const { error, ...credit } = reading.apiCredit;
    if (Number.isFinite(credit.leftCents)) reading.apiCredit = credit;
    else delete reading.apiCredit;
  }
  // An older build could save Codex's count from /usage beside a newer list's dates; the list counts, as readCodex does now.
  if (Array.isArray(reading.bankedResetExpiries)) reading.bankedResets = reading.bankedResetExpiries.length;
  // The keys a reading's account was proven by are matched and linked as strings; anything else proves nothing.
  if (!(Array.isArray(reading.gateKeys) && reading.gateKeys.every((k) => typeof k === 'string'))) delete reading.gateKeys;
  return reading;
}

function loadState() {
  const st = readState();
  // A provider added after the state was saved starts on; `known` is what the saving build had, and `disabled` survives
  // a rollback to an older build whose save rewrote `known` without providers it did not know.
  const disabled = new Set(Array.isArray(st.disabled) ? st.disabled : []);
  if (Array.isArray(st.enabled)) enabled = PROVIDERS.filter((p) => st.enabled.includes(p.id) || (!disabled.has(p.id) && !(st.known || ['claude', 'codex']).includes(p.id))).map((p) => p.id);
  const saved = { claude: st.claudeRing, ...(st.rings || {}) }; // claudeRing is the oldest key
  for (const [id, list] of Object.entries(NUMBER_CHOICES)) if (list.some(([, row]) => row === saved[id])) choices[id] = saved[id];
  if (THEMES.some(([id]) => id === st.theme)) theme = st.theme;
  if (SIZES.some(([, k]) => k === st.scale)) scale = st.scale;
  if (typeof st.autoHide === 'boolean') autoHide = st.autoHide;
  // Timers a crashed run left at Never: put back unless the switch is still on.
  const held = st.sleepAc && typeof st.sleepAc === 'object' ? st.sleepAc : {};
  sleepAc = Object.fromEntries(Object.entries(held).filter(([plan, s]) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(plan) && Number.isInteger(s) && s > 0));
  if (st.keepAwake !== true) keepSleep(false);
  setKeepAwake(st.keepAwake === true);
  restoreLater(true); // off already, so the switch above changed nothing: a release that failed just now tries again
  if (EDGES.includes(st.edge)) edge = st.edge;
  if (typeof st.along === 'number') along = Math.max(0, Math.min(1, st.along));
  displayId = screen.getAllDisplays().some((d) => d.id === st.displayId) ? st.displayId : screen.getPrimaryDisplay().id;
  // Last good numbers, so a restart paints real levels before the first request comes back.
  // Account-checked providers (Antigravity) stay hidden until their credentials confirm the restored reading belongs to the current account.
  unverified.clear();
  credRetryAt.clear();
  credFails.clear();
  credChecked.clear();
  publishedQuota.clear();
  activeKeys.clear();
  activeToken.clear();
  expiredCred.clear();
  fetchedFor.clear();
  if (st.cache && typeof st.cache === 'object') cache = Object.fromEntries(Object.entries(st.cache).map(([id, v]) => [id, savedReading(v)]));
  for (const [id, v] of Object.entries(cache)) {
    last.set(id, v);
    if (!SHOT && PROVIDERS.find((p) => p.id === id)?.peekCred) unverified.add(id);
  }
  for (const [id, account] of Object.entries(st.signedIn || {})) if (typeof account === 'string') signedIn.set(id, account);
  authRejected.clear();
  authAnswered.clear();
  rateCleared.clear();
  for (const [id, v] of Object.entries(st.authRejected || {})) {
    if (!v || typeof v !== 'object') continue;
    const m = new Map();
    if (typeof v.tokenHash === 'string' && typeof v.error === 'string') {
      m.set(v.tokenHash, { error: v.error, authError: true });
    } else {
      for (const [hash, entry] of Object.entries(v)) {
        if (typeof entry === 'string') m.set(hash, { error: entry, authError: true });
        else if (entry && typeof entry === 'object' && typeof entry.error === 'string') {
          m.set(hash, {
            error: entry.error,
            authError: !!entry.authError,
            ...(entry.authError && typeof entry.fallbackError === 'string' && entry.fallbackError ? { fallbackError: entry.fallbackError } : {}),
          });
        }
      }
    }
    if (m.size) authRejected.set(id, m);
  }
  const now = Date.now();
  for (const [id, v] of Object.entries(st.gate || {})) if (v > now && !PROVIDERS.find((p) => p.id === id)?.peekCred) gate.set(id, v);
  accountGates.clear();
  const legacyAgIdentity = !SHOT && st.antigravityIdentityVersion !== ANTIGRAVITY_IDENTITY_VERSION;
  const hasEntries = (v) => !!(v && typeof v === 'object' && Object.keys(v).length);
  for (const p of PROVIDERS) {
    if (p.peekCred && legacyAgIdentity) {
      // One-time migration from pre-v2 state.json: earlier builds could link distinct accounts through arbitrary
      // whitespace-only refresh tokens, so discard legacy cache, identity links, and cooldowns whose owner cannot
      // be established independently.
      const hadLegacy = !!(cache[p.id] || signedIn.has(p.id) || hasEntries(st.accountLinks?.[p.id]) || hasEntries(st.accountGates?.[p.id]) || hasEntries(st.tierGates?.[p.id]));
      delete cache[p.id];
      last.delete(p.id);
      unverified.delete(p.id);
      signedIn.delete(p.id);
      if (hadLegacy) {
        saveState({ cache, signedIn: Object.fromEntries(signedIn), accountLinks: linksState(), accountGates: prunedAccountGates(now), tierGates: tierGatesState() });
      }
      continue;
    }
    const list = p.gateList ? p.gateList(st.accountGates?.[p.id], now) : [];
    if (list.length) accountGates.set(p.id, list);
    p.restoreTierGates?.(st.tierGates?.[p.id]);
    const restored = p.restoreLinks?.(cache[p.id], accountGates.get(p.id) || [], st.accountLinks?.[p.id]);
    if (accountGates.has(p.id) && !accountGates.get(p.id).length) accountGates.delete(p.id);
    if (restored?.readingTainted) {
      delete cache[p.id];
      last.delete(p.id);
      unverified.delete(p.id);
      signedIn.delete(p.id);
    }
    if (restored?.dirty) {
      saveState({ cache, signedIn: Object.fromEntries(signedIn), accountLinks: linksState(), accountGates: prunedAccountGates(now), tierGates: tierGatesState() });
    }
  }
  try {
    if (st.consoleSession) setConsoleKey(safeStorage.decryptString(Buffer.from(st.consoleSession, 'base64')), cache.claude?.apiCredit);
    hasConsoleKey = !!st.consoleSession;
  } catch {
    /* sealed for another Windows user or machine: the line stays off until the key is pasted again */
  }
  if (!hasConsoleKey) dropCredit(); // a saved balance with no session to stand behind it
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
    // skipTaskbar only asks the taskbar of the moment to drop the button (one ITaskbarList::DeleteTab);
    // a taskbar that rebuilds its list later doesn't know. A tool window never gets a button at all.
    type: 'toolbar',
    focusable: false, // an overlay that steals focus off a click is worse than one you can't focus
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // A Windows sign-out, restart or shutdown skips will-quit, so the sleep timers go back here, or they would
  // stay at Never in a session with no overlay to put them back. The next start holds them again if it is on.
  win.on('session-end', () => {
    keepSleep(false);
    flushState();
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

app.on('second-instance', () => alive() && !visible && toggle());
app.whenReady().then(() => {
  if (!firstCopy) return;
  createWindow();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'))); // tray@2x.png is picked up on HiDPI
  tray.setToolTip('AI Usage Overlay v3');
  tray.setContextMenu(menu());
  tray.on('click', () => tray.popUpContextMenu());
  globalShortcut.register(HOTKEY, toggle); // false when another app already holds it; the menu still works
  timer = setInterval(tick, TICK_MS);
  cursorTimer = setInterval(pollCursor, CURSOR_MS);
  watchDisplays();
  if (!SHOT) {
    servePhone();
    stopLink = link.start('overlay', PHONE_PORT); // the bubble over the phone's hotspot, where Tailscale can't reach it
  }
});

ipcMain.on('rects', (_e, r) => {
  rects = r; // the page is never zoomed as a whole, so its CSS px are the window's px
});
ipcMain.on('menu', () => tray.popUpContextMenu());
ipcMain.handle('refresh', () => tick(true)); // settles when every read it asked for has, for the button's spinner
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
  // A window as long as its edge (capped to the display) has nowhere to slide: it keeps where it sat, for a bigger display.
  const travel = vertical() ? a.height - size.height : a.width - size.width;
  if (travel > 0) along = Math.max(0, Math.min(1, (vertical() ? cy - size.height / 2 - a.y : cx - size.width / 2 - a.x) / travel));
  saveState({ edge, along, displayId });
  place(true);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', (e) => {
  if (awakeBlocker !== null) {
    awakeBlocker.kill();
    awakeBlocker = null;
  }
  keepSleep(false); // the timers go back with the overlay; the next start holds them again if the switch is on
  clearTimeout(restoreTimer); // what's left on record is the next start's to put back
  clearInterval(timer);
  clearInterval(cursorTimer);
  clearInterval(snapTimer);
  globalShortcut.unregisterAll();
  flushState(); // a setting or 429 gate from the last 400ms would otherwise die with the debounce
  // A quit between the link's own `tailscale down` and its up waits for that up, or Tailscale stays off (link.js).
  const last = stopLink?.();
  if (last) {
    e.preventDefault();
    last.catch(() => {}).finally(() => app.exit(0));
  }
});
