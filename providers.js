'use strict';
// One module per data source. Each provider's read() returns the same shape:
//   { plan, rows: [{ label, percent, resetsAt }], error, updatedAt }
// Pure shaping is exported separately so test.js can check it without touching disk or network.

const { execFile } = require('child_process');
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
const ANTIGRAVITY_API = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
const ANTIGRAVITY_UA = 'antigravity/hub/2.24.0 (aidev_client; os_type=windows; arch=amd64)';
const ANTIGRAVITY_AUTH = path.join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
const T3_ANTIGRAVITY_DIR = path.join(HOME, '.t3', 'userdata', 'providers', 'antigravity');
let resetDetailsRetryAt = 0;
const ORCA_CODEX_HOME = process.env.ORCA_CODEX_HOME || (process.env.APPDATA && path.join(process.env.APPDATA, 'orca', 'codex-runtime-home', 'home'));
const CODEX_HOMES = [...new Set([process.env.CODEX_HOME, ORCA_CODEX_HOME, path.join(HOME, '.codex')].filter(Boolean))];
const CODEX_AUTH = path.join(HOME, '.codex', 'auth.json');
const CODEX_SESSION_ROOTS = CODEX_HOMES.map((home) => path.join(home, 'sessions'));
const TAIL_BYTES = 256 * 1024; // rollout files grow to MBs; the last rate_limits is always near the end

const MIN = 60_000;
const HOUR = 60 * MIN;

const ERROR_BODY_MAX_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 2000;

// Retry-After in seconds (RFC 9110 §10.2.3): digits, or an HTTP date, a past one being 0. 0 is a delay like any other.
// null when the header gives none to use: absent, junk, negative, or digits too many for its deadline in ms to be a
// number, or a date that isn't one (httpDate).
function retryAfterSeconds(v) {
  const s = (v || '').trim();
  if (/^\d+$/.test(s)) return Number.isFinite(Date.now() + Number(s) * 1000) ? Number(s) : null;
  const t = httpDate(s);
  return Number.isFinite(t) ? Math.max(0, (t - Date.now()) / 1000) : null;
}

