'use strict';
// One module per data source. Each provider's read() returns the same shape:
//   { plan, rows: [{ label, percent, resetsAt }], error, updatedAt }
// Pure shaping is exported separately so test.js can check it without touching disk or network.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_CREDS = path.join(HOME, '.claude', '.credentials.json');
const CLAUDE_API = 'https://api.anthropic.com/api/oauth';
const CODEX_API = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESETS_API = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const OPENCODE_AUTH = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'opencode', 'auth.json');
const OPENCODE_GO_API = 'https://opencode.ai/zen/go/v1/usage';
let resetDetailsRetryAt = 0;
const ORCA_CODEX_HOME = process.env.ORCA_CODEX_HOME || (process.env.APPDATA && path.join(process.env.APPDATA, 'orca', 'codex-runtime-home', 'home'));
const CODEX_HOMES = [...new Set([process.env.CODEX_HOME, ORCA_CODEX_HOME, path.join(HOME, '.codex')].filter(Boolean))];
const CODEX_AUTH = path.join(HOME, '.codex', 'auth.json');
const CODEX_SESSION_ROOTS = CODEX_HOMES.map((home) => path.join(home, 'sessions'));
const TAIL_BYTES = 256 * 1024; // rollout files grow to MBs; the last rate_limits is always near the end

const MIN = 60_000;
const HOUR = 60 * MIN;

async function fetchJson(url, headers) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status}`);
        e.status = r.status;
        const retry = r.headers.get('retry-after');
        e.retryAfter = Math.max(0, Number(retry) || (Date.parse(retry) - Date.now()) / 1000 || 0);
        await r.body?.cancel();
        throw e;
      }
      return await r.json();
    } catch (e) {
      const transport = !e.status && (e instanceof TypeError || e.name === 'TimeoutError');
      if (!transport) throw e;
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const detail = e.cause?.code;
      throw Object.assign(new Error(e.name === 'TimeoutError' ? 'Request timed out' : `${e.message}${detail ? ` (${detail})` : ''}`), { soft: true });
    }
  }
}

const CLAUDE_TIERS = {
  default_claude_max_5x: 'Max 5x',
  default_claude_max_20x: 'Max 20x',
  default_claude_pro: 'Pro',
  default_claude_free: 'Free',
};
const CLAUDE_LABELS = { session: 'Session', weekly_all: 'All models' };
const CODEX_PLANS = { free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team', business: 'Business', enterprise: 'Enterprise' };

// "in 45m", "in 3h 39m", "in 2d 4h": short enough for a table column, and the same shape whatever
// the window. Rounds to the minute first: the API returns …T00:59:59Z but means 1:00.
function fmtReset(resetsAt, now = Date.now()) {
  if (!resetsAt) return '';
  const t = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt);
  if (!t || Number.isNaN(t)) return '';
  const mins = Math.round((t - now) / MIN);
  if (mins <= 0) return 'now';
  const [d, h, m] = [Math.floor(mins / 1440), Math.floor(mins / 60) % 24, mins % 60];
  if (d) return `in ${d}d${h ? ` ${h}h` : ''}`;
  if (h) return `in ${h}h${m ? ` ${m}m` : ''}`;
  return `in ${m}m`;
}

const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const ringPercent = (rows, label) => (rows || []).find((r) => r.label === label)?.percent ?? Math.max(0, ...(rows || []).map((r) => r.percent));
const resetRows = (previous, current) => {
  const before = new Map((previous || []).map((r) => [r.label, Number(r.percent)]));
  return (current || []).filter((r) => before.has(r.label) && Number(r.percent) < before.get(r.label));
};

// ---- Claude: OAuth token that Claude Code keeps rotating in place, so we re-read it every call.
function shapeClaude(usage, profile) {
  const limits = Array.isArray(usage && usage.limits) ? usage.limits : [];
  // Banked resets arrive as grants; each remaining reset in a grant shares that grant's deadline.
  const grants = usage?.cedar_ember?.eligible && Array.isArray(usage.cedar_ember.grants) ? usage.cedar_ember.grants : null;
  const expiries = (grants || []).flatMap((g) => {
    const left = Number.isSafeInteger(g?.resets_left) && g.resets_left > 0 ? g.resets_left : 0;
    const ends = typeof g?.ends_at === 'string' ? Date.parse(g.ends_at) : NaN;
    return Array(left).fill(Number.isFinite(ends) ? ends : null);
  }).sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  return {
    ...(grants ? { bankedResets: expiries.length, bankedResetExpiries: expiries } : {}),
    plan: CLAUDE_TIERS[profile?.organization?.rate_limit_tier] || profile?.organization?.rate_limit_tier || '',
    rows: limits.map((l) => ({
      label: CLAUDE_LABELS[l?.kind] || l?.scope?.model?.display_name || l?.kind || 'Usage',
      percent: clamp(l?.percent),
      resetsAt: l?.resets_at || null,
    })),
  };
}

let claudeProfile = null; // plan tier can't change mid-process; fetched once, halves every later refresh

async function readClaude() {
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(CLAUDE_CREDS, 'utf8')).claudeAiOauth;
  } catch {
    return { error: 'No Claude credentials — run `claude` to sign in.' };
  }
  if (!creds?.accessToken) return { error: 'No Claude credentials — run `claude` to sign in.' };
  if (creds.expiresAt && creds.expiresAt < Date.now()) return { error: 'Session expired — run `claude`.' };
  const headers = {
    Authorization: `Bearer ${creds.accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
    // Same UA Claude Code sends. An unknown client is the one the endpoint throttles first, and
    // banked resets (cedar_ember) are only reported to the CLI surface.
    'User-Agent': 'claude-cli/2.1.280 (external, cli)',
  };
  const get = (p) => fetchJson(CLAUDE_API + p, headers);
  try {
    const [usage] = await Promise.all([
      get('/usage?cedar_ember=1'),
      claudeProfile ? null : get('/profile').then((p) => (claudeProfile = p)).catch(() => {}),
    ]);
    return { ...shapeClaude(usage, claudeProfile), updatedAt: Date.now() };
  } catch (e) {
    // A 429 is a non-event: soft errors keep the last numbers on screen instead of blanking them.
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter || 60 };
    return { error: e.message || 'Request failed', soft: !!e.soft };
  }
}

