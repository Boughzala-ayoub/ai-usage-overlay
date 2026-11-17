'use strict';
// One module per data source. Each provider's read() returns the same shape:
//   { plan, rows: [{ label, percent, resetsAt }], error, updatedAt }
// Pure shaping is exported separately so test.js can check it without touching disk or network.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_CREDS = path.join(HOME, '.claude', '.credentials.json');
const CLAUDE_CODE_CONFIG = path.join(HOME, '.claude.json'); // where Claude Code keeps its last /usage answer
const CLAUDE_API = 'https://api.anthropic.com/api/oauth';
const CONSOLE_API = 'https://platform.claude.com/api';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CODEX_API = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_RESETS_API = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const CODEX_ACCOUNTS_API = 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27'; // the plan's renews_at
const OPENCODE_AUTH = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'opencode', 'auth.json');
const OPENCODE_GO_API = 'https://opencode.ai/zen/go/v1/usage';
const GROK_AUTH = path.join(HOME, '.grok', 'auth.json');
const GROK_BILLING_API = 'https://cli-chat-proxy.grok.com/v1/billing';
const GROK_TOKEN_API = 'https://auth.x.ai/oauth2/token';
const CURSOR_AUTH = path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
const CURSOR_DASHBOARD_API = 'https://api2.cursor.sh/aiserver.v1.DashboardService';
let resetDetailsRetryAt = 0;
const ORCA_CODEX_HOME = process.env.ORCA_CODEX_HOME || (process.env.APPDATA && path.join(process.env.APPDATA, 'orca', 'codex-runtime-home', 'home'));
const CODEX_HOMES = [...new Set([process.env.CODEX_HOME, ORCA_CODEX_HOME, path.join(HOME, '.codex')].filter(Boolean))];
const CODEX_AUTH = path.join(HOME, '.codex', 'auth.json');
const CODEX_SESSION_ROOTS = CODEX_HOMES.map((home) => path.join(home, 'sessions'));
const TAIL_BYTES = 256 * 1024; // rollout files grow to MBs; the last rate_limits is always near the end

const MIN = 60_000;
const HOUR = 60 * MIN;

// A failed answer as an error with its status and its Retry-After in seconds, seconds or an HTTP date.
async function httpError(r) {
  const e = new Error(`HTTP ${r.status}`);
  e.status = r.status;
  e.soft = r.status >= 500 || r.status === 408; // a server error or timeout fixes itself: no message, the last numbers stay
  const retry = r.headers.get('retry-after');
  e.retryAfter = Math.max(0, Number(retry) || (Date.parse(retry) - Date.now()) / 1000 || 0);
  await r.body?.cancel().catch(() => {}); // a body that already broke rejects here; the status still stands
  return e;
}