// The three HTTP-date forms (RFC 9110 §5.6.7), every one GMT: IMF-fixdate, RFC 850's and asctime's (a day of a space and
// one digit allowed). Not Date.parse: it reads asctime's in the local zone, rolls 31 Nov over to 1 Dec, and takes "-5".
// The weekday goes unchecked; nothing needs it.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON = `(?<mo>${MONTHS.join('|')})`;
const HMS = '(?<h>\\d\\d):(?<mi>\\d\\d):(?<s>\\d\\d)';
const HTTP_DATES = [
  new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?<d>\\d\\d) ${MON} (?<y>\\d{4}) ${HMS} GMT$`),
  new RegExp(`^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (?<d>\\d\\d)-${MON}-(?<y>\\d\\d) ${HMS} GMT$`),
  new RegExp(`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MON} (?<d>[ \\d]\\d) ${HMS} (?<y>\\d{4})$`),
];
function httpDate(s) {
  const g = HTTP_DATES.map((re) => re.exec(s)?.groups).find(Boolean);
  if (!g) return NaN;
  let y = Number(g.y);
  const [mo, d, h, mi, sec] = [MONTHS.indexOf(g.mo), Number(g.d), Number(g.h), Number(g.mi), Number(g.s)];
  // RFC 850's two-digit year: the latest year ending in those digits that is no more than 50 years ahead, to the second
  // (a date has no milliseconds, so a part second of now never tips it). Only the year 50 on can pass that, and the rest
  // of the date says whether it does. Decided before the day is checked, so 29 Feb lands in the century whose leap year it is.
  if (g.y.length === 2) {
    const now = new Date(Date.now());
    const max = now.getUTCFullYear() + 50;
    y = max - ((max - y) % 100);
    const at = [mo, d, h, mi, sec];
    const cut = [now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()];
    const i = at.findIndex((v, k) => v !== cut[k]);
    if (y === max && i >= 0 && at[i] > cut[i]) y -= 100;
  }
  const day = new Date(Date.UTC(y, mo, d));
  // A day that rolled over (31 Nov, 29 Feb 2026, day 00, or a year under 100 that Date.UTC put in the 1900s) is no date.
  // A second of 60 is a leap second.
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo || day.getUTCDate() !== d || h > 23 || mi > 59 || sec > 60) return NaN;
  return day.getTime() + ((h * 60 + mi) * 60 + sec) * 1000;
}

function buildHttpError(r) {
  const e = new Error(`HTTP ${r.status}`);
  e.status = r.status;
  e.soft = r.status >= 500 || r.status === 408; // a server error or timeout fixes itself: no message, the last numbers stay
  e.retryAfter = retryAfterSeconds(r.headers.get('retry-after'));
  return e;
}

// A failed answer as an error with its status and its Retry-After in seconds, seconds or an HTTP date.
async function httpError(r) {
  const e = buildHttpError(r);
  await r.body?.cancel().catch(() => {}); // a body that already broke rejects here; the status still stands
  return e;
}

// Reads up to 64 KiB of an error response within 2s, cancelling the reader and aborting fetch on deadline or cap so
// the stream is never left locked/open and a stalled body never erases an already-known HTTP status.
async function readBoundedErrorBody(r, abort, signal) {
  let timer;
  let reader = null;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    reader?.cancel().catch(() => {});
    abort?.();
  };
  let settleTimeout;
  const timeout = new Promise((resolve) => {
    settleTimeout = () => {
      stop();
      resolve(null);
    };
    timer = setTimeout(settleTimeout, ERROR_BODY_TIMEOUT_MS);
  });
  if (signal) {
    if (signal.aborted) settleTimeout();
    else signal.addEventListener('abort', settleTimeout, { once: true });
  }
  const read = (async () => {
    try {
      if (r.body && typeof r.body.getReader === 'function') {
        reader = r.body.getReader();
        const chunks = [];
        let total = 0;
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > ERROR_BODY_MAX_BYTES) {
            stop();
            return null;
          }
          chunks.push(Buffer.from(value));
        }
        return stopped ? null : Buffer.concat(chunks).toString('utf8');
      }
      if (typeof r.text === 'function') {
        const text = await r.text();
        if (stopped || Buffer.byteLength(String(text || ''), 'utf8') > ERROR_BODY_MAX_BYTES) return null;
        return String(text || '');
      }
    } catch {
      return null;
    }
    return null;
  })();
  return Promise.race([read, timeout]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', settleTimeout);
  });
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
  return Promise.race([request(ac.signal, () => ac.abort()), late]).finally(() => clearTimeout(timer));
}

async function fetchJson(url, headers, body, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    let knownHttpError = null;
    try {
      return await within(15_000, async (signal, abort) => {
        const r = await fetch(url, { headers, signal, ...(body ? { method: 'POST', body } : {}) });
        if (!r.ok) {
          knownHttpError = buildHttpError(r);
          // The wait holds as the headers land, not once a 403's body is read (2s at most, or cut off): a request made
          // meanwhile, a refresh under a rotated bearer, must find it.
          if (knownHttpError.retryAfter > 0) opts.onRetryAfter?.(knownHttpError.retryAfter);
          if (opts.readErrorBody && r.status === 403) {
            const raw = await readBoundedErrorBody(r, abort, signal);
            if (raw) {
              try {
                const parsed = JSON.parse(raw);
                knownHttpError.errorStatus = typeof parsed?.error?.status === 'string' ? parsed.error.status : '';
                knownHttpError.errorReasons = (Array.isArray(parsed?.error?.details) ? parsed.error.details : [])
                  .map((d) => (typeof d?.reason === 'string' ? d.reason : ''))
                  .filter(Boolean);
              } catch {
                /* non-JSON error body; the HTTP 403 status still stands */
              }
            }
          } else {
            await r.body?.cancel().catch(() => {});
          }
          throw knownHttpError;
        }
        return await r.json();
      });
    } catch (e) {
      // Once headers established an HTTP status, an outer deadline firing during error-body read must never
      // downgrade that known HTTP error into a retryable transport timeout.
      if (knownHttpError) throw knownHttpError;
      // A body cut short (SyntaxError) is as soft as no answer at all.
      const transport = !e.status && (e instanceof TypeError || e instanceof SyntaxError || e.name === 'TimeoutError');
      if (!transport) throw e;
      // The caller says whether a retry may still go: not under a wait that came meanwhile (another request's 429 for the
      // account), nor once the request is called off (a sign-out). Asked before the pause, so a dead one skips it, and after.
      if (attempt === 0 && (!opts.canRetry || opts.canRetry())) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!opts.canRetry || opts.canRetry()) continue;
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
// A row's own comparison key first (an Antigravity bucket's: what it is, not which ID it drew), then its ID, then its
// label, each in a namespace of its own so none can equal another. Window casing is normalized in stored keys so a
// cached uppercase window ("WEEKLY") still matches its lowercased successor after upgrade.
const rowKey = (r) => {
  if (!r.key) return r.id ? `id:${r.id}` : `label:${r.label}`;
  try {
    const p = JSON.parse(r.key);
    if (Array.isArray(p) && (p.length === 3 || p.length === 4)) {
      const wi = p.length === 4 ? 2 : 1;
      if (typeof p[wi] === 'string' && p[wi] !== p[wi].toLowerCase()) {
        const norm = [...p];
        norm[wi] = p[wi].toLowerCase();
        return `key:${JSON.stringify(norm)}`;
      }
    }
  } catch { /* non-JSON key: compare verbatim */ }
  return `key:${r.key}`;
};
const ringPercent = (rows, choice) => {
  const list = rows || [];
  // A stable ID's pool: the row with that ID and every row that belongs to it (duplicates of its bucketId, and ID-less
  // Antigravity rows that are that bucket), the fullest showing. Else a human-readable label match.
  if (choice) {
    const pool = list.filter((r) => r.id === choice || r.bucketId === choice);
    if (pool.length) return Math.max(...pool.map((r) => r.percent));
    const byLabel = list.find((r) => r.label === choice);
    if (byLabel) return byLabel.percent;
  }
  return Math.max(0, ...list.map((r) => r.percent));
};
const resetRows = (previous, current) => {
  // Skip ambiguous rows (whose keys depend on response ordering, or multiple legacy rows that collapse onto one
  // normalized key) and disabled rows (whose 100% display is an artificial lockout override, so re-enabling them at
  // their real usage never fires a false reset). Count collisions across ALL previous rows before filtering disabled
  // rows so a disabled legacy row colliding with an enabled one never makes the survivor look unique.
  const allPrev = previous || [];
  const prevCounts = new Map();
  const prevIdCounts = new Map();
  for (const r of allPrev) {
    prevCounts.set(rowKey(r), (prevCounts.get(rowKey(r)) || 0) + 1);
    if (r.id) prevIdCounts.set(r.id, (prevIdCounts.get(r.id) || 0) + 1);
  }
  const prev = allPrev.filter((r) => !r.ambiguous && !r.disabled && prevCounts.get(rowKey(r)) === 1);
  const before = new Map(prev.map((r) => [rowKey(r), Number(r.percent)]));
  // A known lone bucket (its own canonical bucketId as its ID, no pool beside it) can match when display metadata or its
  // window is added or dropped (even if label disambiguation renamed it), provided any group, window and displayName
  // present on both sides agree. Unknown shared bucketIds require exact comparison-key matches so distinct buckets taking
  // turns never false-reset.
  const lone = (r) => r.id && !r.bucketId && Object.hasOwn(ANTIGRAVITY_BUCKETS, r.id);
  const keyParts = (r) => {
    if (!r.key) return null;
    try {
      const p = JSON.parse(r.key);
      return Array.isArray(p) && p.length === 4 ? p : null;
    } catch {
      return null;
    }
  };
  const sameLone = (a, b) => {
    // [bucketId, group, window, displayName]; a row with no key still has its window.
    const ap = keyParts(a) || [a.id, '', a.win || '', ''];
    const bp = keyParts(b) || [b.id, '', b.win || '', ''];
    return [1, 2, 3].every((i) => !ap[i] || !bp[i] || (i === 2 ? ap[i].toLowerCase() === bp[i].toLowerCase() : ap[i] === bp[i]));
  };
  const beforeLone = new Map(prev.filter((r) => lone(r) && prevIdCounts.get(r.id) === 1).map((r) => [r.id, r]));
  // Under a point is rounding, such as xAI's whole percent against Cursor's fraction of the same pool, not a reset.
  return (current || []).filter((r) => {
    if (r.ambiguous || r.disabled) return false;
    let was = before.get(rowKey(r));
    if (was === undefined && lone(r)) {
      const p = beforeLone.get(r.id);
      if (p && sameLone(p, r)) was = Number(p.percent);
    }
    return was !== undefined && Number(r.percent) <= was - 1;
  });
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
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter ?? 60, ...failed };
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
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter ?? 60, ...renewal() }; // whose, for main
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
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter ?? 60 };
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
    const wait = (e) => e.retryAfter ?? 60;
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
    if (e.status === 429) return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter ?? 60 };
    // A refresh token xAI no longer takes, or a token renewed elsewhere and revoked.
    if (e.status === 401 || e.status === 403) return { error: 'Grok sign-in expired — run `grok` to renew it.' };
    // The billing endpoint answers 503 now and then: soft, so the last numbers stay up until it recovers.
    if (e.status >= 500) return { error: `xAI usage not refreshed (${e.message}).`, soft: true };
    return { error: e.message || 'Request failed', soft: !!e.soft };
  }
}

// ---- Antigravity: Google's OAuth token sits in Windows Credential Manager as `gemini:antigravity`
// (or a fallback token file on headless setups), refreshed while Antigravity runs.
// Usage comes from daily-cloudcode-pa's retrieveUserQuotaSummary, and the plan tier from loadCodeAssist.
const ANTIGRAVITY_TIERS = Object.assign(Object.create(null), {
  'g1-ultra-tier': 'AI Ultra',
  'g1-ultra-lite-tier': 'AI Ultra',
  'g1-pro-tier': 'AI Pro',
  'free-tier': 'Free',
  'standard-tier': 'Standard',
});
const ANTIGRAVITY_BUCKETS = Object.assign(Object.create(null), {
  'gemini-5h': 'Gemini 5h',
  'gemini-weekly': 'Gemini wk',
  '3p-5h': 'Other 5h',
  '3p-weekly': 'Other wk',
});
// The group of non-Gemini models ("Claude and GPT models"), whose ID-less 5h and weekly buckets are Other 5h's and Other
// wk's. Never one led by Gemini.
const THIRD_PARTY = /^(?!gemini\b).*\b(?:claude|gpt|other|3p|third[- ]?party)\b/i;
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// Structured JSON envelope with base64 payload and Win32 error code (1168 = ERROR_NOT_FOUND), so a timeout or
// native read failure is never mistaken for an absent credential or routed to a stale fallback file.
// Empty blobs (CredentialBlobSize == 0 or null pointer) return raw:"" without calling Marshal.Copy, which would throw.
const CRED_READ_PS = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class C { [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CR { public uint F,T; public string N,Co; public long W; public uint S; public IntPtr B; public uint P,Ac; public IntPtr A; public string Ta,U; } [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredRead(string t, uint ty, uint r, out IntPtr p); [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p); public static string Get(string t) { IntPtr p; if (!CredRead(t, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); return "{\\"ok\\":false,\\"notFound\\":" + (e == 1168 ? "true" : "false") + ",\\"code\\":" + e + "}"; } try { var c = Marshal.PtrToStructure<CR>(p); if (c.S == 0 || c.B == IntPtr.Zero) return "{\\"ok\\":true,\\"raw\\":\\"\\"}"; var b = new byte[c.S]; Marshal.Copy(c.B, b, 0, (int)c.S); return "{\\"ok\\":true,\\"raw\\":\\"" + Convert.ToBase64String(b) + "\\"}"; } finally { CredFree(p); } } }'; [Console]::Write([C]::Get('gemini:antigravity'))`;