// ---- Codex: use the same live usage request as Orca, with rollout data as an offline fallback.
function windowLabel(mins) {
  if (!mins) return 'Usage';
  if (mins >= 10080) return mins === 10080 ? 'Weekly' : `${Math.round(mins / 10080)} wk`;
  if (mins >= 1440) return `${Math.round(mins / 1440)}-day`;
  if (mins >= 60) return `${Math.round(mins / 60)}h limit`;
  return `${mins} min`;
}

function shapeCodex(rl) {
  if (!rl) return { error: 'No Codex usage yet — run `codex` once.' };
  const rows = [];
  for (const key of ['primary', 'secondary']) {
    const w = rl[key];
    if (!w) continue;
    rows.push({
      label: windowLabel(w.window_minutes),
      percent: clamp(w.used_percent),
      resetsAt: w.resets_at ? w.resets_at * 1000 : null, // epoch seconds, unlike Claude's ISO string
    });
  }
  const plan = CODEX_PLANS[rl.plan_type] || rl.plan_type || '';
  return rows.length ? { plan, rows } : { plan, error: 'No usage windows reported.' };
}

function shapeCodexUsage(usage) {
  const bankedResets = usage?.rate_limit_reset_credits?.available_count;
  const window = (w) => w && ({
    used_percent: w.used_percent,
    window_minutes: w.limit_window_seconds ? Math.ceil(w.limit_window_seconds / 60) : null,
    resets_at: w.reset_at,
  });
  return { ...shapeCodex({
    plan_type: usage?.plan_type,
    primary: window(usage?.rate_limit?.primary_window),
    secondary: window(usage?.rate_limit?.secondary_window),
  }), ...(Number.isSafeInteger(bankedResets) && bankedResets >= 0 ? { bankedResets } : {}) };
}

function shapeCodexResetCredits(details) {
  if (!Array.isArray(details?.credits)) return undefined;
  return details.credits.filter((c) => c?.status === 'available').map((c) => {
    const expires = typeof c.expires_at === 'string' ? Date.parse(c.expires_at) : NaN;
    return Number.isFinite(expires) ? expires : null;
  }).sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
}

// Day dirs are date-named, so name order is time order. Two days back covers a session that started
// yesterday and is still being appended to now.
function recentRollouts(root) {
  const days = [];
  const kids = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  };
  for (const y of kids(root)) for (const m of kids(y)) days.push(...kids(m));
  return days.sort().slice(-2);
}