// A request's deadline, body included, that holds whatever fetch does. AbortSignal.timeout alone didn't: on
// 2026-10-29 a Claude read stayed pending 12 hours with no socket, nothing queued in undici, and nothing left
// that could settle it, which froze Claude's numbers and every phone GET. This timer keeps its own reject.
function within(ms, request) {
  const ac = new AbortController();
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new DOMException('The operation timed out.', 'TimeoutError');
      ac.abort(e);
      reject(e);
    }, ms);
  });
  return Promise.race([request(ac.signal), late]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, headers, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await within(15_000, async (signal) => {
        const r = await fetch(url, { headers, signal, ...(body ? { method: 'POST', body } : {}) });
        if (!r.ok) throw await httpError(r);
        return await r.json();
      });
    } catch (e) {
      // A body cut short (SyntaxError) is as soft as no answer at all.
      const transport = !e.status && (e instanceof TypeError || e instanceof SyntaxError || e.name === 'TimeoutError');
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
  // On 2026-10-30 Max 5x became Max and Max 20x became Ultra. The 5x key kept its old name (seen on a real
  // account); the 20x key is assumed to have too.
  default_claude_max_5x: 'Max',
  default_claude_max_20x: 'Ultra',
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

// The first monthly anniversary of `start` after `now`, as Stripe bills a monthly plan: the same day and time each
// month, or the month's last day when the month is shorter (a plan started on the 31st bills on Nov 30).
function nextMonthly(start, now = Date.now()) {
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return null;
  for (let n = 1; ; n++) {
    const [y, m] = [s.getUTCFullYear(), s.getUTCMonth() + n];
    const day = Math.min(s.getUTCDate(), new Date(Date.UTC(y, m + 1, 0)).getUTCDate());
    const t = Date.UTC(y, m, day, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds());
    if (t > now) return t;
  }
}

const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const ringPercent = (rows, label) => (rows || []).find((r) => r.label === label)?.percent ?? Math.max(0, ...(rows || []).map((r) => r.percent));
const resetRows = (previous, current) => {
  const before = new Map((previous || []).map((r) => [r.label, Number(r.percent)]));
  // Under a point is rounding, such as xAI's whole percent against Cursor's fraction of the same pool, not a reset.
  return (current || []).filter((r) => before.has(r.label) && Number(r.percent) <= before.get(r.label) - 1);
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
  // The profile gives only the day the subscription started, so the next bill is worked out from it: renewsGuess.
  // ponytail: assumes a monthly plan whose billing day never moved; an annual plan or a plan change would need a real source.
  // With no profile (its lookup failed) the reading says nothing of it, and main keeps the date on hand; null is none.
  const org = profile?.organization;
  const renewsAt = org && (org.billing_type === 'stripe_subscription' && org.subscription_status === 'active' ? nextMonthly(org.subscription_created_at) : null);
  return {
    ...(grants ? { bankedResets: expiries.length, bankedResetExpiries: expiries } : {}),
    ...(org ? { renewsAt, ...(renewsAt ? { renewsGuess: true } : {}) } : {}),
    plan: CLAUDE_TIERS[profile?.organization?.rate_limit_tier] || profile?.organization?.rate_limit_tier || '',
    rows: limits.map((l) => ({
      label: CLAUDE_LABELS[l?.kind] || l?.scope?.model?.display_name || l?.kind || 'Usage',
      percent: clamp(l?.percent),
      resetsAt: l?.resets_at || null,
    })),
  };
}

// An account as a reading names it (renewsFor): hashed, so main can keep a date on hand only for the account it belongs to.
const accountKey = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);

// A Claude account as ~/.claude.json names it (oauthAccount) and as /profile does: the account, and the organization
// whose plan it uses, since one login can belong to several. null when it names none.
const claudeKey = (oauth) => (oauth?.accountUuid ? accountKey(oauth.accountUuid + '/' + (oauth.organizationUuid || '')) : null);

// The plan tier, the day the subscription started and whose they are, as /profile answered for the token signed in now.
// Claude Code replaces its token (.credentials.json) and its record of who signed in (~/.claude.json) separately, so
// neither file says whose a token is; /profile, asked with it, does. So every new token is asked once, a sign-in or the
// same account's rotated in place every few hours: one request more each time. The token is kept only as a hash, here.
// Until /profile answers, a read names a marker of its own, which no plan or date on hand shares, so main shows neither.
// A profile that names no account keeps its marker too: its plan shows, and no other reading is taken for the same account.
const claudeSlot = (token) => ({ token, marker: crypto.randomBytes(6).toString('hex'), profile: null, account: null });
let claudeProfile = claudeSlot(null);

// ---- Claude's numbers as Claude Code last saw them, read from its file for nothing. Every Claude Code session asks the
// same /usage endpoint with the same account, which throttles hard (Max accounts see a 429 after a single request), so
// Claude Code keeps its last answer in ~/.claude.json as cachedUsageUtilization for its sessions to share: one fetches,
// the others reuse it for a minute and, when the endpoint says no, fall back on it for up to an hour. The overlay does
// the same: main takes it when it is newer than its own reading, between the five-minute reads and while gated. It is
// the endpoint's own shape, dated by the fetch, and counts only for the account signed in now.
// ponytail: an internal file of Claude Code's; one that changes shape is just no copy, and the endpoint carries on.
function readClaudeLocal(now = Date.now()) {
  try {
    const config = JSON.parse(fs.readFileSync(CLAUDE_CODE_CONFIG, 'utf8'));
    const copy = config.cachedUsageUtilization;
    const age = now - copy?.fetchedAtMs;
    if (!copy?.accountUuid || copy.accountUuid !== config.oauthAccount?.accountUuid || !Array.isArray(copy.utilization?.limits) || !(age >= 0 && age < HOUR)) return null;
    const { rows } = shapeClaude(copy.utilization);
    return rows.length ? { rows, updatedAt: copy.fetchedAtMs, renewsFor: claudeKey(config.oauthAccount) } : null; // as readClaude names it
  } catch {
    return null; // missing, or caught halfway through a write
  }
}