function defaultWinCredReader() {
  return new Promise((resolve) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', CRED_READ_PS], { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve({ status: 'error', message: err.killed ? 'Antigravity credential lookup timed out' : (err.message || 'Antigravity credential lookup failed') });
      try {
        const res = JSON.parse(stdout || '');
        if (res?.ok && typeof res.raw === 'string') {
          if (!res.raw) return resolve({ status: 'invalid' });
          try {
            return resolve({ status: 'ok', data: JSON.parse(Buffer.from(res.raw, 'base64').toString('utf8')) });
          } catch {
            return resolve({ status: 'invalid' });
          }
        }
        if (res?.notFound) return resolve({ status: 'not_found' });
        return resolve({ status: 'error', message: `Antigravity credential read failed (Win32 ${res?.code ?? 'unknown'})` });
      } catch {
        return resolve({ status: 'error', message: 'Antigravity credential lookup returned invalid data' });
      }
    });
  });
}

let winCredReader = defaultWinCredReader;
function setAntigravityCredReader(fn) {
  winCredReader = fn || defaultWinCredReader;
}

function readCredFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { status: 'not_found' };
    return { status: 'error', message: e?.message || 'Antigravity credential file unreadable' };
  }
  try {
    return { status: 'ok', data: JSON.parse(text) };
  } catch {
    return { status: 'invalid' };
  }
}

function antigravityExpiry(data) {
  const tok = data?.token || data;
  return typeof tok?.expiry === 'string' ? Date.parse(tok.expiry) : typeof tok?.expiry === 'number' ? tok.expiry : NaN;
}

function hasAntigravityAccessToken(data) {
  const tok = data?.token || data;
  return typeof tok?.access_token === 'string' && !!tok.access_token.trim();
}

function readT3AntigravityCreds() {
  let entries;
  try {
    entries = fs.readdirSync(T3_ANTIGRAVITY_DIR, { withFileTypes: true });
  } catch {
    return { valid: [], sawInvalid: false, sawError: null };
  }
  const valid = [];
  let sawInvalid = false;
  let sawError = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(T3_ANTIGRAVITY_DIR, e.name, 'antigravity-acp', 'antigravity-oauth-token');
    const res = readCredFile(file);
    if (res.status === 'ok' && hasAntigravityAccessToken(res.data)) {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* file rotated away mid-scan */ }
      valid.push({ data: res.data, expiry: antigravityExpiry(res.data), mtimeMs, priority: 1 });
    } else if (res.status === 'invalid') {
      sawInvalid = true;
    } else if (res.status === 'error' && !sawError) {
      sawError = res;
    }
  }
  return { valid, sawInvalid, sawError };
}

function compareAntigravityCreds(a, b, now) {
  const aLive = !(Number.isFinite(a.expiry) && a.expiry <= now);
  const bLive = !(Number.isFinite(b.expiry) && b.expiry <= now);
  if (aLive !== bLive) return aLive ? 1 : -1;
  const aExp = Number.isFinite(a.expiry);
  const bExp = Number.isFinite(b.expiry);
  if (aExp !== bExp) return aExp ? 1 : -1;
  if (aExp && a.expiry !== b.expiry) return a.expiry > b.expiry ? 1 : -1;
  if (a.priority !== b.priority) return a.priority > b.priority ? 1 : -1;
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs ? 1 : -1;
  return 0;
}

function pickAntigravityCred(candidates, now = Date.now()) {
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (compareAntigravityCreds(candidates[i], best, now) > 0) best = candidates[i];
  }
  return best;
}

async function readAntigravityCreds() {
  if (process.env.ANTIGRAVITY_AUTH_FILE) return readCredFile(process.env.ANTIGRAVITY_AUTH_FILE);
  let win = null;
  if (process.platform === 'win32' || winCredReader !== defaultWinCredReader) {
    win = await winCredReader();
    // Only consider file sources when Windows Credential Manager either succeeded or confirmed absence
    // (ERROR_NOT_FOUND); a helper timeout, Win32 error, or corrupted/empty credential entry must never
    // silently select another account from an old file.
    if (win.status !== 'ok' && win.status !== 'not_found') return win;
  }
  const candidates = [];
  if (win?.status === 'ok' && hasAntigravityAccessToken(win.data)) {
    candidates.push({ data: win.data, expiry: antigravityExpiry(win.data), mtimeMs: 0, priority: 2 });
  }
  const t3 = readT3AntigravityCreds();
  candidates.push(...t3.valid);
  // Only fall back to the headless CLI token file on confirmed Windows Credential Manager absence.
  if (!win || win.status === 'not_found') {
    const cli = readCredFile(ANTIGRAVITY_AUTH);
    if (cli.status === 'ok' && hasAntigravityAccessToken(cli.data)) {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(ANTIGRAVITY_AUTH).mtimeMs; } catch { /* file rotated away mid-scan */ }
      candidates.push({ data: cli.data, expiry: antigravityExpiry(cli.data), mtimeMs, priority: 0 });
    } else if (!candidates.length && cli.status !== 'not_found') {
      return cli;
    }
  }
  if (candidates.length) return { status: 'ok', data: pickAntigravityCred(candidates).data };
  if (win?.status === 'ok') return win;
  if (t3.sawError) return t3.sawError;
  if (t3.sawInvalid) return { status: 'invalid' };
  return { status: 'not_found' };
}

// Whitespace-only token hashes that an earlier build could have linked across distinct accounts before blank tokens
// were rejected. Any saved alias group, cache entry, or gate origin touching one is invalidated on restore.
const BLANK_TOKEN_KEYS = new Set([
  '\t', '\n', '\r', '\r\n', ' \t', '\t ',
  ...Array.from({ length: 64 }, (_, i) => ' '.repeat(i + 1)),
].flatMap((s) => {
  const h = accountKey(s);
  return [h, `tok:${h}`];
}));
const hasBlankTokenKey = (keys) => Array.isArray(keys) && keys.some((k) => BLANK_TOKEN_KEYS.has(k));