function newestRollout() {
  let best = null;
  for (const root of CODEX_SESSION_ROOTS) for (const day of recentRollouts(root)) {
    let names;
    try {
      names = fs.readdirSync(day);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const p = path.join(day, n);
      try {
        const m = fs.statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      } catch {
        /* file rotated away mid-scan */
      }
    }
  }
  return best;
}

function lastRateLimits(file) {
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
  } catch {
    return null;
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const rl = JSON.parse(lines[i])?.payload?.rate_limits;
      if (rl) return rl;
    } catch {
      /* a truncated first line, or a line that only mentions the word */
    }
  }
  return null;
}

function readCodexFallback(note) {
  const f = newestRollout();
  if (!f) return { error: 'No Codex sessions found.' };
  return { ...shapeCodex(lastRateLimits(f.p)), updatedAt: f.m, ...(note ? { note } : {}) };
}

async function readCodex() {
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8')).tokens;
  } catch {
    /* local usage is still available without credentials */
  }
  if (!tokens?.access_token) return readCodexFallback('Live refresh unavailable; showing local usage.');

  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
  };
  if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;

  try {
    const shaped = shapeCodexUsage(await fetchJson(CODEX_API, headers));
    if (!shaped.error && shaped.bankedResets > 0 && Date.now() >= resetDetailsRetryAt) {
      try {
        shaped.bankedResetExpiries = shapeCodexResetCredits(await fetchJson(CODEX_RESETS_API, headers));
      } catch (e) {
        if (e.status === 429) resetDetailsRetryAt = Date.now() + Math.max(60, e.retryAfter) * 1000;
        // Expiry lookup failure must not discard the live usage or reset count.
      }
    }
    return shaped.error ? readCodexFallback('Live usage unavailable; showing local usage.') : { ...shaped, updatedAt: Date.now() };
  } catch (e) {
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter || 60 };
    return readCodexFallback('Live refresh failed; showing local usage.');
  }
}

// ---- OpenCode Go: flat-rate plan with rolling 5h, weekly and monthly caps. Same API key `opencode`
// uses for requests; the CLI keeps it in its auth.json, or OPENCODE_API_KEY overrides it.
const OPENCODE_GO_WINDOWS = [['rolling', '5h limit'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];

function shapeOpenCodeGo(body) {
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') return { error: 'No usage windows reported.' };
  const rows = OPENCODE_GO_WINDOWS.filter(([key]) => usage[key]).map(([key, label]) => ({
    label,
    percent: clamp(usage[key].percent),
    resetsAt: usage[key].resetsAt || null,
  }));
  return rows.length ? { plan: 'Go', rows } : { plan: 'Go', error: 'No usage windows reported.' };
}

async function readOpenCodeGo() {
  let key = process.env.OPENCODE_API_KEY;
  if (!key) {
    try {
      key = JSON.parse(fs.readFileSync(OPENCODE_AUTH, 'utf8'))['opencode-go']?.key;
    } catch {
      /* falls through to the sign-in hint */
    }
  }
  if (!key) return { error: 'No OpenCode Go key — run `opencode auth login`.' };
  try {
    const body = await fetchJson(OPENCODE_GO_API, { Authorization: `Bearer ${key}` });
    return { ...shapeOpenCodeGo(body), updatedAt: Date.now() };
  } catch (e) {
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter || 60 };
    if (e.status === 401) return { error: 'OpenCode Go key rejected — run `opencode auth login`.' };
    return { error: e.message || 'Request failed', soft: !!e.soft };
  }
}

const PROVIDERS = [
  { id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', everyMs: 5 * 60_000, read: readClaude },
  { id: 'codex', name: 'Codex', glyph: '◉', color: '#10a37f', everyMs: 5 * 60_000, read: readCodex },
  { id: 'opencode-go', name: 'OpenCode Go', glyph: '▣', color: '#fab283', everyMs: 5 * 60_000, read: readOpenCodeGo },
];

module.exports = { PROVIDERS, fmtReset, shapeClaude, shapeCodex, shapeCodexUsage, shapeOpenCodeGo, shapeCodexResetCredits, windowLabel, ringPercent, resetRows, lastRateLimits, newestRollout };