// ---- Claude API credit: the monthly credit Max and Team plans pay into a linked Console organization.
// No public API reports it. The Console's billing page reads it with the browser session, and so do we,
// with the sessionKey cookie main hands over from its encrypted store.
let consoleKey = '';
let consoleSession = 0; // bumped on every key change: a read begun under an older key writes and publishes nothing
let consoleOrgs = null; // the session's API organizations; they don't change while it lasts
let lastApiCredit; // the session's last answer, which a failed refresh keeps; past its deadline main says it expired

// `saved` is the balance a restart found saved with this key, so a failed first refresh keeps it too.
function setConsoleKey(key, saved) {
  consoleKey = key || '';
  consoleSession++;
  consoleOrgs = null;
  lastApiCredit = saved;
}

// Every unexpired tranche of the plan's credit, summed the way the Console's billing widget sums them.
// Other promotional credits share the list, so the program id picks ours.
function shapeApiCredit(balances, now = Date.now()) {
  const tranches = balances.flatMap((b) => (Array.isArray(b?.promo_tranches) ? b.promo_tranches : [])).filter((t) =>
    t?.program_id === 'subscription_api_credit' && (t.currency || 'USD').toUpperCase() === 'USD' &&
    Number.isFinite(t.granted_amount_minor_units) && Number.isFinite(t.remaining_amount_minor_units) &&
    !(Date.parse(t.expires_at) <= now));
  if (!tranches.length) return undefined;
  const ends = tranches.map((t) => Date.parse(t.expires_at)).filter(Number.isFinite);
  return {
    leftCents: tranches.reduce((sum, t) => sum + t.remaining_amount_minor_units, 0),
    grantedCents: tranches.reduce((sum, t) => sum + t.granted_amount_minor_units, 0),
    expiresAt: ends.length ? Math.min(...ends) : null,
  };
}

// The total holds until its earliest tranche's deadline, and from that moment, as the Console counts, it isn't
// funds. No deadline never lapses.
const creditExpired = (credit, now = Date.now()) => Number.isFinite(credit?.expiresAt) && credit.expiresAt <= now;

// Never throws: the credit line must not cost the usage numbers.
async function readApiCredit() {
  if (!consoleKey) return undefined;
  const session = consoleSession;
  const headers = { Cookie: `sessionKey=${consoleKey}`, 'User-Agent': BROWSER_UA };
  try {
    const orgs = consoleOrgs ?? (await fetchJson(`${CONSOLE_API}/organizations`, headers)).filter((o) => o?.capabilities?.includes('api')).map((o) => o.uuid);
    if (session !== consoleSession) return undefined;
    consoleOrgs = orgs;
    const balances = await Promise.all(orgs.map((id) => fetchJson(`${CONSOLE_API}/organizations/${id}/prepaid/credits`, headers)));
    if (session !== consoleSession) return undefined;
    lastApiCredit = shapeApiCredit(balances) || { error: 'No plan API credit in your Console organization.' };
  } catch (e) {
    if (session !== consoleSession) return undefined;
    if (e.status === 401 || e.status === 403) return (lastApiCredit = { error: 'Console session expired. Copy a new `sessionKey` and pick Paste Console session key in the tray.' });
    // Offline, throttled or a 5xx: the balance on hand stays, without a message, like every provider's numbers.
    // Past its deadline main and the panels say it expired; with none on hand there is no credit line.
    return lastApiCredit;
  }
  return lastApiCredit;
}

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
  const session = consoleSession;
  const token = accountKey(creds.accessToken);
  if (claudeProfile.token !== token) claudeProfile = claudeSlot(token);
  const known = claudeProfile; // a profile answering after the token changed again fills only its own token's slot
  const profiled = known.profile
    ? null
    : get('/profile').then((p) => {
      known.profile = p;
      known.account = claudeKey({ accountUuid: p?.account?.uuid, organizationUuid: p?.organization?.uuid });
    }).catch(() => {});
  // For main, on a failure too, as Codex's.
  const whose = () => ({ renewsFor: known.account || known.marker });
  try {
    const [usage, apiCredit] = await Promise.all([get('/usage?cedar_ember=1'), readApiCredit(), profiled]);
    // Usage can answer after the key changed under a credit that was already in.
    const credit = session === consoleSession && apiCredit;
    // With no profile, only the marker: main goes on taking copies for the account it last knew. A profile that names
    // no account is one of its own (claudeSlot).
    const unknown = known.profile ? {} : { accountUnknown: true };
    return { ...shapeClaude(usage, known.profile), ...whose(), ...unknown, ...(credit ? { apiCredit: credit } : {}), updatedAt: Date.now() };
  } catch (e) {
    await profiled; // a profile that answers names the account even when the usage doesn't; it never throws
    // Main keeps the last numbers on screen through a 429, waits out its Retry-After, and meanwhile takes the
    // newest numbers other clients have (readClaudeLocal). With only the marker to go on (accountUnknown), it still
    // drops the plan and date on hand, but goes on taking copies for the account it last knew.
    const failed = { ...whose(), ...(known.account ? {} : { accountUnknown: true }) };
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter || 60, ...failed };
    return { error: e.message || 'Request failed', soft: !!e.soft, ...failed };
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