function antigravityIdentity(raw) {
  const tok = raw?.token || raw;
  const email = typeof raw?.id_token_email === 'string' && raw.id_token_email.trim().toLowerCase();
  const refresh = typeof tok?.refresh_token === 'string' && tok.refresh_token.trim() ? tok.refresh_token : '';
  const access = typeof tok?.access_token === 'string' && tok.access_token.trim() ? tok.access_token : '';
  const tokenHash = access ? accountKey(access) : null;
  const refreshHash = refresh ? accountKey(refresh) : null;
  const strong = email || refresh;
  if (strong) {
    const account = accountKey(strong);
    // Include the hashed refresh token alongside email so rotating the bearer when email is absent/added still matches Retry-After.
    const gateKeys = [...new Set([account, ...(refreshHash ? [refreshHash] : []), ...(tokenHash ? [`tok:${tokenHash}`] : [])])];
    return { account, gateKey: account, gateKeys, tokenHash, hasRefresh: !!refresh, identityWeak: false };
  }
  if (access) {
    // Access-token-only credentials cannot distinguish rotation from account switch, so 429 gating is conservative,
    // and carrying the hashed bearer token preserves backoff if refresh_token/email is later added to the same token.
    return { account: tokenHash, gateKey: '__weak__', gateKeys: ['__weak__', `tok:${tokenHash}`], tokenHash, hasRefresh: false, identityWeak: true };
  }
  return { account: null, gateKey: null, gateKeys: [], tokenHash: null, hasRefresh: false, identityWeak: true };
}

// Which backoff keys belong to one account. An email, a refresh token and a bearer each name a single account, so every
// credential read links the ones it carries, for good: a Retry-After then holds back every key its account has shown,
// whenever the 429 lands and whatever the credential has become since, across account switches too. `__weak__` stands
// for every bare bearer nothing names: it never links, and only such a bearer reads it (see antigravityAliases).
// ponytail: forgets the least recently seen key past 128 (a bearer rotates about hourly, so days-old ones). main.js
// saves the groups (antigravityLinks) whenever one gains a key, so a restart knows them before any wait is read; a
// restart loses only the order they were last seen in.
const agAliases = new Map(); // key -> Set of keys proven to be the same account, shared by all of them
// True when a group of two or more keys gained one: a link worth saving.
function linkAntigravityKeys(keys) {
  const strong = [...new Set((keys || []).filter((k) => k && k !== '__weak__'))];
  if (!strong.length) return false;
  const groups = new Set(strong.map((k) => agAliases.get(k)).filter(Boolean));
  const group = groups.size === 1 ? [...groups][0] : new Set([...groups].flatMap((g) => [...g]));
  const grew = groups.size > 1 || strong.some((k) => !group.has(k));
  for (const k of strong) group.add(k);
  if (groups.size > 1) for (const k of group) agAliases.set(k, group);
  for (const k of strong) {
    agAliases.delete(k); // the most recently seen go last, so the oldest go first
    agAliases.set(k, group);
  }
  for (const [k, g] of agAliases) {
    if (agAliases.size <= 128) break;
    agAliases.delete(k);
    g.delete(k);
  }
  return grew && group.size > 1;
}
// The groups to save: hashed keys only (accountKey), 128 at most. A lone key links nothing.
const antigravityLinks = () => [...new Set(agAliases.values())].filter((g) => g.size > 1).map((g) => [...g]);
// For test.js's simulated restarts: a real one starts with no links and no tier deadlines but those state.json kept.
const clearAntigravityAliases = () => agAliases.clear();
const clearAntigravityTierGates = () => (tierGates.splice(0), tierRejected.clear());
// The keys a credential's deadline is read from: its own and every key linked to them. A bare bearer reads `__weak__`
// only while nothing names it, since it could be any bare token's rotation; one an email or refresh token came with is
// that account's. Writes go here and to the credential's own keys, so a named bearer still leaves its wait on
// `__weak__` for its account's unnamed rotations.
function antigravityAliases(keys) {
  const out = new Set();
  let bare = false;
  for (const k of keys || []) {
    if (k === '__weak__') bare = true;
    else if (k) {
      out.add(k);
      for (const m of agAliases.get(k) || []) out.add(m);
    }
  }
  if (bare && out.size <= 1) out.add('__weak__');
  return [...out];
}

// Retry-After deadlines, quota's (main.js) and loadCodeAssist's (tierGates) alike: [{ until, keys, origin }]. A wait
// holds back every key in `keys`: the account's that drew it, `__weak__` once that account shows a bare bearer, and the
// bare bearers that read it there, since each may be the account's next. `origin` is the keys proven to be the drawer's:
// the bearer that drew it, and every key since linked to that bearer, so a bare bearer that drew one is named the moment
// it comes with an email or refresh token. When a bearer that waited under `__weak__` is named as an account the origin
// names none of, the wait was another account's and no longer holds it. A wait whose drawer nothing has named still does:
// it may be this account's. Records are saved whole, so a restart knows whose a wait is.
const namesAccount = (keys) => keys.some((k) => k !== '__weak__' && !k.startsWith('tok:'));
function gateUntil(list, keys, now = Date.now()) {
  const read = antigravityAliases(keys);
  const all = [...new Set([...read, ...(keys || [])])].filter(Boolean);
  let until = 0;
  let changed = false;
  const add = (to, ks) => {
    for (const k of ks) {
      if (!to.includes(k)) {
        to.push(k);
        changed = true;
      }
    }
  };
  for (const g of list) {
    if (g.until <= now) continue;
    const owner = antigravityAliases(g.origin); // no `__weak__`: an origin never holds it
    add(g.origin, owner);
    add(g.keys, owner);
    if (!read.some((k) => g.keys.includes(k))) continue;
    const mine = read.some((k) => g.origin.includes(k));
    if (!mine && namesAccount(read) && namesAccount(g.origin)) continue;
    until = Math.max(until, g.until);
    add(g.keys, all);
    if (mine && namesAccount(g.origin)) add(g.origin, read.filter((k) => k !== '__weak__'));
  }
  return { until, changed };
}
// Expanded when the answer lands, not when the request left, so keys linked meanwhile are covered too.
function gateSet(list, keys, until, now = Date.now()) {
  const all = [...new Set([...antigravityAliases(keys), ...(keys || [])])].filter(Boolean);
  if (!all.length || !Number.isFinite(until)) return; // a deadline that never comes would hold the account for good
  for (let i = list.length; i--;) if (list[i].until <= now) list.splice(i, 1);
  list.push({ until, keys: all, origin: all.filter((k) => k !== '__weak__') });
}
// Saved records, the live ones. The format before origins ({ key: until }) comes back with none known, so it holds.
const isKeyList = (a) => Array.isArray(a) && a.every((k) => typeof k === 'string');
const gateList = (raw, now = Date.now()) => (Array.isArray(raw) ? raw : Object.entries(raw && typeof raw === 'object' ? raw : {}).map(([k, until]) => ({ until, keys: [k], origin: [] })))
  .filter((g) => g && typeof g.until === 'number' && g.until > now && isKeyList(g.keys) && isKeyList(g.origin))
  .map((g) => ({ until: g.until, keys: [...g.keys], origin: [...g.origin] }));