// When ChatGPT next bills the signed-in account's plan, or null with no renewal ahead (cancelled, or free).
function shapeCodexRenewal(check, accountId) {
  const accounts = check?.accounts || {};
  const t = Date.parse((accounts[accountId] || accounts.default)?.entitlement?.renews_at);
  return Number.isFinite(t) ? t : null;
}
let codexRenewal = { account: null, at: undefined, due: 0 }; // asked every 6 hours, and again once the date has passed

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

// Newest first, by modification time.
function rollouts() {
  const found = [];
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
        found.push({ p, m: fs.statSync(p).mtimeMs });
      } catch {
        /* file rotated away mid-scan */
      }
    }
  }
  return found.sort((a, b) => b.m - a.m);
}

// The last usage event in a rollout's tail, as { rl, at }: at is when Codex logged it (NaN if it didn't say).
function lastRateLimits(file) {
  let buf;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd); // this process runs for days; a failed read must not keep the handle
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const line = JSON.parse(lines[i]);
      if (line?.payload?.rate_limits) return { rl: line.payload.rate_limits, at: Date.parse(line.timestamp) };
    } catch {
      /* a truncated first line, or a line that only mentions the word */
    }
  }
  return null;
}

// `why` is why live usage didn't come. It marks the reading as a fallback, so main keeps a newer reading
// already on screen instead of this older local one.
function readCodexFallback(why) {
  const files = rollouts();
  // Soft, like the no-usage case below: a reading already on screen stays instead of being blanked.
  if (!files.length) return { error: 'No Codex sessions found.', soft: true };
  // The newest usage event wins, by its own time. Appending a message to an old session bumps its file
  // time without new usage, and a clock change or restored file times can put an event after its file's
  // time, so file time can't end the search early. It only orders it, which settles ties: the newest
  // file wins. Undated events rank below every dated one. A just-started session has no event and is skipped.
  // ponytail: reads every rollout of the last two days (256 KiB tail each); fine at a 5-minute poll.
  let best = null;
  for (const f of files) {
    const hit = lastRateLimits(f.p);
    const shaped = hit && shapeCodex(hit.rl);
    if (!shaped || shaped.error) continue;
    const at = Number.isFinite(hit.at) ? hit.at : -Infinity;
    if (!best || at > best.at) best = { shaped, at };
  }
  if (!best) return { error: 'No Codex usage in recent sessions — run `codex` once.', soft: true };
  return { ...best.shaped, ...(best.at > -Infinity ? { updatedAt: best.at } : {}), why: why + '.' };
}

async function readCodex() {
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(CODEX_AUTH, 'utf8')).tokens;
  } catch {
    /* local usage is still available without credentials */
  }
  if (!tokens?.access_token) return readCodexFallback('Live refresh unavailable');

  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop',
  };
  if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
  // Another sign-in has its own next bill, asked for at once. The account goes out hashed, so main keeps a date on hand
  // only for the account it belongs to.
  const account = accountKey(tokens.account_id || tokens.access_token);
  if (codexRenewal.account !== account) codexRenewal = { account, at: undefined, due: 0 };
  // What this run knows: a date, null for none ahead, or nothing yet (its lookup failed), when main keeps the one on hand.
  const renewal = () => ({ renewsFor: account, ...(codexRenewal.at !== undefined ? { renewsAt: codexRenewal.at > Date.now() ? codexRenewal.at : null } : {}) });

  try {
    const shaped = shapeCodexUsage(await fetchJson(CODEX_API, headers));
    // At 0 too: right after a first grant /usage can still say 0 while the list has it.
    if (!shaped.error && shaped.bankedResets !== undefined && Date.now() >= resetDetailsRetryAt) {
      try {
        const expiries = shapeCodexResetCredits(await fetchJson(CODEX_RESETS_API, headers));
        // For minutes after a grant, /usage still gives the old count while the list has the new reset ("2 banked
        // resets expire Nov 30, Dec 1 and 12"), so the list counts them and the number matches its dates.
        if (expiries) Object.assign(shaped, { bankedResets: expiries.length, bankedResetExpiries: expiries });
      } catch (e) {
        if (e.status === 429) resetDetailsRetryAt = Date.now() + Math.max(60, e.retryAfter) * 1000;
        // Expiry lookup failure must not discard the live usage or reset count.
      }
    }
    if (!shaped.error && Date.now() >= codexRenewal.due) {
      const now = Date.now();
      try {
        const at = shapeCodexRenewal(await fetchJson(CODEX_ACCOUNTS_API, headers), tokens.account_id);
        // Again in 6 hours, or as the date comes, for the next one. An answer whose date has passed waits the 6 hours.
        codexRenewal = { account, at, due: Math.min(now + 6 * HOUR, at > now ? at : Infinity) };
      } catch {
        codexRenewal.due = now + 30 * MIN; // the date must not cost the usage numbers
      }
    }
    return shaped.error ? { ...readCodexFallback('Live usage unavailable'), ...renewal() } : { ...shaped, ...renewal(), updatedAt: Date.now() };
  } catch (e) {
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter || 60, ...renewal() }; // whose, for main
    return { ...readCodexFallback('Live refresh failed'), ...renewal() };
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

// ---- xAI: the SuperGrok allowance that `grok` (Grok Build) shows under /usage. Its OAuth token sits in
// ~/.grok/auth.json, which `grok` refreshes while it runs, so it is re-read every call. The endpoint is the
// CLI's own, not a public API; pi-grok-cli and pi-xai read it the same way.
// Monthly credits come from /billing, the weekly percentage from /billing?format=credits. The weekly answer
// leaves out creditUsagePercent at the start of a period, before anything is used.
function shapeXai(monthly, weekly) {
  const rows = [];
  const w = weekly?.config;
  if (w?.currentPeriod?.type === 'USAGE_PERIOD_TYPE_WEEKLY') {
    rows.push({ label: 'Weekly', percent: clamp(w.creditUsagePercent), resetsAt: w.currentPeriod.end || w.billingPeriodEnd || null });
  }
  const m = monthly?.config;
  const val = (v) => Number(v?.val ?? v); // credits come as { val }, maybe as a string
  const [limit, used] = [val(m?.monthlyLimit), val(m?.used)];
  if (limit > 0 && Number.isFinite(used)) rows.push({ label: 'Monthly', percent: clamp((used / limit) * 100), resetsAt: m.billingPeriodEnd || null });
  return rows.length ? { plan: '', rows } : { error: 'No usage windows reported.' };
}