// A restart's links, from what state.json kept: the saved groups, the saved reading's keys, and the origin of each saved
// wait that names an account, quota's and loadCodeAssist's. A bare bearer that only waited under `__weak__` is in `keys`,
// never linked. A saved key that isn't a hash (a hand-edited file) links nothing. Any saved group, gate origin, or
// reading linked through a blank-token hash from an older build is discarded, and returns true if `reading` is tainted.
function restoreAntigravityLinks(reading, gates, links) {
  const tainted = new Set(BLANK_TOKEN_KEYS);
  const addTainted = (ks) => { for (const k of ks) if (typeof k === 'string') tainted.add(k); };
  let dirty = false;
  const cleanLinks = [];
  if (Array.isArray(links)) {
    for (const g of links) {
      if (!isKeyList(g)) continue;
      if (hasBlankTokenKey(g)) {
        addTainted(g);
        dirty = true;
      } else cleanLinks.push(g);
    }
  }
  const cleanGates = [];
  const purgeGates = (list) => {
    for (let i = list.length; i--;) {
      const g = list[i];
      if (hasBlankTokenKey(g.origin) || hasBlankTokenKey(g.keys)) {
        addTainted(g.origin);
        addTainted(g.keys);
        list.splice(i, 1);
        dirty = true;
      } else {
        cleanGates.push({ list, gate: g });
      }
    }
  };
  purgeGates(gates);
  purgeGates(tierGates);
  const readingTainted = !!(reading && (tainted.has(reading.renewsFor) || (isKeyList(reading.gateKeys) && reading.gateKeys.some((k) => tainted.has(k)))));
  if (readingTainted && isKeyList(reading?.gateKeys)) addTainted(reading.gateKeys);
  for (const g of cleanLinks) {
    if (g.some((k) => tainted.has(k))) dirty = true;
    else linkAntigravityKeys(g.filter((k) => /^(?:tok:)?[0-9a-f]{12}$/.test(k)));
  }
  if (!readingTainted && isKeyList(reading?.gateKeys)) linkAntigravityKeys(reading.gateKeys);
  for (const { list, gate } of cleanGates) {
    if (gate.origin.some((k) => tainted.has(k)) || gate.keys.some((k) => tainted.has(k))) {
      const idx = list.indexOf(gate);
      if (idx >= 0) list.splice(idx, 1);
      dirty = true;
    } else if (namesAccount(gate.origin)) linkAntigravityKeys(gate.origin);
  }
  return { readingTainted, dirty: dirty || readingTainted };
}

function parseTierObj(tier) {
  if (!tier || typeof tier !== 'object') return '';
  if (typeof tier.id === 'string' && Object.hasOwn(ANTIGRAVITY_TIERS, tier.id)) return ANTIGRAVITY_TIERS[tier.id];
  return typeof tier.name === 'string' && tier.name.trim() ? tier.name.trim().replace(/^Google\s+/i, '') : '';
}

function parseAntigravityPlan(assist) {
  return parseTierObj(assist?.paidTier) || parseTierObj(assist?.currentTier);
}