// `grok` renews its six-hour token only while it runs. Past expiry the overlay renews it the same way and writes
// it back, so `grok` starts from the new tokens if xAI rotated the refresh token.
async function renewGrok(k, v) {
  let t;
  try {
    // No retry, unlike fetchJson: a lost answer may already have spent the refresh token.
    t = await within(15_000, async (signal) => {
      const r = await fetch(GROK_TOKEN_API, {
        method: 'POST',
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: v.oidc_client_id || k.split('::')[1], refresh_token: v.refresh_token }),
        signal,
      });
      if (!r.ok) {
        const e = await httpError(r); // a 429 keeps its Retry-After for the gate
        // A refused refresh token is a lapsed sign-in, like a 401 from the usage lookup.
        if ([400, 401, 403].includes(e.status)) e.status = 401;
        throw e;
      }
      return r.json();
    });
    // Checked before auth.json changes: without it the saved key would vanish, and the next read finds no sign-in.
    if (typeof t?.access_token !== 'string' || !t.access_token) throw new Error('Grok sign-in not renewed (no access token).');
  } catch (e) {
    if (e.status) throw e;
    // The body can fail after the headers, and that is as soft as no answer at all.
    throw Object.assign(new Error(e.name === 'TimeoutError' ? 'Request timed out' : e.message), { soft: true });
  }
  const all = JSON.parse(fs.readFileSync(GROK_AUTH, 'utf8'));
  // If `grok` renewed it meanwhile, its tokens stay.
  if (all[k]?.refresh_token === v.refresh_token) {
    const now = Date.now();
    all[k] = {
      ...all[k],
      [all[k].key ? 'key' : 'access_token']: t.access_token,
      refresh_token: t.refresh_token || v.refresh_token,
      create_time: new Date(now).toISOString(),
      expires_at: new Date(now + (Number(t.expires_in) || 3600) * 1000).toISOString(),
    };
    const tmp = `${GROK_AUTH}.overlay`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, GROK_AUTH);
  }
  return t.access_token;
}

// The weekly pool as Cursor reports it to an account merged with xAI, signed in with the Cursor CLI's token.
// Unmerged, Cursor's allowance is its own plan's, so there is none.
async function readCursorXai() {
  const { accessToken } = JSON.parse(fs.readFileSync(CURSOR_AUTH, 'utf8'));
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' };
  const [usage, plan] = await Promise.all(['GetCurrentPeriodUsage', 'GetPlanInfo'].map((m) => fetchJson(`${CURSOR_DASHBOARD_API}/${m}`, headers, '{}')));
  const end = Number(plan.planInfo?.includedUsageResetsAt);
  const bills = Number(plan.planInfo?.billingCycleEnd); // epoch ms as a string, when the merged plan next bills
  if (!plan.isMerged || plan.planInfo?.includedUsagePeriod !== 'INCLUDED_USAGE_PERIOD_WEEKLY' || !usage.planUsage) return null;
  return { plan: '', rows: [{ label: 'Weekly', percent: clamp(usage.planUsage.totalPercentUsed), resetsAt: end ? new Date(end).toISOString() : null }], renewsAt: bills > Date.now() ? bills : null, updatedAt: Date.now() };
}

let xaiLines = []; // the lines of the last xAI reading both lookups answered

async function readXai() {
  // Cursor first: it kept answering while xAI's weekly lookup failed with a 500 through 2026-10-15. With no Cursor
  // sign-in, no merged plan or no answer, xAI's own endpoints are read.
  const viaCursor = await readCursorXai().catch(() => null);
  if (viaCursor) return viaCursor;
  let entry;
  try {
    // Keyed by issuer and client ("https://auth.x.ai::<client>"); older builds keyed it by the sign-in page.
    entry = Object.entries(JSON.parse(fs.readFileSync(GROK_AUTH, 'utf8'))).find(([k, v]) => {
      const t = v?.key || v?.access_token;
      return (k.startsWith('https://auth.x.ai') || k === 'https://accounts.x.ai/sign-in') && typeof t === 'string' && t;
    });
  } catch {
    /* falls through to the sign-in hint */
  }
  if (!entry) return { error: 'No Grok sign-in — run `grok` to sign in.' };
  const [k, v] = entry;
  try {
    const expired = v.refresh_token && Date.parse(v.expires_at) < Date.now() + MIN;
    const token = expired ? await renewGrok(k, v) : v.key || v.access_token;
    const headers = { Authorization: `Bearer ${token}`, 'x-xai-token-auth': 'xai-grok-cli', Accept: 'application/json' };
    // Each lookup stands alone: one that fails costs only its own line.
    const answers = await Promise.all([GROK_BILLING_API, `${GROK_BILLING_API}?format=credits`].map((url) => fetchJson(url, headers).catch((e) => e)));
    const failed = answers.filter((a) => a instanceof Error);
    const shaped = shapeXai(...answers.map((a) => (a instanceof Error ? null : a)));
    // A refused sign-in is the read's, whatever else answered: it asks you to act. Then a 429 gates xAI as a whole,
    // whichever lookup drew it, for the longer wait if both did. With no line left a failure is the read's, the
    // monthly lookup's first. On the unified weekly pool the monthly limit is 0, so that's any weekly failure.
    const wait = (e) => e.retryAfter || 60;
    const fatal = failed.find((e) => e.status === 401 || e.status === 403) ||
      failed.filter((e) => e.status === 429).sort((a, b) => wait(b) - wait(a))[0] || (shaped.error && failed[0]);
    if (fatal) throw fatal;
    // One lookup failed beside one that answered. If the failed one had a line in the last full reading, the read
    // failed, so readFresh keeps every old number with its age. If it had none (the unified pool's monthly), the
    // line that answered lands.
    // ponytail: xaiLines starts empty, so a partial failure on the first read after a restart lands the good line alone.
    const [lost] = failed;
    if (lost && xaiLines.includes(lost === answers[0] ? 'Monthly' : 'Weekly')) throw lost;
    if (!lost) xaiLines = (shaped.rows || []).map((r) => r.label);
    return { ...shaped, updatedAt: Date.now() };
  } catch (e) {
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter || 60 };
    // A refresh token xAI no longer takes, or a token renewed elsewhere and revoked.
    if (e.status === 401 || e.status === 403) return { error: 'Grok sign-in expired — run `grok` to renew it.' };
    // The billing endpoint answers 503 now and then: soft, so the last numbers stay up until it recovers.
    if (e.status >= 500) return { error: `xAI usage not refreshed (${e.message}).`, soft: true };
    return { error: e.message || 'Request failed', soft: !!e.soft };
  }
}

// ---- This PC. No account and no request, so `local`: read at every tick, never cached, never a reset notice.
// CPU is the load since the previous read; RAM is what Windows doesn't count as available, in Task Manager's GB.
// ponytail: os.cpus() is "% Processor Time"; Task Manager shows "% Processor Utility", which can read higher under turbo.
const GB = 2 ** 30;
let cpuBefore = null;
const cpuTimes = () => os.cpus().reduce((t, c) => ({ idle: t.idle + c.times.idle, all: t.all + Object.values(c.times).reduce((a, b) => a + b, 0) }), { idle: 0, all: 0 });
async function readCpu() {
  // The first read has nothing to compare with: half a second of load beats the average since boot.
  if (!cpuBefore) {
    cpuBefore = cpuTimes();
    await new Promise((r) => setTimeout(r, 500));
  }
  const now = cpuTimes();
  const all = now.all - cpuBefore.all;
  const busy = all > 0 ? 100 * (1 - (now.idle - cpuBefore.idle) / all) : 0;
  cpuBefore = now;
  return { plan: os.cpus()[0]?.model.trim() || '', rows: [{ label: 'Load', percent: clamp(Math.round(busy)), resetsAt: null }], updatedAt: Date.now() };
}
function readRam() {
  const total = os.totalmem();
  const used = total - os.freemem();
  // `resets` is the row's right-hand column, which for RAM holds the GB in use.
  return { plan: `${(total / GB).toFixed(1)} GB`, rows: [{ label: 'In use', percent: clamp(Math.round((100 * used) / total)), resetsAt: null, resets: `${(used / GB).toFixed(1)} GB` }], updatedAt: Date.now() };
}

const PROVIDERS = [
  { id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', everyMs: 5 * 60_000, read: readClaude, readLocal: readClaudeLocal },
  { id: 'codex', name: 'Codex', glyph: '◉', color: '#10a37f', everyMs: 5 * 60_000, read: readCodex },
  { id: 'opencode-go', name: 'OpenCode Go', glyph: '▣', color: '#fab283', everyMs: 5 * 60_000, read: readOpenCodeGo },
  // xAI's mark is monochrome, so it wears the theme's own ink.
  { id: 'xai', name: 'xAI', glyph: '✕', color: 'var(--fg)', everyMs: 5 * 60_000, read: readXai },
  { id: 'cpu', name: 'CPU', glyph: '▦', color: '#5b9cf5', everyMs: 0, local: true, read: readCpu },
  { id: 'ram', name: 'RAM', glyph: '▤', color: '#b48cf2', everyMs: 0, local: true, read: readRam },
];

module.exports = { PROVIDERS, readClaudeLocal, setConsoleKey, shapeApiCredit, creditExpired, fmtReset, nextMonthly, shapeClaude, shapeCodex, shapeCodexUsage, shapeCodexRenewal, shapeOpenCodeGo, shapeXai, shapeCodexResetCredits, windowLabel, ringPercent, resetRows, lastRateLimits };