// Strict ProtoJSON decimal/exponent float syntax: rejects non-decimal forms like "0b0" or "0x1".
const PROTO_FLOAT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function shapeAntigravity(summary, assist) {
  const plan = typeof assist === 'string' ? assist : parseAntigravityPlan(assist);
  const groups = Array.isArray(summary?.groups) ? summary.groups : [];
  const order = (w) => {
    const s = typeof w === 'string' ? w.trim().toLowerCase() : '';
    return s === '5h' ? 0 : s === 'weekly' || s === 'wk' ? 1 : 2;
  };
  // Parse valid buckets first so malformed/skipped buckets cannot affect duplicate detection, and count raw
  // bucketIds and comparison keys across all groups.
  const items = [];
  const idCounts = new Map();
  const keyCounts = new Map();
  for (const g of groups) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
    const buckets = Array.isArray(g.buckets) ? [...g.buckets].sort((a, b) => order(a?.window) - order(b?.window)) : [];
    // Any other type (an object with no usable toString, a number) is no name: one malformed group must not throw away
    // every valid row.
    const rawGroup = typeof g.displayName === 'string' ? g.displayName.trim() : '';
    const groupName = rawGroup.replace(/\s+models?\s*$/i, '').trim();
    for (const b of buckets) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
      const parsedReset = typeof b.resetTime === 'string' && b.resetTime.trim() ? Date.parse(b.resetTime) : NaN;
      // Protobuf zero-timestamp (1970-01-01T00:00:00Z / .000Z / +00:00) and invalid dates count as no reset time.
      const resetTime = Number.isFinite(parsedReset) && parsedReset > 0 ? b.resetTime.trim() : null;
      const rawId = typeof b.bucketId === 'string' && b.bucketId.trim() ? b.bucketId.trim() : undefined;
      const rawWin = typeof b.window === 'string' ? b.window.trim() : '';
      const lowWin = rawWin.toLowerCase();
      const win = lowWin === 'weekly' || lowWin === 'wk' ? 'wk' : lowWin === '5h' ? '5h' : rawWin;
      const disp = typeof b.displayName === 'string' ? b.displayName.trim() : '';
      if (!rawId && !rawWin && !disp && !resetTime && b.disabled !== true && (b.remainingFraction === undefined || b.remainingFraction === null)) continue;
      let percent;
      if (b.disabled === true) {
        percent = 100;
      } else if (b.remainingFraction === undefined || b.remainingFraction === null) {
        // Proto3 JSON omits 0.0 when a bucket is exhausted; an active resetTime distinguishes drained from untouched.
        percent = resetTime ? 100 : 0;
      } else {
        const rawFrac = b.remainingFraction;
        let frac = NaN;
        if (typeof rawFrac === 'number') frac = rawFrac;
        else if (typeof rawFrac === 'string' && PROTO_FLOAT.test(rawFrac.trim())) frac = Number(rawFrac.trim());
        if (!Number.isFinite(frac) || frac < 0 || frac > 1) continue; // reject malformed or out-of-range values
        percent = clamp(Math.round((1 - frac) * 1000) / 10);
      }
      const qualifier = [groupName, win, disp].filter(Boolean).join('|');
      const hasWin = (s) => win && (win === 'wk' ? /\b(?:wk|weekly)\b/i : new RegExp(`\\b${win.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')).test(s);
      const baseLabel = groupName
        ? (win ? `${groupName} ${win}` : disp || groupName)
        : disp
          ? (win && !hasWin(disp) ? `${disp} ${win}` : disp)
          : win || rawId || 'Usage';
      // What the bucket is, the same whether or not another shares its bucketId: resetRows compares by it. Built from the
      // API's own fields, since the label's shortening ("Alpha Models" and "Alpha" both show as "Alpha") would join two
      // buckets. Window is lowercased so "weekly" and "WEEKLY" match while "weekly" and "wk" stay distinct.
      const key = JSON.stringify(rawId ? [rawId, rawGroup, lowWin, disp] : [rawGroup, lowWin, disp]);
      // An ID-less bucket that shows as a known one ("Gemini 5h"), or a 5h or weekly one of the third-party group ("Claude
      // and GPT models"), is that bucket: in its pool, so a choice of it finds this row (ringPercent), whatever suffix the
      // label takes below. Non-standard named groups (e.g. "Gemini 4 Argon") stay out of standard Gemini/Other pools.
      const dispName = disp.replace(/\s+models?\s*$/i, '').trim();
      const normWk = (s) => s.replace(/\bweekly\b/i, 'wk');
      const allowKnownPool = !groupName || /^(?:gemini|other)$/i.test(groupName);
      const grpDisp = groupName && !win && dispName ? `${groupName} ${dispName}` : '';
      const poolNames = allowKnownPool
        ? [
          baseLabel, normWk(baseLabel),
          ...(grpDisp ? [grpDisp, normWk(grpDisp)] : []),
          ...(!groupName && dispName ? [[dispName, win].filter(Boolean).join(' ')] : []),
        ].map((s) => s.toLowerCase())
        : [];
      const pool = rawId || Object.keys(ANTIGRAVITY_BUCKETS).find((k) => poolNames.includes(ANTIGRAVITY_BUCKETS[k].toLowerCase())) ||
        (THIRD_PARTY.test(groupName || dispName) ? (win === '5h' || (!win && /\b5h\b/i.test(disp)) ? '3p-5h' : win === 'wk' || (!win && /\b(?:wk|weekly)\b/i.test(disp)) ? '3p-weekly' : undefined) : undefined);
      if (rawId) idCounts.set(rawId, (idCounts.get(rawId) || 0) + 1);
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
      items.push({ rawId, rawWin: lowWin, pool, qualifier, baseLabel, key, percent, resetTime, disabled: b.disabled === true });
    }
  }
  // A duplicate's row ID is its bucketId and what tells it apart, never a bucketId the answer holds (so a choice of one
  // shows that bucket, or that pool's maximum: ringPercent), and handed out in key order, so the answer's order can't
  // move an ID to another bucket. A lone bucket's is its bucketId.
  const ids = new Map();
  const taken = new Set(items.map((it) => it.rawId).filter(Boolean));
  for (const it of [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (!it.rawId || idCounts.get(it.rawId) === 1) continue;
    const stem = it.qualifier ? `${it.rawId}@${it.qualifier}` : it.rawId;
    let id = it.qualifier ? stem : `${stem}#1`;
    for (let n = 2; taken.has(id); n++) id = `${stem}#${n}`;
    taken.add(id);
    ids.set(it, id);
  }
  const rows = [];
  const usedLabels = new Set();
  for (const it of items) {
    const { rawId, rawWin, pool, baseLabel, key, percent, resetTime, disabled } = it;
    const id = ids.get(it) || rawId;
    // Two buckets nothing tells apart: which is which can follow the answer's order, so neither is compared.
    const ambiguous = keyCounts.get(key) > 1;
    const knownLabel = rawId && Object.hasOwn(ANTIGRAVITY_BUCKETS, rawId) ? ANTIGRAVITY_BUCKETS[rawId] : '';
    let label = (id === rawId && knownLabel) || baseLabel;
    if (usedLabels.has(label)) {
      if (id && !usedLabels.has(id)) {
        label = id;
      } else {
        let n = 2;
        while (usedLabels.has(`${label} (${n})`)) n++;
        label = `${label} (${n})`;
      }
    }
    usedLabels.add(label);
    rows.push({
      ...(id ? { id } : {}),
      key,
      ...(rawWin ? { win: rawWin } : {}), // the quota window, for resetRows: main strips it with the key
      ...(pool && pool !== id ? { bucketId: pool } : {}),
      ...(ambiguous ? { ambiguous: true } : {}),
      ...(disabled ? { disabled: true } : {}),
      label,
      percent,
      resetsAt: resetTime,
    });
  }
  return rows.length ? { plan, rows } : { plan, error: 'No usage windows reported.' };
}

// Per-account tier lookup from loadCodeAssist: never blocks quota, refreshes on token rotation or every 6 hours,
// keeps one in-flight request per account, holds a Retry-After over every key the account has shown (gateUntil),
// and never evicts unexpired deadlines. main.js saves the deadlines (watchTierGates), so a restart keeps them too.
const ANTIGRAVITY_TIER_TTL = 6 * HOUR;
const antigravityTiers = new Map(); // account -> { plan: '', fetchedAt: 0, tokenHash: null, inflight: null }
const tierGates = []; // loadCodeAssist's Retry-After deadlines (gateUntil); a later shorter answer never cuts one short
let tierGatesChanged = null; // main.js's save
// A bearer whose lookup failed with no Retry-After (a refusal, a plain 403 or 5xx, no answer, or no plan) -> until when it
// isn't sent again: our own backoff, so it holds only that bearer. tierGates would spread it over the account, and hold
// the replacement a rotation or a new sign-in brings. A sign-out clears it (clearTierPlans).
// ponytail: in memory, so a restart sends a failing bearer once more.
const tierRejected = new Map();
// Bearer -> [the newest-begun quota request that answered for it, whether that answer refused it (401/auth-403)], so a
// pending loadCodeAssist retry for a refused bearer cancels, and an older refusal landing after a newer success says nothing.
const quotaAnswers = new Map();
let quotaSeq = 0;
function holdBearer(tokenHash, ms) {
  const now = Date.now();
  for (const [k, until] of tierRejected) if (until <= now) tierRejected.delete(k);
  tierRejected.set(tokenHash, Math.max(tierRejected.get(tokenHash) || 0, now + ms));
}
const antigravityTierPending = new Map(); // linked key -> the lookup in flight for that key's account
let antigravityTierGen = 0;
// The bearer and expiry the newest-begun credential read found (peekAntigravityCred). A lookup's retry goes only while
// that bearer is still current and unexpired, so a rotation, another account, or a newly-expired credential read during
// the pause calls the retry off. An older read landing late says nothing.
let latestBearer = null;
let latestExpiry = NaN;
let peekSeq = 0;
let latestPeek = 0;
// The keys a 429 is to hold, for each request out, quota's and loadCodeAssist's: its credential's, and those of every
// credential of that account seen while it is out (peekAntigravityCred), `__weak__` when one came bare, as gateUntil adds
// it for a bare bearer seen after the 429. gateSet leaves `__weak__` out of the origin, which stays the account's.
const antigravityOut = new Set();

let tierSeq = 0; // counts loadCodeAssist requests as they start so older late responses never roll back newer plans
function tierSlot(account) {
  let slot = antigravityTiers.get(account);
  if (!slot) {
    if (antigravityTiers.size >= 20) {
      const now = Date.now();
      for (const [k, v] of antigravityTiers) {
        if (!v.inflight && !tierGates.some((g) => g.until > now && g.keys.includes(k))) {
          antigravityTiers.delete(k);
          break;
        }
      }
    }
    slot = { plan: '', fetchedAt: 0, seq: 0, tokenHash: null, inflight: null };
    antigravityTiers.set(account, slot);
  }
  return slot;
}

// The account's newest lookup under any name it has shown. Slots go by the primary key, which changes as an email comes
// or goes (the bearer and refresh token kept), and a bare bearer's slot is its hash, linked as `tok:` + hash.
// Ordered by launch sequence (`seq`) so a slower older lookup landing after a newer one never rolls back the plan.
function newestTier(account, keys = []) {
  let best = antigravityTiers.get(account);
  for (const k of antigravityAliases([...keys, account, `tok:${account}`])) {
    const s = antigravityTiers.get(k.replace(/^tok:/, ''));
    if (s && s.plan && (s.seq > (best?.seq || 0) || (s.seq === (best?.seq || 0) && s.fetchedAt > (best?.fetchedAt || 0)))) best = s;
  }
  return best;
}

function setTierRetry(gateKeys, until) {
  gateSet(tierGates, gateKeys, until);
  tierGatesChanged?.();
}
// A restart's saved deadlines join those on hand (test.js reloads state mid-run), each once.
function restoreTierGates(raw) {
  const have = new Set(tierGates.map((g) => JSON.stringify(g)));
  for (const g of gateList(raw)) if (!have.has(JSON.stringify(g))) tierGates.push(g);
}

function clearTierPlans() {
  antigravityTierGen++;
  for (const slot of antigravityTiers.values()) {
    slot.plan = '';
    slot.fetchedAt = 0;
    slot.seq = 0;
    slot.tokenHash = null;
    slot.inflight = null;
  }
  antigravityTierPending.clear();
  tierRejected.clear(); // the API's Retry-After (tierGates) still holds
  quotaAnswers.clear();
}

// isOn: main.js's say that Antigravity is still switched on, asked before a retry.
function ensureAntigravityTier(cred, headers, isOn, launchSeq = 0) {
  const { account, gateKeys, tokenHash, expiry } = cred;
  const slot = tierSlot(account);
  // Copied, not shared: a lookup in flight still lands in the slot it was made for.
  const newest = newestTier(account, gateKeys);
  if (newest && newest !== slot && newest.seq > slot.seq) Object.assign(slot, { plan: newest.plan, fetchedAt: newest.fetchedAt, seq: newest.seq, tokenHash: newest.tokenHash });
  const now = Date.now();
  const stale = !slot.plan || slot.tokenHash !== tokenHash || now - slot.fetchedAt >= ANTIGRAVITY_TIER_TTL;
  if (!stale || slot.inflight) return slot;
  const held = gateUntil(tierGates, gateKeys, now);
  if (held.changed) tierGatesChanged?.();
  if (held.until > now || tierRejected.get(tokenHash) > now) return slot;
  // Slots go by the primary key, which changes when an email comes or goes: the account's other keys find its lookup.
  const linked = antigravityAliases(gateKeys).filter((k) => k !== '__weak__');
  if (linked.some((k) => antigravityTierPending.has(k))) return slot;
  const gen = antigravityTierGen;
  const out = [...gateKeys];
  antigravityOut.add(out);
  let req;
  // A retry goes only under a bearer still current: not after a sign-out, a newer bearer read (a rotation or another
  // account), its expiry, or Antigravity switched off, nor under a wait come meanwhile. One called off holds nothing.
  let retryCancelled = false;
  const canRetry = () => {
    const now = Date.now();
    const qa = quotaAnswers.get(tokenHash);
    let go = gen === antigravityTierGen &&
      latestBearer === tokenHash &&
      !(qa && qa[0] >= launchSeq && qa[1]) &&
      !(Number.isFinite(expiry) && expiry <= now) &&
      !(Number.isFinite(latestExpiry) && latestExpiry <= now) &&
      (!isOn || isOn());
    if (go) {
      const wait = gateUntil(tierGates, out);
      if (wait.changed) tierGatesChanged?.();
      go = wait.until <= now;
    }
    if (!go) retryCancelled = true;
    return go;
  };
  // Switched off since it went out, even if on again: a wait of our own would hold the lookup the switch-on makes, a
  // replacement bearer's included. The API's Retry-After still holds.
  const switchedOff = () => !!isOn && !isOn();
  // Our own backoff goes on this bearer alone, and not once signed out or switched off since it went out.
  const backOff = (ms) => {
    if (!switchedOff() && gen === antigravityTierGen) holdBearer(tokenHash, ms);
  };
  // The API's wait is recorded as its headers land (fetchJson), once: each check since copies it onto the keys it shows.
  let heldUntil = 0;
  const onRetryAfter = (secs) => setTierRetry(out, (heldUntil = Date.now() + secs * 1000));
  const seq = ++tierSeq;
  req = fetchJson(`${ANTIGRAVITY_API}:loadCodeAssist`, headers, '{}', { readErrorBody: true, canRetry, onRetryAfter })
    .then((d) => {
      if (gen !== antigravityTierGen) return; // sign-out invalidated this in-flight tier lookup
      const plan = parseAntigravityPlan(d);
      if (plan) {
        if (seq < (newestTier(account, out)?.seq || 0) || seq < slot.seq) return;
        slot.plan = plan;
        slot.fetchedAt = Date.now();
        slot.seq = seq;
        slot.tokenHash = tokenHash;
      } else backOff(5 * MIN);
    })
    .catch((e) => {
      // Signed out meanwhile, the retry called off, the bearer replaced or expired, or switched off: a failure that
      // isn't the API's holds nothing.
      if ((gen !== antigravityTierGen || retryCancelled || latestBearer !== tokenHash || (Number.isFinite(latestExpiry) && latestExpiry <= Date.now()) || switchedOff()) && !e.status) return;
      // A refusal or a 403 waits five minutes, anything else one. Only the API's wait holds the account: its Retry-After,
      // or a 429's minute when it names none, as quota's does. When the API names a wait, 0 included, don't hold the
      // bearer past it unless the bearer itself was refused.
      const wait = e.retryAfter ?? (e.status === 429 ? 60 : null);
      if (wait > 0 && !heldUntil) setTierRetry(out, Date.now() + wait * 1000);
      if (wait === null || isAntigravityAuthError(e)) backOff(isAntigravityAuthError(e) || e.status === 403 ? 5 * MIN : MIN);
    })
    .finally(() => {
      antigravityOut.delete(out);
      if (slot.inflight === req) slot.inflight = null;
      for (const k of linked) if (antigravityTierPending.get(k) === req) antigravityTierPending.delete(k);
    });
  slot.inflight = req;
  for (const k of linked) antigravityTierPending.set(k, req);
  return slot;
}

// Reads and normalizes the current Antigravity credential snapshot once, so main.js can verify account identity and
// generation before mutating tier caches, checking per-account gates, or publishing quota. Its one side effect is
// linking the snapshot's keys (agAliases), a fact about the account that holds however the read is used.
async function peekAntigravityCred() {
  const seq = ++peekSeq;
  const cred = await readAntigravityCreds();
  if (cred.status === 'error') return { status: 'error', error: cred.message, soft: true };
  if (cred.status === 'invalid') {
    if (seq > latestPeek) [latestPeek, latestBearer, latestExpiry] = [seq, null, NaN];
    return { status: 'signed_out', error: 'Antigravity credentials unreadable — open Antigravity to sign in.', signedOut: true };
  }
  const tok = cred.status === 'ok' ? (cred.data?.token || cred.data) : null;
  const accessToken = typeof tok?.access_token === 'string' && tok.access_token.trim() ? tok.access_token : '';
  if (!accessToken) {
    if (seq > latestPeek) [latestPeek, latestBearer, latestExpiry] = [seq, null, NaN];
    return { status: 'signed_out', error: 'No Antigravity credentials — open Antigravity to sign in.', signedOut: true };
  }
  const { account, gateKey, gateKeys, tokenHash, hasRefresh, identityWeak } = antigravityIdentity(cred.data);
  // A date or epoch ms. Anything else (null, an object) is no expiry: never coerced, which can throw or read null as 1970.
  const expiry = typeof tok.expiry === 'string' ? Date.parse(tok.expiry) : typeof tok.expiry === 'number' ? tok.expiry : NaN;
  const expired = Number.isFinite(expiry) && expiry <= Date.now();
  if (seq > latestPeek) [latestPeek, latestBearer, latestExpiry] = [seq, tokenHash, expiry];
  // `linked` tells the caller a new link formed, for main.js to save (antigravityLinks).
  const linked = linkAntigravityKeys(gateKeys);
  const seen = antigravityAliases(gateKeys).filter((k) => k !== '__weak__');
  for (const out of antigravityOut) if (seen.some((k) => out.includes(k))) out.push(...gateKeys.filter((k) => !out.includes(k)));
  // Every key the account shows joins its loadCodeAssist wait at once, as quota's does in main.js, so a restart finds it.
  if (gateUntil(tierGates, gateKeys).changed) tierGatesChanged?.();
  return { status: 'ok', account, gateKey, gateKeys, tokenHash, identityWeak, hasRefresh, accessToken, expiry, expired, linked };
}

const isAntigravityAuthError = (e) =>
  e.status === 401 ||
  (e.status === 403 && (
    /^UNAUTHENTICATED$/i.test(e.errorStatus || '') ||
    (e.errorReasons || []).some((r) => /^(?:ACCESS_TOKEN_EXPIRED|ACCESS_TOKEN_INVALID|AUTH_ERROR|UNAUTHENTICATED|INVALID_CREDENTIALS|CREDENTIALS_EXPIRED)$/i.test(r))
  ));

// opts.canRetry(keys): main.js's say on a transport retry, false under a quota wait it has recorded for those keys or
// once the read is superseded (a sign-out, another account, Antigravity switched off). opts.isOn(): whether Antigravity
// is still switched on, asked before a loadCodeAssist retry. opts.onRetryAfter(secs, keys): a positive Retry-After, told
// as the answer's headers land.
async function readAntigravity(preCred, opts = {}) {
  const cred = preCred || await peekAntigravityCred();
  if (cred.status === 'error') return { error: cred.error, soft: true };
  if (cred.status === 'signed_out') {
    if (!preCred) clearTierPlans();
    return { error: cred.error, signedOut: true };
  }
  const { account, gateKey, gateKeys, accessToken, expiry, hasRefresh } = cred;
  if (Number.isFinite(expiry) && expiry <= Date.now()) {
    return hasRefresh
      ? { error: 'Session expired — open Antigravity.', authError: true, soft: true, renewsFor: account, gateFor: gateKey, gateKeys }
      : { error: 'Session expired — open Antigravity.', authError: true, tokenHash: cred.tokenHash, renewsFor: account, gateFor: gateKey, gateKeys };
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_UA,
  };
  const reqTierGen = antigravityTierGen;
  const seq = ++quotaSeq;
  // Fire tier lookup in the background without blocking quota; if it settles before quota does, this read gets the plan immediately.
  const slot = ensureAntigravityTier(cred, headers, opts.isOn, seq);
  const out = [...gateKeys];
  antigravityOut.add(out);
  const answered = (refused) => {
    if (!cred.tokenHash || reqTierGen !== antigravityTierGen || (quotaAnswers.get(cred.tokenHash)?.[0] || 0) > seq) return;
    quotaAnswers.delete(cred.tokenHash);
    quotaAnswers.set(cred.tokenHash, [seq, refused]);
    if (quotaAnswers.size > 64) quotaAnswers.delete(quotaAnswers.keys().next().value);
  };
  try {
    // Never a retry once the bearer was replaced/signed out or its stored expiry has passed: the one it was sent with,
    // or a nearer one the newest credential read found for it (including an expired snapshot whose check was overtaken).
    const canRetry = () => {
      const now = Date.now();
      return latestBearer === cred.tokenHash &&
        !(Number.isFinite(expiry) && expiry <= now) &&
        !(Number.isFinite(latestExpiry) && latestExpiry <= now) &&
        (!opts.canRetry || opts.canRetry(out));
    };
    // A Retry-After goes to main.js as its headers land, on `out`, before a 403's body is read (opts.onRetryAfter).
    const onRetryAfter = (secs) => opts.onRetryAfter?.(secs, out);
    const summary = await fetchJson(`${ANTIGRAVITY_API}:retrieveUserQuotaSummary`, headers, '{}', { readErrorBody: true, canRetry, onRetryAfter });
    answered(false);
    return { ...shapeAntigravity(summary, newestTier(account, out)?.plan || slot.plan), renewsFor: account, gateFor: gateKey, gateKeys, updatedAt: Date.now() };
  } catch (e) {
    // main.js records the wait on `out` as this answer lands, before any later credential check. Any answer's Retry-After
    // holds (a 503's too); only a 429 waits without one.
    if (e.status === 429) {
      answered(false);
      return { error: 'Rate limited', soft: true, retryAfter: e.retryAfter ?? 60, renewsFor: account, gateFor: gateKey, gateKeys: out };
    }
    const hasRetry = Number.isFinite(e.retryAfter) && e.retryAfter >= 0;
    const whose = { renewsFor: account, gateFor: gateKey, ...(hasRetry ? { retryAfter: e.retryAfter, gateKeys: out } : { gateKeys }) };
    // The bearer refused, so main can sequence and record the refusal before its post-fetch check (main strips
    // tokenHash before any screen) and any pending loadCodeAssist transport retry for this bearer is called off.
    // With a refresh_token on disk the 1-hour access token simply lapsed while Antigravity sat idle, so return soft
    // to keep the last good numbers on screen unless a newer check drops refresh_token.
    if (isAntigravityAuthError(e)) {
      answered(true);
      return {
        error: 'Session expired — open Antigravity.',
        authError: true,
        tokenHash: cred.tokenHash,
        ...(hasRefresh ? { soft: true } : {}),
        ...whose,
      };
    }
    if (e.status === 403) {
      answered(false);
      return { error: 'Antigravity access denied — check your Antigravity account permissions.', tokenHash: cred.tokenHash, ...whose };
    }
    return { error: e.message || 'Request failed', soft: !!e.soft, ...whose };
  } finally {
    antigravityOut.delete(out);
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
  { id: 'claude', name: 'Claude', glyph: '✳', color: '#ff7043', color2: '#ff966b', everyMs: 5 * 60_000, read: readClaude, readLocal: readClaudeLocal },
  { id: 'codex', name: 'Codex', glyph: '◉', color: '#00d09c', color2: '#38f0be', everyMs: 5 * 60_000, read: readCodex },
  { id: 'opencode-go', name: 'OpenCode Go', glyph: '▣', color: '#ff9f43', color2: '#ffc77d', everyMs: 5 * 60_000, read: readOpenCodeGo },
  // xAI's mark is monochrome, so it wears the theme's own ink.
  { id: 'xai', name: 'xAI', glyph: '✕', color: 'var(--fg)', color2: 'color-mix(in srgb, var(--fg) 72%, var(--dim))', everyMs: 5 * 60_000, read: readXai },
  { id: 'antigravity', name: 'Antigravity', glyph: '✦', color: '#3b8bff', color2: '#72b3ff', everyMs: 5 * 60_000, read: readAntigravity, peekCred: peekAntigravityCred, gateAliases: antigravityAliases, gateUntil, gateSet, gateList, tierGates: () => tierGates.filter((g) => g.until > Date.now()), restoreTierGates, links: antigravityLinks, restoreLinks: restoreAntigravityLinks, watchTierGates: (fn) => (tierGatesChanged = fn), onSignedOut: clearTierPlans, cachedPlan: (account) => (account ? (newestTier(account)?.plan || '') : '') },
  { id: 'cpu', name: 'CPU', glyph: '▦', color: '#36a9ff', color2: '#76ceff', everyMs: 0, local: true, read: readCpu },
  { id: 'ram', name: 'RAM', glyph: '▤', color: '#bc7eff', color2: '#dab2ff', everyMs: 0, local: true, read: readRam },
];

module.exports = { PROVIDERS, readClaudeLocal, setConsoleKey, setAntigravityCredReader, clearAntigravityAliases, clearAntigravityTierGates,shapeApiCredit, creditExpired, fmtReset, nextMonthly, shapeClaude, shapeCodex, shapeCodexUsage, shapeCodexRenewal, shapeOpenCodeGo, shapeXai, shapeAntigravity, shapeCodexResetCredits, windowLabel, ringPercent, resetRows, lastRateLimits, retryAfterSeconds };
