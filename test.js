'use strict';
// Pure-logic checks. No electron, no network: node test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shapeApiCredit, creditExpired, nextMonthly, shapeClaude, shapeCodexRenewal, shapeCodex, shapeCodexUsage, shapeCodexResetCredits, shapeOpenCodeGo, shapeXai, fmtReset, windowLabel, ringPercent, resetRows, lastRateLimits } = require('./providers');

const now = Date.UTC(2026, 7, 29, 12, 0, 0);

// --- Codex: the shape the CLI actually writes into its rollout files.
const rl = {
  limit_id: 'codex',
  primary: { used_percent: 1, window_minutes: 10080, resets_at: 1788643780 },
  secondary: { used_percent: 42.6, window_minutes: 300, resets_at: 1788049000 },
  plan_type: 'prolite',
};
const codex = shapeCodex(rl);
assert.strictEqual(codex.plan, 'Pro Lite');
assert.deepStrictEqual(
  codex.rows.map((r) => [r.label, r.percent]),
  [['Weekly', 1], ['5h limit', 42.6]]
);
assert.strictEqual(codex.rows[0].resetsAt, 1788643780000, 'epoch seconds become ms');
assert.ok(shapeCodex(null).error, 'no rate_limits is an error, not a zero reading');
assert.ok(shapeCodex({ plan_type: 'pro' }).error, 'a limits object with no windows is an error too');

const liveCodex = shapeCodexUsage({
  plan_type: 'prolite',
  rate_limit: {
    primary_window: { used_percent: 4, limit_window_seconds: 604800, reset_at: 1788643780 },
    secondary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1788049000 },
  },
});
assert.deepStrictEqual(
  liveCodex.rows.map((r) => [r.label, r.percent]),
  [['Weekly', 4], ['5h limit', 25]],
  'live Codex usage maps the same rows as rollout data'
);
assert.strictEqual(liveCodex.bankedResets, undefined, 'missing banked resets are not a zero balance');
for (const count of [0, 1, 5]) {
  assert.strictEqual(shapeCodexUsage({ rate_limit_reset_credits: { available_count: count, applicable_available_count: 0 } }).bankedResets, count);
}
for (const count of [null, -1, 1.5, '2', Infinity]) {
  assert.strictEqual(shapeCodexUsage({ rate_limit_reset_credits: { available_count: count } }).bankedResets, undefined);
}
assert.strictEqual(codex.bankedResets, undefined, 'offline rollout data must not invent banked resets');
assert.deepStrictEqual(shapeCodexResetCredits({ credits: [
  { status: 'available', expires_at: '2026-10-04T05:36:14Z' },
  { status: 'redeemed', expires_at: '2026-09-01T00:00:00Z' },
  { status: 'expired', expires_at: '2026-09-02T00:00:00Z' },
  { status: 'available', expires_at: 'bad date' },
  { status: 'available', expires_at: '2026-09-20T08:00:00Z' },
  { status: 'available', expires_at: null },
] }), [Date.parse('2026-09-20T08:00:00Z'), Date.parse('2026-10-04T05:36:14Z'), null, null]);
assert.strictEqual(shapeCodexResetCredits({}), undefined);

assert.strictEqual(windowLabel(60), '1h limit');
assert.strictEqual(windowLabel(10080), 'Weekly');
assert.strictEqual(windowLabel(1440), '1-day');

// --- OpenCode Go: the live shape from /zen/go/v1/usage; windows the API drops are dropped, not zeroed.
const go = shapeOpenCodeGo({ usage: {
  rolling: { status: 'ok', percent: 2, resetsAt: '2026-09-11T02:13:59.010Z' },
  weekly: { status: 'ok', percent: 130, resetsAt: '2026-09-14T00:00:00.010Z' },
  monthly: { status: 'ok', percent: 0, resetsAt: '2026-10-10T21:11:58.010Z' },
} });
assert.strictEqual(go.plan, 'Go');
assert.deepStrictEqual(go.rows.map((r) => [r.label, r.percent, r.resetsAt]), [
  ['5h limit', 2, '2026-09-11T02:13:59.010Z'], ['Weekly', 100, '2026-09-14T00:00:00.010Z'], ['Monthly', 0, '2026-10-10T21:11:58.010Z'],
]);
assert.deepStrictEqual(shapeOpenCodeGo({ usage: { weekly: { percent: 7 } } }).rows.map((r) => r.label), ['Weekly']);
assert.ok(shapeOpenCodeGo({ usage: {} }).error, 'no windows is an error, not a zero reading');
assert.ok(shapeOpenCodeGo({ type: 'error' }).error, 'an error body is an error');

// --- xAI: monthly credits from /billing, the weekly percentage from /billing?format=credits.
const xaiMonthly = { config: { monthlyLimit: { val: 20000 }, used: { val: 5000 }, billingPeriodEnd: '2026-11-01T00:00:00Z' } };
const xaiWeekly = { config: { creditUsagePercent: 42.5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-10-19T00:00:00Z' }, billingPeriodEnd: '2026-11-01T00:00:00Z' } };
assert.deepStrictEqual(shapeXai(xaiMonthly, xaiWeekly).rows.map((r) => [r.label, r.percent, r.resetsAt]), [
  ['Weekly', 42.5, '2026-10-19T00:00:00Z'], ['Monthly', 25, '2026-11-01T00:00:00Z'],
], 'the weekly window resets at its own period end, not the billing month');
assert.strictEqual(shapeXai({ config: { monthlyLimit: { val: '400' }, used: { val: '100' } } }, null).rows[0].percent, 25, 'credits sent as strings still count');
assert.strictEqual(shapeXai(xaiMonthly, { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } } }).rows[0].percent, 0, 'a fresh week leaves the percentage out');
assert.deepStrictEqual(shapeXai(xaiMonthly, { config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY' } } }).rows.map((r) => r.label), ['Monthly'], 'only a weekly period is the weekly line');
assert.ok(shapeXai({ config: { monthlyLimit: { val: 0 }, used: { val: 0 } } }, null).error, 'no allowance is an error, not a zero reading');
assert.ok(shapeXai({}, null).error, 'an answer of another shape is an error');

// --- Claude: percent clamped, unknown kinds fall back to a model display name.
const claude = shapeClaude(
  {
    limits: [
      { kind: 'session', percent: 6, resets_at: '2026-08-29T23:40:00Z' },
      { kind: 'weekly_all', percent: 130 },
      { kind: 'weekly_opus', percent: 14, scope: { model: { display_name: 'Fable' } } },
    ],
  },
  { organization: { rate_limit_tier: 'default_claude_max_5x' } }
);
assert.strictEqual(claude.plan, 'Max');
assert.deepStrictEqual(
  claude.rows.map((r) => [r.label, r.percent]),
  [['Session', 6], ['All models', 100], ['Fable', 14]]
);
assert.strictEqual(ringPercent(claude.rows, 'Session'), 6);
assert.strictEqual(ringPercent(claude.rows, 'All models'), 100);
assert.strictEqual(ringPercent(claude.rows, 'Fable'), 14);
assert.strictEqual(ringPercent(claude.rows, ''), 100, 'no selection keeps the highest-limit default');

// --- When the plans next bill.
const at = Date.parse;
assert.strictEqual(nextMonthly('2026-06-24T18:05:04.222Z', at('2026-11-15T03:00:00Z')), at('2026-11-24T18:05:04Z'), 'the same day and time this month');
assert.strictEqual(nextMonthly('2026-06-24T18:05:04Z', at('2026-11-24T18:05:04Z')), at('2026-12-24T18:05:04Z'), 'on the moment itself, the next month');
assert.strictEqual(nextMonthly('2026-01-31T10:00:00Z', at('2026-02-10T00:00:00Z')), at('2026-02-28T10:00:00Z'), 'a 31st bills on a shorter month\'s last day');
assert.strictEqual(nextMonthly('2026-01-31T10:00:00Z', at('2026-03-01T00:00:00Z')), at('2026-03-31T10:00:00Z'), 'and on the 31st again when the month has one');
assert.strictEqual(nextMonthly('2025-12-15T08:00:00Z', at('2026-12-20T00:00:00Z')), at('2027-01-15T08:00:00Z'), 'across a year');
assert.strictEqual(nextMonthly('not a date'), null);
const subscribed = (org) => shapeClaude({}, { organization: { billing_type: 'stripe_subscription', subscription_status: 'active', subscription_created_at: '2020-01-05T00:00:00Z', ...org } });
assert.ok(subscribed().renewsAt > Date.now() && subscribed().renewsGuess === true, 'Claude\'s next bill is worked out from the day it started');
assert.strictEqual(new Date(subscribed().renewsAt).getUTCDate(), 5);
assert.strictEqual(subscribed({ subscription_status: 'canceled' }).renewsAt, null, 'a cancelled plan bills no more');
assert.strictEqual(subscribed({ billing_type: 'apple_subscription' }).renewsAt, null, 'billed elsewhere, on a calendar we can\'t see');
assert.strictEqual(claude.renewsAt, null, 'a profile without the date has none');
assert.ok(!('renewsAt' in shapeClaude({}, null)), 'no profile says nothing, so main keeps the date on hand');
const check = { accounts: { acc: { entitlement: { renews_at: '2026-11-23T03:50:20+00:00' } }, default: { entitlement: { renews_at: '2026-12-01T00:00:00Z' } } } };
assert.strictEqual(shapeCodexRenewal(check, 'acc'), at('2026-11-23T03:50:20Z'), 'the signed-in account\'s plan');
assert.strictEqual(shapeCodexRenewal(check, 'other'), at('2026-12-01T00:00:00Z'), 'else the default account\'s');
assert.strictEqual(shapeCodexRenewal({ accounts: { acc: { entitlement: { renews_at: null } } } }, 'acc'), null, 'no renewal ahead');
assert.strictEqual(shapeCodexRenewal(null, 'acc'), null);
assert.deepStrictEqual(shapeClaude({}, null).rows, [], 'a limits-less response is empty, not a crash');
assert.strictEqual(shapeClaude({}, null).bankedResets, undefined, 'missing cedar_ember is not a zero balance');
assert.strictEqual(shapeClaude({ cedar_ember: { eligible: false, grants: [] } }, null).bankedResets, undefined, 'ineligible accounts show no banked row');
assert.strictEqual(shapeClaude({ cedar_ember: { eligible: true, grants: [] } }, null).bankedResets, 0);
const bankedClaude = shapeClaude({ cedar_ember: { eligible: true, grants: [
  { resets_left: 2, ends_at: '2026-10-22T16:00:00+00:00' },
  { resets_left: 0, ends_at: '2026-09-30T00:00:00Z' },
  { resets_left: 1, ends_at: null },
  { resets_left: 1.5, ends_at: '2026-10-01T00:00:00Z' },
  { resets_left: 1, ends_at: '2026-10-01T00:00:00Z' },
] } }, null);
assert.strictEqual(bankedClaude.bankedResets, 4);
assert.deepStrictEqual(bankedClaude.bankedResetExpiries, [Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-10-22T16:00:00Z'), Date.parse('2026-10-22T16:00:00Z'), null]);

// The plan's API credit: its own program's unexpired tranches only, whatever else the Console lists.
const tranche = (program, left, expires, currency = 'USD') => ({ program_id: program, currency, granted_amount_minor_units: 10000, remaining_amount_minor_units: left, expires_at: expires });
assert.deepStrictEqual(shapeApiCredit([{ promo_tranches: [
  tranche('subscription_api_credit', 9195, '2026-10-27T00:00:00Z'),
  tranche('subscription_api_credit', 4000, '2026-09-27T00:00:00Z'),
  tranche('startup_promo', 10000, '2026-12-31T00:00:00Z'),
  tranche('subscription_api_credit', 10000, '2026-12-31T00:00:00Z', 'EUR'),
] }, { type: 'error' }], Date.parse('2026-10-10T00:00:00Z')), { leftCents: 9195, grantedCents: 10000, expiresAt: Date.parse('2026-10-27T00:00:00Z') });
assert.strictEqual(shapeApiCredit([{ promo_tranches: [tranche('startup_promo', 500, null)] }]), undefined, 'no plan credit is no credit line');
const deadline = Date.parse('2026-10-27T00:00:00Z');
assert.deepStrictEqual([deadline - 1, deadline].map((at) => creditExpired({ leftCents: 1, expiresAt: deadline }, at)), [false, true], 'a balance lapses at its deadline, as the Console counts');
assert.deepStrictEqual([creditExpired({ leftCents: 1, expiresAt: null }, Infinity), creditExpired(undefined)], [false, false], 'nothing without a deadline lapses');

// A reset is observed from provider data, not inferred from its estimated reset time.
assert.deepStrictEqual(
  resetRows(
    [{ label: 'Session', percent: 82 }, { label: 'Weekly', percent: 10 }],
    [{ label: 'Session', percent: 3 }, { label: 'Weekly', percent: 11 }, { label: 'New', percent: 0 }]
  ).map((r) => r.label),
  ['Session']
);
// Under a point is rounding between two reports of one pool, xAI's whole 17 against Cursor's 17.75; a point is a reset.
assert.deepStrictEqual(resetRows([{ label: 'Weekly', percent: 17.75 }, { label: 'Session', percent: 1 }], [{ label: 'Weekly', percent: 17 }, { label: 'Session', percent: 0 }]).map((r) => r.label), ['Session']);

// --- Reset text, from both time formats.
assert.strictEqual(fmtReset(null, now), '');
assert.strictEqual(fmtReset(now - 1000, now), 'now');
assert.strictEqual(fmtReset(now + 45 * 60_000, now), 'in 45m');
assert.strictEqual(fmtReset(now + 130 * 60_000, now), 'in 2h 10m');
assert.strictEqual(fmtReset(now + 180 * 60_000, now), 'in 3h', 'no "0m"');
assert.strictEqual(fmtReset(now + (2 * 1440 + 4 * 60 + 20) * 60_000, now), 'in 2d 4h', 'days drop the minutes');
assert.strictEqual(fmtReset(now + 7 * 1440 * 60_000 - 1000, now), 'in 7d', 'a second short of a week is a week');
assert.strictEqual(fmtReset('not a date', now), '');

// --- Tail reader: last rate_limits wins, junk lines and a truncated head are skipped.
const tmp = path.join(os.tmpdir(), 'usage-overlay-test.jsonl');
fs.writeFileSync(
  tmp,
  '{"broken":"line",\n' +
    JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 5, window_minutes: 300 } } } }) + '\n' +
    '{"type":"message","text":"mentions rate_limits but has none"}\n' +
    JSON.stringify({ timestamp: '2026-09-29T01:00:00Z', payload: { rate_limits: { primary: { used_percent: 9, window_minutes: 300 } } } }) + '\n'
);
assert.strictEqual(lastRateLimits(tmp).rl.primary.used_percent, 9);
assert.strictEqual(lastRateLimits(tmp).at, Date.parse('2026-09-29T01:00:00Z'), 'a reading is as fresh as its event, not its file');
// A read that fails after the open still closes the file.
const { readSync, closeSync } = fs;
let closed = 0;
fs.readSync = () => { throw new Error('EIO'); };
fs.closeSync = (fd) => { closed++; closeSync(fd); };
assert.strictEqual(lastRateLimits(tmp), null);
Object.assign(fs, { readSync, closeSync });
assert.strictEqual(closed, 1, 'no leaked handle');
fs.unlinkSync(tmp);
assert.strictEqual(lastRateLimits(path.join(os.tmpdir(), 'nope.jsonl')), null);

// Codex and Orca select isolated session trees through CODEX_HOME.
const codexHome = path.join(os.tmpdir(), 'usage-overlay-codex-home');
const rolloutDir = path.join(codexHome, 'sessions', '2026', '08', '30');
fs.mkdirSync(rolloutDir, { recursive: true });
fs.writeFileSync(
  path.join(rolloutDir, 'rollout-test.jsonl'),
  JSON.stringify({ timestamp: '2026-08-30T01:00:00Z', payload: { rate_limits: { primary: { used_percent: 77, window_minutes: 10080 } } } }) + '\n'
);
// A session started since then, with no usage event yet: newer, but it must not hide the reading above.
const freshSession = path.join(rolloutDir, 'rollout-new.jsonl');
fs.writeFileSync(freshSession, JSON.stringify({ timestamp: '2026-08-30T09:00:00Z', type: 'session_meta', payload: {} }) + '\n');
fs.utimesSync(freshSession, new Date(), new Date(Date.now() + 60_000));
// Orca's root, with a file changed more recently than the one above but holding an older usage event.
// Event time picks the reading, across roots, whatever the file times say.
const orcaDir = path.join(codexHome, 'orca', 'sessions', '2026', '08', '30');
fs.mkdirSync(orcaDir, { recursive: true });
const orcaFile = path.join(orcaDir, 'rollout-orca.jsonl');
fs.writeFileSync(orcaFile, JSON.stringify({ timestamp: '2026-08-30T00:30:00Z', payload: { rate_limits: { primary: { used_percent: 20, window_minutes: 10080 } } } }) + '\n');
fs.utimesSync(orcaFile, new Date(), new Date(Date.now() + 30_000));

// providers.js reads its paths once, at require. Orca's root and APPDATA (Cursor's sign-in) are set too, or the
// test reads the real ones.
function loadCodex(home, orca) {
  const saved = { CODEX_HOME: process.env.CODEX_HOME, ORCA_CODEX_HOME: process.env.ORCA_CODEX_HOME, APPDATA: process.env.APPDATA };
  const homedir = os.homedir;
  Object.assign(process.env, { CODEX_HOME: home, ORCA_CODEX_HOME: orca, APPDATA: path.join(home, 'AppData') });
  os.homedir = () => home;
  delete require.cache[require.resolve('./providers')];
  const codex = require('./providers').PROVIDERS.find((p) => p.id === 'codex');
  os.homedir = homedir;
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  return codex;
}
const configuredProvider = loadCodex(codexHome, path.join(codexHome, 'orca'));
configuredProvider.read()
  .then((configured) => {
    assert.strictEqual(configured.rows[0].percent, 77, 'the newest usage event wins, past a newer session with none and a newer file with an older one');
    assert.strictEqual(configured.updatedAt, Date.parse('2026-08-30T01:00:00Z'), 'fallback freshness comes from the event');
    assert.strictEqual(configured.why, 'Live refresh unavailable.', 'a fallback says why live usage did not come');
  })
  .then(async () => {
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'wrong-home-token' } }));
    fs.mkdirSync(path.join(codexHome, '.codex'));
    fs.writeFileSync(path.join(codexHome, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-token' } }));
    const originalFetch = global.fetch;
    let detailCalls = 0;
    let renewCalls = 0;
    let renewsAt = null;
    let renewFails = false;
    let mode = 'ok';
    global.fetch = async (url, options) => {
      assert.strictEqual(options.headers.Authorization, 'Bearer test-token', 'Codex login comes only from ~/.codex, ignoring CODEX_HOME and Orca');
      if (url.includes('/accounts/check')) return (renewCalls++, renewFails ? { ok: false, status: 503, headers: new Headers() } : { ok: true, json: async () => ({ accounts: { default: { entitlement: { renews_at: renewsAt } } } }) });
      if (url.endsWith('/usage')) return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } }, rate_limit_reset_credits: { available_count: mode === 'first' ? 0 : 1 } }) };
      detailCalls++;
      if (mode === 'error') throw new Error('Offline');
      if (mode === 'throttled') return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
      const granted = mode === 'granted' ? [{ status: 'available', expires_at: '2026-10-12T18:15:00Z' }] : [];
      return { ok: true, json: async () => ({ credits: [{ status: 'available', expires_at: '2026-10-04T05:36:14Z' }, ...granted] }) };
    };
    try {
      assert.deepStrictEqual((await configuredProvider.read()).bankedResetExpiries, [Date.parse('2026-10-04T05:36:14Z')]);
      mode = 'granted';
      const granted = await configuredProvider.read();
      assert.deepStrictEqual([granted.bankedResets, granted.bankedResetExpiries], [2, [Date.parse('2026-10-04T05:36:14Z'), Date.parse('2026-10-12T18:15:00Z')]], 'a list newer than the usage count counts its own resets');
      mode = 'first';
      assert.strictEqual((await configuredProvider.read()).bankedResets, 1, 'a first reset shows while /usage still says 0');
      mode = 'error';
      const unavailable = await configuredProvider.read();
      assert.strictEqual(unavailable.bankedResets, 1, 'expiry failure preserves banked count');
      assert.strictEqual(unavailable.rows[0].percent, 10, 'expiry failure preserves live usage');
      assert.strictEqual(unavailable.bankedResetExpiries, undefined);
      mode = 'throttled';
      await configuredProvider.read();
      const callsBefore = detailCalls;
      await configuredProvider.read();
      assert.strictEqual(detailCalls, callsBefore, 'expiry lookup respects Retry-After');
      // The next bill: asked again after 6 hours, and once as its date comes, but not at every read after it while
      // ChatGPT still gives the date that has passed.
      const realNow = Date.now;
      let shift = 7 * 3600_000;
      Date.now = () => realNow() + shift;
      try {
        mode = 'ok';
        renewsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
        renewCalls = 0;
        assert.strictEqual((await configuredProvider.read()).renewsAt, Date.parse(renewsAt), 'the plan\'s renews_at');
        await configuredProvider.read();
        assert.strictEqual(renewCalls, 1, 'not asked again before 6 hours');
        shift += 3 * 3600_000;
        assert.strictEqual((await configuredProvider.read()).renewsAt, null, 'a date gone by is none ahead');
        await configuredProvider.read();
        await configuredProvider.read();
        assert.strictEqual(renewCalls, 2, 'asked once as the date came, then not at every read');
        shift += 6 * 3600_000;
        renewsAt = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
        assert.strictEqual((await configuredProvider.read()).renewsAt, Date.parse(renewsAt), 'the next date, 6 hours on');
        assert.strictEqual(renewCalls, 3);
        // Signed in to another account: its own date, asked for at once. Its lookup failing says nothing, so main
        // can't keep the first account's date for it.
        const before = (await configuredProvider.read()).renewsFor;
        fs.writeFileSync(path.join(codexHome, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-token', account_id: 'other' } }));
        renewFails = true;
        const switched = await configuredProvider.read();
        assert.strictEqual(renewCalls, 4, 'another account is asked for at once');
        assert.ok(!('renewsAt' in switched) && switched.renewsFor && switched.renewsFor !== before, 'a failed lookup for a new account carries no date, and says whose');
        assert.ok(!/other|test-token/.test(switched.renewsFor), 'the account goes out hashed');
      } finally {
        Date.now = realNow;
      }
    } finally {
      global.fetch = originalFetch;
    }
  })
  .then(async () => {
    fs.mkdirSync(path.join(codexHome, '.claude'));
    fs.writeFileSync(path.join(codexHome, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }));
    fs.mkdirSync(path.join(codexHome, '.grok'));
    fs.writeFileSync(path.join(codexHome, '.grok', 'auth.json'), JSON.stringify({ 'https://auth.x.ai::client': { key: 'test-token' } }));
    const originalFetch = global.fetch;
    const originalKey = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'test-key';
    const networkError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    // The 15 s request deadline runs in 15 ms here, or each lost request below would take half a minute.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 15_000 ? ms / 1000 : ms, ...args);
    // A read that never settles fails the run instead of hanging it.
    const settles = (read, what) => {
      let timer;
      const late = new Promise((_, reject) => (timer = realSetTimeout(() => reject(new Error(`${what}: the read never settled`)), 2000)));
      return Promise.race([read, late]).finally(() => clearTimeout(timer));
    };
    try {
      for (const provider of require('./providers').PROVIDERS.filter((p) => !p.local)) {
        let calls = 0;
        let mode = 'recover';
        global.fetch = async (url, options) => {
          assert.ok(options.signal instanceof AbortSignal, 'every provider request has a deadline');
          if (url.endsWith('/profile') || url.endsWith('format=credits')) return { ok: true, json: async () => ({}) };
          calls++;
          if (mode === 'offline' || (mode === 'recover' && calls === 1)) throw networkError();
          if (mode === 'timeout') return { ok: true, json: async () => { throw new DOMException('deadline', 'TimeoutError'); } };
          if (mode === 'truncated') return { ok: true, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
          // What held Claude's read for 12 hours on 2026-10-29: a request that never answers, deaf to its signal.
          if (mode === 'lost') return new Promise(() => {});
          if (/^\d+$/.test(mode)) return { ok: false, status: Number(mode), headers: new Headers({ 'retry-after': '120' }) };
          return { ok: true, json: async () => ({
            limits: [{ kind: 'session', percent: 12 }],
            rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } },
            usage: { rolling: { percent: 12 } },
            config: { monthlyLimit: { val: 100 }, used: { val: 12 } },
          }) };
        };
        const recovered = await provider.read();
        assert.strictEqual(recovered.rows?.[0]?.percent, 12, `${provider.id} recovers from a transient fetch failure`);
        assert.strictEqual(calls, 2, 'one retry after a transport failure');
        for (mode of ['offline', 'timeout', 'lost', 'truncated', '429', '401', '503', '408']) {
          calls = 0;
          const result = await settles(provider.read(), `${provider.id} ${mode}`);
          assert.strictEqual(calls, ['offline', 'timeout', 'lost', 'truncated'].includes(mode) ? 2 : 1, 'bounded retry, never retry HTTP errors');
          if (mode === '429') {
            assert.strictEqual(result.retryAfter, 120);
            assert.strictEqual(result.soft, true);
          } else if (provider.id !== 'codex') {
            if (mode === '401') assert.ok(!result.soft, 'invalid credentials remain a hard error');
            else {
              assert.strictEqual(result.soft, true, `${provider.id} ${mode}: network and server failures preserve the last reading`);
              assert.match(result.error, mode === 'offline' ? /UND_ERR_CONNECT_TIMEOUT/ : /^\d+$/.test(mode) ? new RegExp(`HTTP ${mode}`) : mode === 'truncated' ? /JSON/ : /timed out/);
            }
          } else assert.deepStrictEqual([typeof result.why, result.note], ['string', undefined], 'Codex retains its offline fallback, without a note');
        }
      }
    } finally {
      global.fetch = originalFetch;
      global.setTimeout = realSetTimeout;
      if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = originalKey;
    }
  })
  .then(async () => {
    // xAI: the token `grok` keeps reaches the request, the weekly line can fail on its own, and no sign-in
    // says how to get one without asking anything.
    const xai = require('./providers').PROVIDERS.find((p) => p.id === 'xai');
    const grokAuth = path.join(codexHome, '.grok', 'auth.json');
    const originalFetch = global.fetch;
    const sent = [];
    let weeklyDown = false;
    global.fetch = async (url, options) => {
      sent.push(options.headers.Authorization);
      if (!url.endsWith('format=credits')) return { ok: true, json: async () => xaiMonthly };
      if (weeklyDown) return { ok: false, status: 500, headers: new Headers() };
      return { ok: true, json: async () => xaiWeekly };
    };
    try {
      assert.deepStrictEqual((await xai.read()).rows.map((r) => r.label), ['Weekly', 'Monthly']);
      assert.deepStrictEqual(sent, ['Bearer test-token', 'Bearer test-token'], 'both lookups carry the token grok keeps');
      weeklyDown = true;
      const weeklyLost = await xai.read();
      assert.ok(weeklyLost.soft && !weeklyLost.rows, 'a failed lookup whose line was on screen fails the read, so main keeps every old number');
      // And the other way round; a 429 still gates.
      const week96 = { config: { ...xaiWeekly.config, creditUsagePercent: 96 } };
      global.fetch = async (url) => (url.endsWith('format=credits') ? { ok: true, json: async () => week96 } : { ok: false, status: 503, headers: new Headers() });
      assert.ok((await xai.read()).soft, 'so does a failed monthly lookup whose line was on screen');
      global.fetch = async (url) => (url.endsWith('format=credits') ? { ok: true, json: async () => week96 } : { ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) });
      assert.strictEqual((await xai.read()).retryAfter, 90, 'a throttled monthly lookup gates xAI');
      global.fetch = async (url) => ({ ok: false, status: 429, headers: new Headers(url.endsWith('format=credits') ? {} : { 'retry-after': '30' }) });
      assert.strictEqual((await xai.read()).retryAfter, 60, 'a 429 with no Retry-After counts as its 60s fallback against the other');
      // The unified weekly pool: no monthly limit, which is no outage, so the weekly lookup failing is the read failing.
      const pooled = { config: { monthlyLimit: { val: 0 }, used: { val: 0 }, billingPeriodEnd: '2026-11-01T00:00:00Z' } };
      global.fetch = async (url) => ({ ok: true, json: async () => (url.endsWith('format=credits') ? xaiWeekly : pooled) });
      const pool = await xai.read();
      assert.deepStrictEqual([pool.rows.map((r) => r.label), pool.note], [['Weekly'], undefined], 'a zero monthly limit is no outage');
      global.fetch = async (url) => (url.endsWith('format=credits') ? { ok: true, json: async () => week96 } : { ok: false, status: 503, headers: new Headers() });
      assert.deepStrictEqual((await xai.read()).rows?.map((r) => [r.label, r.percent]), [['Weekly', 96]], 'the unified monthly lookup has no line, so its failure lets the weekly line land');
      const expired = 'Grok sign-in expired — run `grok` to renew it.';
      global.fetch = async (url) => ({ ok: false, status: url.endsWith('format=credits') ? 401 : 503, headers: new Headers() });
      assert.strictEqual((await xai.read()).error, expired, 'a refused sign-in wins over a server error');
      global.fetch = async (url) => (url.endsWith('format=credits') ? { ok: false, status: 401, headers: new Headers() } : { ok: true, json: async () => xaiMonthly });
      assert.strictEqual((await xai.read()).error, expired, 'and over a lookup that answered');
      global.fetch = async (url) => ({ ok: true, json: async () => (url.endsWith('format=credits') ? {} : pooled) });
      assert.strictEqual((await xai.read()).error, 'No usage windows reported.', 'both answering with no window is that error, not a crash');
      global.fetch = async (url) => (url.endsWith('format=credits') ? { ok: false, status: 503, headers: new Headers() } : { ok: true, json: async () => pooled });
      const outage = await xai.read();
      assert.ok(outage.soft && !outage.rows, 'an outage keeps the last reading on screen');
      assert.strictEqual(outage.error, 'xAI usage not refreshed (HTTP 503).', 'and says why it did not move');
      global.fetch = async (url) => (url.endsWith('format=credits') ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) } : { ok: true, json: async () => pooled });
      assert.strictEqual((await xai.read()).retryAfter, 90, 'a throttled weekly lookup gates xAI like any 429');
      // Cursor reports the same pool to an account merged with xAI, signed in as the Cursor CLI, and is asked first.
      const cursorAuth = path.join(codexHome, 'AppData', 'Cursor', 'auth.json');
      fs.mkdirSync(path.dirname(cursorAuth), { recursive: true });
      fs.writeFileSync(cursorAuth, JSON.stringify({ accessToken: 'cursor-token', refreshToken: 'cursor-refresh' }));
      let merged = true;
      let cursorStatus = 200;
      const cursorAsked = [];
      const xaiAsked = [];
      global.fetch = async (url, options) => {
        if (url.startsWith('https://api2.cursor.sh/')) {
          cursorAsked.push([url.split('/').pop(), options.method, options.headers.Authorization, options.body]);
          if (cursorStatus !== 200) return { ok: false, status: cursorStatus, headers: new Headers() };
          return { ok: true, json: async () => (url.endsWith('/GetPlanInfo')
            ? { planInfo: { includedUsagePeriod: 'INCLUDED_USAGE_PERIOD_WEEKLY', includedUsageResetsAt: '1792450993754' }, ...(merged ? { isMerged: true } : {}) }
            : { planUsage: { totalPercentUsed: 17.746478873239436 } }) };
        }
        xaiAsked.push(url);
        return url.endsWith('format=credits') ? { ok: false, status: 500, headers: new Headers() } : { ok: true, json: async () => pooled };
      };
      const viaCursor = await xai.read();
      assert.deepStrictEqual([viaCursor.rows.map((r) => [r.label, r.percent, r.resetsAt]), viaCursor.note, viaCursor.error], [[['Weekly', 17.746478873239436, '2026-10-19T23:03:13.754Z']], undefined, undefined], "Cursor's weekly pool is xAI's reading");
      assert.deepStrictEqual(cursorAsked.sort(), [['GetCurrentPeriodUsage', 'POST', 'Bearer cursor-token', '{}'], ['GetPlanInfo', 'POST', 'Bearer cursor-token', '{}']]);
      assert.strictEqual(xaiAsked.length, 0, 'and xAI is not asked');
      merged = false;
      assert.strictEqual((await xai.read()).error, 'xAI usage not refreshed (HTTP 500).', "an unmerged Cursor plan is its own, so xAI's endpoints answer");
      [merged, cursorStatus] = [true, 401];
      assert.strictEqual((await xai.read()).error, 'xAI usage not refreshed (HTTP 500).', "and so do they when Cursor refuses its sign-in");
      fs.rmSync(cursorAuth);
      // An expired token is renewed with the refresh token and written back for `grok`, keeping the entry's other fields.
      const lapsed = { key: 'old-token', refresh_token: 'r1', expires_at: '2026-01-01T00:00:00Z', oidc_client_id: 'cid', email: 'me@x' };
      fs.writeFileSync(grokAuth, JSON.stringify({ 'https://auth.x.ai::cid': lapsed }));
      const renewals = [];
      let refuse = false;
      global.fetch = async (url, options) => {
        if (url === 'https://auth.x.ai/oauth2/token') {
          renewals.push(Object.fromEntries(options.body));
          return refuse ? { ok: false, status: 400, headers: new Headers() } : { ok: true, json: async () => ({ access_token: 'new-token', refresh_token: 'r2', expires_in: 21600 }) };
        }
        sent.push(options.headers.Authorization);
        return { ok: true, json: async () => (url.endsWith('format=credits') ? xaiWeekly : pooled) };
      };
      sent.length = 0;
      assert.ok((await xai.read()).rows, 'a renewed token reads');
      assert.deepStrictEqual(renewals, [{ grant_type: 'refresh_token', client_id: 'cid', refresh_token: 'r1' }]);
      assert.deepStrictEqual(sent, ['Bearer new-token', 'Bearer new-token'], 'both lookups carry the renewed token');
      const saved = JSON.parse(fs.readFileSync(grokAuth, 'utf8'))['https://auth.x.ai::cid'];
      assert.deepStrictEqual([saved.key, saved.refresh_token, saved.email], ['new-token', 'r2', 'me@x'], 'grok gets the new tokens');
      assert.ok(Date.parse(saved.expires_at) > Date.now() + 5 * 3600_000, 'with the new expiry');
      await xai.read();
      assert.strictEqual(renewals.length, 1, 'a live token is not renewed again');
      fs.writeFileSync(grokAuth, JSON.stringify({ 'https://auth.x.ai::cid': lapsed }));
      refuse = true;
      assert.match((await xai.read()).error, /sign-in expired/, 'a refused refresh token asks for `grok`');
      assert.strictEqual(JSON.parse(fs.readFileSync(grokAuth, 'utf8'))['https://auth.x.ai::cid'].key, 'old-token', 'and leaves the file alone');
      global.fetch = async (url, options) => {
        sent.push(options.headers.Authorization);
        return { ok: true, json: async () => (url.endsWith('format=credits') ? xaiWeekly : xaiMonthly) };
      };
      fs.writeFileSync(grokAuth, JSON.stringify({ 'https://accounts.x.ai/sign-in': { access_token: 'legacy-token' } }));
      sent.length = 0;
      await xai.read();
      assert.strictEqual(sent[0], 'Bearer legacy-token', 'an older auth.json still signs in');
      for (const body of [JSON.stringify({ 'https://auth.x.ai::client': {} }), 'null', null]) {
        if (body === null) fs.rmSync(grokAuth);
        else fs.writeFileSync(grokAuth, body);
        sent.length = 0;
        assert.match((await xai.read()).error, /run `grok` to sign in/, 'no sign-in says how to get one');
        assert.strictEqual(sent.length, 0, 'and asks nothing');
      }
    } finally {
      global.fetch = originalFetch;
    }
  })
  .then(async () => {
    // No session files at all, as in an empty or unreadable tree, is soft too, so a reading on screen survives it.
    const empty = path.join(codexHome, 'empty');
    fs.mkdirSync(empty);
    const none = await loadCodex(empty, empty).read();
    assert.ok(none.error && none.soft, 'no sessions keeps the last reading');

    // An event stamped after its file's last write (a clock change, file times restored on their own)
    // still counts: file time orders the search but doesn't end it.
    const skew = path.join(codexHome, 'skew');
    const skewDir = path.join(skew, 'sessions', '2026', '10', '01');
    fs.mkdirSync(skewDir, { recursive: true });
    const rollout = (name, percent, at, mtime) => {
      const file = path.join(skewDir, name);
      fs.writeFileSync(file, JSON.stringify({ timestamp: at, payload: { rate_limits: { primary: { used_percent: percent, window_minutes: 300 } } } }) + '\n');
      fs.utimesSync(file, new Date(mtime), new Date(mtime));
    };
    rollout('a.jsonl', 20, '2026-10-01T01:00:00Z', '2026-10-01T01:10:00Z');
    rollout('b.jsonl', 80, '2026-10-01T01:05:00Z', '2026-10-01T00:55:00Z');
    const skewed = await loadCodex(skew, skew).read();
    assert.strictEqual(skewed.rows[0].percent, 80, 'the newest event wins even when its file looks older');
  })
  .then(async () => {
    // Claude's local numbers: Claude Code's copy of /usage in ~/.claude.json, for the account signed in and under an
    // hour old, shaped as the endpoint's answer is. No request, ever.
    const config = path.join(codexHome, '.claude.json');
    const now = Date.now();
    const writeCopy = (percent, ageMs, account = 'acct') => fs.writeFileSync(config, JSON.stringify({
      oauthAccount: { accountUuid: 'acct' },
      cachedUsageUtilization: { fetchedAtMs: now - ageMs, accountUuid: account, utilization: { limits: [{ kind: 'session', percent, resets_at: 'r1' }, { kind: 'weekly_all', percent: 4, resets_at: 'r2' }, { kind: 'weekly_scoped', percent: 1, resets_at: 'r2', scope: { model: { display_name: 'Fable' } } }] } },
    }));
    loadCodex(codexHome, codexHome);
    const { readClaudeLocal } = require('./providers');
    const originalFetch = global.fetch;
    global.fetch = async () => assert.fail('local numbers make no request');
    try {
      writeCopy(12, 2 * 60_000);
      const r = readClaudeLocal(now);
      assert.deepStrictEqual(r.rows.map((x) => [x.label, x.percent, x.resetsAt]), [['Session', 12, 'r1'], ['All models', 4, 'r2'], ['Fable', 1, 'r2']], "Claude Code's copy, in the endpoint's labels");
      assert.strictEqual(r.updatedAt, now - 2 * 60_000, 'dated by when Claude Code fetched it');
      writeCopy(12, 2 * 60_000, 'someone-else');
      assert.strictEqual(readClaudeLocal(now), null, "another account's copy is no copy");
      writeCopy(12, 61 * 60_000);
      assert.strictEqual(readClaudeLocal(now), null, 'an hour old is too old');
      writeCopy(12, -60_000);
      assert.strictEqual(readClaudeLocal(now), null, 'one from the future is no reading');
      fs.writeFileSync(config, '{"cachedUsageUtilization": {"fetch');
      assert.strictEqual(readClaudeLocal(now), null, 'nor one Claude Code is halfway through writing');
      fs.rmSync(config);
      assert.strictEqual(readClaudeLocal(now), null, 'nor a missing file');
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(config, { force: true });
    }
  })
  .then(async () => {
    // The API credit rides on Claude's read: asked with the pasted session, kept through a blip, and a
    // dead session says so without costing the usage numbers.
    loadCodex(codexHome, codexHome);
    const { PROVIDERS, setConsoleKey } = require('./providers');
    const claude = PROVIDERS.find((p) => p.id === 'claude');
    const originalFetch = global.fetch;
    let mode = 'ok';
    global.fetch = async (url, options) => {
      if (!url.startsWith('https://platform.claude.com/')) return { ok: true, json: async () => ({ limits: [{ kind: 'session', percent: 12 }] }) };
      assert.strictEqual(options.headers.Cookie, 'sessionKey=sk-ant-sid01-test');
      if (mode === 'offline') throw new TypeError('fetch failed');
      if (mode === 'expired') return { ok: false, status: 403, headers: new Headers() };
      if (url.endsWith('/organizations')) return { ok: true, json: async () => [{ uuid: 'chat-org', capabilities: ['chat'] }, { uuid: 'api-org', capabilities: ['api'] }] };
      assert.strictEqual(url, 'https://platform.claude.com/api/organizations/api-org/prepaid/credits', 'only API organizations are asked');
      return { ok: true, json: async () => ({ promo_tranches: [tranche('subscription_api_credit', 9195, '2099-10-27T00:00:00Z')] }) };
    };
    try {
      assert.strictEqual((await claude.read()).apiCredit, undefined, 'no session key, no Console request and no line');
      setConsoleKey('sk-ant-sid01-test');
      assert.deepStrictEqual((await claude.read()).apiCredit, { leftCents: 9195, grantedCents: 10000, expiresAt: Date.parse('2099-10-27T00:00:00Z') });
      mode = 'offline';
      assert.strictEqual((await claude.read()).apiCredit.leftCents, 9195, 'a network blip keeps the last credit');
      mode = 'expired';
      const expired = await claude.read();
      assert.match(expired.apiCredit.error, /session expired/);
      assert.strictEqual(expired.rows[0].percent, 12, 'a dead Console session leaves the usage numbers alone');

      // A session replaced or forgotten mid-read publishes nothing and leaves nothing behind: the next
      // session asks for its own organizations. Each cookie opens only its own, as the Console's would.
      let releaseOrgs = null;
      let releaseUsage = null;
      global.fetch = async (url, options) => {
        if (!url.startsWith('https://platform.claude.com/')) {
          if (releaseUsage === false) await new Promise((r) => (releaseUsage = r));
          return { ok: true, json: async () => ({ limits: [{ kind: 'session', percent: 12 }] }) };
        }
        const who = options.headers.Cookie.slice(-1);
        if (url.endsWith('/organizations')) {
          if (who === 'a' && releaseOrgs === false) await new Promise((r) => (releaseOrgs = r));
          return { ok: true, json: async () => [{ uuid: 'org-' + who, capabilities: ['api'] }] };
        }
        if (!url.includes('/org-' + who + '/')) return { ok: false, status: 403, headers: new Headers() };
        return { ok: true, json: async () => ({ promo_tranches: [tranche('subscription_api_credit', who === 'a' ? 1111 : 2222, '2099-10-27T00:00:00Z')] }) };
      };
      const until = async (ready) => {
        for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
        assert.ok(ready(), 'the held request arrived');
      };
      setConsoleKey('sk-ant-sid01-a');
      releaseOrgs = false;
      const replaced = claude.read();
      await until(() => releaseOrgs);
      setConsoleKey('sk-ant-sid01-b');
      releaseOrgs();
      assert.strictEqual((await replaced).apiCredit, undefined, 'a replaced session publishes nothing');
      assert.strictEqual((await claude.read()).apiCredit?.leftCents, 2222, 'the new session reads its own organizations');
      setConsoleKey('sk-ant-sid01-a');
      releaseUsage = false;
      const forgotten = claude.read();
      await until(() => releaseUsage);
      await new Promise((r) => setTimeout(r, 20)); // the Console answers at once: its balance is in
      setConsoleKey('');
      releaseUsage();
      assert.strictEqual((await forgotten).apiCredit, undefined, 'a session forgotten before usage answers publishes nothing');

      // A failed refresh says so and keeps the balance it last read, but never past that balance's expiry.
      setConsoleKey('sk-ant-sid01-c');
      let status = 200;
      global.fetch = async (url) => {
        if (!url.startsWith('https://platform.claude.com/')) return { ok: true, json: async () => ({ limits: [{ kind: 'session', percent: 12 }] }) };
        if (status !== 200) return { ok: false, status, headers: new Headers() };
        if (url.endsWith('/organizations')) return { ok: true, json: async () => [{ uuid: 'org-c', capabilities: ['api'] }] };
        return { ok: true, json: async () => ({ promo_tranches: [tranche('subscription_api_credit', 9195, '2026-10-27T00:00:00Z')] }) };
      };
      const realNow = Date.now;
      try {
        Date.now = () => Date.parse('2026-10-10T12:00:00Z');
        assert.strictEqual((await claude.read()).apiCredit.leftCents, 9195);
        status = 503;
        const failed = (await claude.read()).apiCredit;
        assert.deepStrictEqual([failed.leftCents, failed.error], [9195, undefined], 'a failed refresh keeps the balance, with no message');
        Date.now = () => Date.parse('2026-10-28T12:00:00Z');
        const lapsed = await claude.read();
        assert.ok(creditExpired(lapsed.apiCredit), 'expired funds are not shown as available: the panels say they expired');
        assert.strictEqual(lapsed.rows[0].percent, 12, 'while usage keeps refreshing');
        Date.now = () => Date.parse('2026-10-10T12:00:00Z');
        const savedCredit = { leftCents: 9195, grantedCents: 10000, expiresAt: Date.parse('2026-10-27T00:00:00Z') };
        setConsoleKey('sk-ant-sid01-c', savedCredit);
        assert.deepStrictEqual((await claude.read()).apiCredit, savedCredit, 'a restart keeps the saved balance through a failed first refresh');
      } finally {
        Date.now = realNow;
      }
    } finally {
      global.fetch = originalFetch;
    }
  })
  .then(async () => {
    // Whose a Claude reading is, and so its plan and next bill, is what /profile says, asked with the token signed in
    // now. Claude Code replaces its token and ~/.claude.json, its record of who signed in, separately, so a new token
    // under a record that still names the last account, or none, is that new token's alone: no plan or bill until its
    // own profile comes. Each new token, rotated in place or not, asks once. Synthetic sign-ins only.
    loadCodex(codexHome, codexHome);
    const claude = require('./providers').PROVIDERS.find((p) => p.id === 'claude');
    const config = path.join(codexHome, '.claude.json');
    const creds = path.join(codexHome, '.claude', '.credentials.json');
    const credsWas = fs.readFileSync(creds);
    const useToken = (token) => fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
    const signIn = (account, token, organization) => {
      fs.writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: account, ...(organization ? { organizationUuid: organization } : {}) } }));
      useToken(token);
    };
    // token -> [account, organization, tier, subscription start], as /profile answers for it
    const who = { a: ['acct-a', undefined, 'default_claude_max_5x', '2026-01-05T10:00:00Z'], b: ['acct-b', undefined, 'default_claude_pro', '2026-03-20T08:00:00Z'], bt: ['acct-b', 'org-team', 'default_claude_max_20x', '2026-02-01T09:00:00Z'] };
    who.a2 = who.a; // A's token, rotated
    const asked = [];
    let fails = false;
    let usageFails = false;
    let hold = null; // a profile request held until let go
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      const token = options.headers.Authorization.slice('Bearer token-'.length);
      if (!url.endsWith('/profile')) return usageFails ? { ok: false, status: 503, headers: new Headers() } : { ok: true, json: async () => ({ limits: [{ kind: 'session', percent: token[0] === 'b' ? 70 : 10 }] }) };
      asked.push(token);
      if (hold) await new Promise((r) => (hold = r));
      if (fails) return { ok: false, status: 503, headers: new Headers() };
      const [account, organization, tier, since] = who[token];
      return { ok: true, json: async () => ({ account: { uuid: account }, organization: { ...(organization ? { uuid: organization } : {}), rate_limit_tier: tier, billing_type: 'stripe_subscription', subscription_status: 'active', subscription_created_at: since } }) };
    };
    const plan = (r) => [r.plan, r.renewsAt, r.rows[0].percent];
    const hashed = (r) => /^[0-9a-f]{12}$/.test(r.renewsFor);
    try {
      signIn('acct-a', 'token-a');
      const a = await claude.read();
      assert.deepStrictEqual(plan(a), ['Max', nextMonthly(who.a[3]), 10], "account A's plan and next bill");
      useToken('token-a2');
      const rotated = await claude.read();
      assert.deepStrictEqual([plan(rotated), rotated.renewsFor, asked], [plan(a), a.renewsFor, ['a', 'a2']], 'a token rotated in place asks for its profile once, which names the same account');
      await claude.read();
      assert.deepStrictEqual(asked, ['a', 'a2'], 'and only once');

      // B's token while ~/.claude.json still names A, then while it names nobody, with B's profile failing: B's usage,
      // and neither A's plan nor a next bill, named so that main drops the ones on hand. A failed read too.
      fails = true;
      useToken('token-b');
      const stale = await claude.read();
      assert.deepStrictEqual([stale.plan, 'renewsAt' in stale, stale.rows[0].percent, stale.accountUnknown], ['', false, 70, true], "B's usage, with no plan or next bill while ~/.claude.json still names A and B's profile fails, and no account known");
      assert.ok(hashed(stale) && stale.renewsFor !== a.renewsFor, 'named as no account on hand');
      fs.rmSync(config);
      const missing = await claude.read();
      assert.deepStrictEqual([missing.plan, 'renewsAt' in missing, missing.renewsFor], ['', false, stale.renewsFor], 'the same with no ~/.claude.json');
      usageFails = true;
      const failed = await claude.read();
      assert.deepStrictEqual([failed.soft, failed.renewsFor, failed.accountUnknown], [true, stale.renewsFor, true], 'and a failed read says so too, and that it knows no account');
      usageFails = false;
      assert.deepStrictEqual(asked.filter((t) => t === 'b').length, 3, 'its profile asked at every read until it answers');
      fails = false;
      const b = await claude.read();
      assert.deepStrictEqual(plan(b), ['Pro', nextMonthly(who.b[3]), 70], "then B's own, though ~/.claude.json still names nobody");
      assert.ok(hashed(b) && b.renewsFor !== a.renewsFor && b.renewsFor !== stale.renewsFor, "named as B's, hashed");
      // B's own copy in ~/.claude.json names B as its live read does, or main would leave it alone.
      const now = Date.now();
      fs.writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: 'acct-b' }, cachedUsageUtilization: { fetchedAtMs: now, accountUuid: 'acct-b', utilization: { limits: [{ kind: 'session', percent: 70 }] } } }));
      assert.strictEqual(require('./providers').readClaudeLocal(now).renewsFor, b.renewsFor, 'the local copy names the same account');
      // ~/.claude.json still naming A after B's profile came changes nothing either.
      const sofar = asked.length;
      signIn('acct-a', 'token-b');
      assert.deepStrictEqual([plan(await claude.read()), asked.length], [plan(b), sofar], "~/.claude.json naming A leaves B's plan, and asks nothing more");

      // A's profile answering late, after a switch back to B, fills only the read that asked for it.
      signIn('acct-a', 'token-a');
      hold = true;
      const late = claude.read();
      for (let i = 0; i < 100 && hold === true; i++) await new Promise((r) => setTimeout(r, 5));
      const release = hold;
      hold = null;
      signIn('acct-b', 'token-b');
      assert.deepStrictEqual(plan(await claude.read()), ['Pro', nextMonthly(who.b[3]), 70], 'B signed in again, while A\'s profile is still out');
      release();
      const lateRead = await late;
      assert.deepStrictEqual([lateRead.plan, lateRead.renewsFor], ['Max', a.renewsFor], "A's late profile is A's read's");
      assert.deepStrictEqual(plan(await claude.read()), ['Pro', nextMonthly(who.b[3]), 70], 'and never lands on B');
      // One login in another organization has that organization's plan, and its copy names it as the live read does.
      const before = asked.length;
      signIn('acct-b', 'token-bt', 'org-team');
      const team = await claude.read();
      assert.ok(asked.length === before + 1 && team.plan === 'Ultra' && team.renewsFor !== b.renewsFor, "the same login in another organization has that one's profile");
      fs.writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: 'acct-b', organizationUuid: 'org-team' }, cachedUsageUtilization: { fetchedAtMs: now, accountUuid: 'acct-b', utilization: { limits: [{ kind: 'session', percent: 70 }] } } }));
      assert.strictEqual(require('./providers').readClaudeLocal(now).renewsFor, team.renewsFor, 'and its copy names it the same');
      fs.writeFileSync(config, '{"oauthAccount": {"accou');
      const unknown = await claude.read();
      assert.deepStrictEqual([unknown.plan, unknown.renewsFor], ['Ultra', team.renewsFor], '~/.claude.json caught mid-write changes nothing');

      // A 429: a profile that answers says whose, one that doesn't says it's no account on hand.
      signIn('acct-b', 'token-b');
      let profile = () => new Promise((r) => setTimeout(r, 20, { ok: true, json: async () => ({ account: { uuid: 'acct-b' } }) })); // after the 429
      global.fetch = async (url) => (url.endsWith('/profile') ? profile() : { ok: false, status: 429, headers: new Headers({ 'retry-after': '30' }) });
      const known = await claude.read();
      assert.deepStrictEqual([known.renewsFor, 'accountUnknown' in known], [b.renewsFor, false], 'a 429 says whose too, for main');
      useToken('token-a3');
      profile = () => ({ ok: false, status: 429, headers: new Headers() });
      const gated = await claude.read();
      assert.ok(gated.retryAfter && gated.accountUnknown && hashed(gated) && gated.renewsFor !== a.renewsFor && gated.renewsFor !== b.renewsFor, "and a new token's with no profile, none on hand");
      // A profile that names no account: its plan, under a name no other token's reading shares.
      profile = () => ({ ok: true, json: async () => ({ organization: { rate_limit_tier: 'default_claude_pro' } }) });
      global.fetch = async (url) => (url.endsWith('/profile') ? profile() : { ok: true, json: async () => ({ limits: [{ kind: 'session', percent: 5 }] }) });
      useToken('token-n1');
      const nameless = await claude.read();
      useToken('token-n2');
      const next = await claude.read();
      assert.deepStrictEqual([nameless.plan, next.plan, hashed(nameless), nameless.renewsFor === next.renewsFor, 'accountUnknown' in nameless], ['Pro', 'Pro', true, false, false], 'a profile that names no account names each token apart, as an account of its own');
    } finally {
      global.fetch = originalFetch;
      fs.writeFileSync(creds, credsWas);
      fs.rmSync(config, { force: true });
    }
  })
  .then(copyChecks)
  .then(mainChecks)
  .then(sizingChecks)
  .then(linkChecks)
  .then(healChecks)
  .then(startChecks)
  .then(() => console.log('ok'))
  .finally(() => fs.rmSync(codexHome, { recursive: true, force: true }));

// --- main.js polling and persistence, with Electron faked and fake providers: the paths no renderer test reaches.
// The window main sizes for a top or bottom edge fits the display at every Size: at Extra large six chips are wider than
// a 600px portrait monitor, so the pill shrinks to fit and the panel keeps its zoom. main.js with the real providers,
// none of them read, on a fake display.
function sizingChecks() {
  const display = { id: 1, workArea: { x: 0, y: 0, width: 600, height: 1000 } };
  const displays = [display];
  const events = {};
  const ipc = {};
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-overlay-sizing-'));
  const electron = {
    app: { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on() {}, getPath: () => stateDir },
    ipcMain: { on: (ch, fn) => (ipc[ch] = fn), handle() {} },
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: ({ x }) => displays.find((d) => x >= d.workArea.x && x < d.workArea.x + d.workArea.width) || display,
      getCursorScreenPoint: () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }),
      on: (e, fn) => (events[e] = fn),
    },
  };
  const mod = { exports: {} };
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') + '\nmodule.exports = { windowSize, pillScale, panelScale, watchDisplays, set: (e, s) => ((edge = e), (scale = s), (displayId = 1)), setWin: (w) => (win = w), setDisplay: (id) => (displayId = id), along: () => along, settle: () => (clearTimeout(saveTimer), clearInterval(snapTimer)) };';
  new Function('require', 'module', '__dirname', src)((id) => (id === 'electron' ? electron : require(id)), mod, __dirname);
  const { windowSize, pillScale, panelScale, watchDisplays, set, setWin, setDisplay, along, settle } = mod.exports;
  for (const [e, s] of [['top', 1.25], ['bottom', 1.25], ['top', 1], ['top', 0.68]]) {
    set(e, s);
    assert.ok(windowSize().width <= 600, `six chips on the ${e} edge at Size ${s} fit a 600px display, not ${windowSize().width}px`);
    assert.strictEqual(panelScale(), Math.max(1, s), 'the panel keeps its zoom');
  }
  set('top', 1.25);
  assert.ok(pillScale() < 1.25 && pillScale() > 1, `Extra large shrinks the pill just enough, to ${pillScale()}`);
  set('top', 1);
  assert.strictEqual(pillScale(), 1, 'Large fits, so it stays Large');
  set('right', 1.25);
  assert.strictEqual(pillScale(), 1.25, 'a side edge stacks the chips, so it keeps Size');

  // The display changes while the overlay runs: a 1920px monitor turned to 600px, then unplugged for the primary.
  const sent = [];
  let bounds = null;
  setWin({ isDestroyed: () => false, setBounds: (b) => (bounds = b), getBounds: () => bounds, webContents: { send: (ch, v) => sent.push([ch, v]) } });
  watchDisplays();
  set('top', 1.25);
  display.workArea.width = 1920;
  events['display-metrics-changed']();
  assert.strictEqual(bounds.width, Math.ceil(6 * 88 * 1.25 + 32), 'on a wide display, Extra large');
  display.workArea.width = 600;
  events['display-metrics-changed']();
  assert.ok(bounds.width <= 600 && bounds.x >= 0 && bounds.x + bounds.width <= 600, `turned to 600px, the window fits it: ${JSON.stringify(bounds)}`);
  assert.ok(sent.at(-1)[0] === 'layout' && sent.at(-1)[1].scale < 1.25 && sent.at(-1)[1].panel === 1.25, 'and the renderer hears the smaller pill');
  // A display 600px tall: Extra large's panel alone is 750px, so the window stops at the display and the rows scroll.
  for (const e of ['right', 'left', 'top', 'bottom']) {
    set(e, 1.25);
    display.workArea.height = 600;
    events['display-metrics-changed']();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 600 && bounds.x >= 0 && bounds.x + bounds.width <= 600, `on the ${e} edge of a 600px-tall display, the window fits it: ${JSON.stringify(bounds)}`);
  }
  display.workArea.height = 1000;
  set('top', 1.25);
  // On a second monitor, which is unplugged and then plugged back in: the primary meanwhile, then its own again.
  const second = { id: 2, workArea: { x: 600, y: 0, width: 1920, height: 1080 } };
  displays.push(second);
  setDisplay(2);
  events['display-added']();
  assert.ok(bounds.x >= 600 && bounds.width === Math.ceil(6 * 88 * 1.25 + 32), `placed on the second, wide display: ${JSON.stringify(bounds)}`);
  displays.pop();
  events['display-removed']();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 600, `unplugged, on the primary at a size it holds: ${JSON.stringify(bounds)}`);
  displays.push(second);
  events['display-added']();
  assert.ok(bounds.x >= 600, `plugged back in, on its own display again: ${JSON.stringify(bounds)}`);

  // Picked up and dropped where it sits, on a right edge whose window is capped to a 600px-tall display: it has nowhere
  // to slide, so it keeps its place along the edge rather than going to the corner when the display grows.
  displays.pop();
  set('right', 1.25);
  display.workArea.height = 600;
  events['display-metrics-changed']();
  assert.strictEqual(along(), 0.5);
  ipc['drag-start']();
  ipc['drag-end']();
  assert.strictEqual(along(), 0.5, 'a drop with no room to slide keeps its place along the edge');
  display.workArea.height = 1000;
  events['display-metrics-changed']();
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - 500) <= 1, `on the taller display it is still centred: ${JSON.stringify(bounds)}`);
  settle();
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// A second copy exits before it opens a window or touches anything: two would fight over port 7430, and the second,
// holding the sleep timers on its own, could save over the first's record of them. A --shot run, which runs beside
// the installed copy, asks for no lock, leaves the power settings to that copy, Keep PC awake or not, and only reads
// that copy's profile.
async function copyChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-overlay-copy-'));
  const anything = new Proxy(function () {}, {
    get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : anything),
    apply: () => anything,
    construct: () => anything,
  });
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') + '\nmodule.exports = { setKeepAwake, tick, last };';
  const load = (lock, argv = [], powercfg = () => '', providers = []) => {
    const seen = { locks: 0, exit: undefined, windows: 0, powercfg: 0, helpers: 0 };
    const handlers = {};
    const paths = {};
    let ready;
    const app = { commandLine: anything, requestSingleInstanceLock: () => (seen.locks++, lock), exit: (code) => (seen.exit = code), whenReady: () => new Promise((r) => (ready = r)), on() {}, getPath: () => dir, setPath: (name, to) => (paths[name] = to) };
    // A window that takes any call and keeps what it is asked to listen for.
    const BrowserWindow = function () {
      seen.windows++;
      return new Proxy(anything, { get: (_, k) => (k === 'on' || k === 'once' ? (e, fn) => ((handlers[e] = fn), anything) : anything[k]) });
    };
    const deps = {
      electron: new Proxy({ app, BrowserWindow }, { get: (t, k) => t[k] ?? anything }),
      http: { createServer: () => anything },
      './link': anything,
      './providers': { ...require('./providers'), PROVIDERS: providers }, // no real account is ever asked
      child_process: { spawn: () => (seen.helpers++, anything), execFileSync: (cmd, args) => (seen.powercfg++, powercfg(args)) },
    };
    const argvWas = process.argv;
    process.argv = [...argvWas, ...argv];
    const mod = { exports: {} };
    try {
      new Function('require', 'module', '__dirname', src)((id) => deps[id] ?? require(id), mod, __dirname);
    } finally {
      process.argv = argvWas;
    }
    return { seen, handlers, paths, ready, ...mod.exports };
  };
  const second = load(false);
  second.ready();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(second.seen, { locks: 1, exit: 0, windows: 0, powercfg: 0, helpers: 0 }, 'a second copy exits and opens nothing');

  // A --shot run starts from the installed copy's state.json, with Keep PC awake on and a saved Claude reading. The
  // installed copy then switches it off, as it did when a shot that saved its old "on" back made the next start hold
  // the timers at Never again. The shot paints the saved numbers and the CPU's, asks no account, starts no helper,
  // writes nothing there, flushing at a session end too, and keeps Chromium's own files out of that profile.
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ keepAwake: true, sleepAc: { '27fa6203-3987-4dcc-918d-748559d549ec': 600 }, cache: { claude: { plan: 'Max', rows: [{ label: 'Session', percent: 42 }], updatedAt: 1 } } }));
  const asked = [];
  const shot = load(false, ['--shot=' + path.join(dir, 'shot.png')], undefined, [
    { id: 'claude', name: 'Claude', everyMs: 0, read: async () => (asked.push('claude'), { rows: [{ label: 'Session', percent: 99 }], updatedAt: Date.now() }) },
    { id: 'cpu', name: 'CPU', everyMs: 0, local: true, read: async () => (asked.push('cpu'), { rows: [{ label: 'Load', percent: 7 }], updatedAt: Date.now() }) },
  ]);
  const intervalWas = global.setInterval;
  global.setInterval = () => ({ unref() {} }); // main.js's own timers stand still, and only for a few microtasks
  try {
    shot.ready();
    for (let i = 0; i < 5; i++) await null; // whenReady's callback runs: the window, loadState, the tray
    const switchedOff = JSON.stringify({ keepAwake: false });
    fs.writeFileSync(statePath, switchedOff);
    shot.setKeepAwake(true);
    await shot.tick(true);
    shot.handlers['session-end']();
    await new Promise((r) => setTimeout(r, 500)); // past any debounced save
    assert.deepStrictEqual(shot.seen, { locks: 0, exit: undefined, windows: 1, powercfg: 0, helpers: 0 }, 'a --shot run takes no lock and leaves keep-awake and the sleep timers alone');
    assert.strictEqual(fs.readFileSync(statePath, 'utf8'), switchedOff, "and writes nothing over the installed copy's state");
    assert.deepStrictEqual([asked, shot.last.get('claude').rows[0].percent, shot.last.get('cpu').rows[0].percent], [['cpu'], 42, 7], 'it paints the saved numbers and asks no account');
    assert.ok(shot.paths.userData === shot.paths.sessionData && path.relative(dir, shot.paths.userData).startsWith('..'), "Chromium's own files go to a folder outside the profile");
  } finally {
    global.setInterval = intervalWas;
  }

  // Windows ending the session skips will-quit. The window's session-end puts the timer back and saves at once,
  // with the switch still on for the next start. One plan, 600 s of its own, held at Never by a crashed run.
  const PERF = '27fa6203-3987-4dcc-918d-748559d549ec';
  const plan = { ac: 0 };
  const powercfg = ([verb, , , , value]) =>
    verb === '/list' ? `GUID: ${PERF}  (Performance) *\r\n`
    : verb === '/q' ? `0x00000000 0xffffffff 0x00000001 0x${plan.ac.toString(16)} 0x000000f0\r\n`
    : verb === '/setacvalueindex' ? ((plan.ac = Number(value)), '')
    : '';
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ keepAwake: true, sleepAc: { [PERF]: 600 } }));
  global.setInterval = () => ({ unref() {} });
  try {
    const first = load(true, [], powercfg);
    first.ready();
    for (let i = 0; i < 5; i++) await null; // whenReady's callback runs
    assert.strictEqual(plan.ac, 0, 'starting with the switch on holds the timer');
    first.handlers['session-end']();
  } finally {
    global.setInterval = intervalWas;
  }
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepStrictEqual([plan.ac, st.keepAwake, st.sleepAc], [600, true, {}], 'session end puts the timer back and saves that');
  await new Promise((r) => setTimeout(r, 500)); // its debounced save lands before the folder goes
  fs.rmSync(dir, { recursive: true, force: true });
}

async function mainChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-overlay-main-'));
  const on = {};
  const powerCalls = [];
  const beeps = [];
  const electron = {
    app: { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on: (e, fn) => (on[e] = fn), getPath: () => dir },
    ipcMain: { on() {}, handle() {} },
    globalShortcut: { unregisterAll() {} },
    Menu: { buildFromTemplate: (template) => template },
    screen: { getAllDisplays: () => [{ id: 1 }], getPrimaryDisplay: () => ({ id: 1 }) },
    safeStorage: { decryptString: (sealed) => sealed.toString(), encryptString: (key) => Buffer.from(key) }, // synthetic keys only, sealed as plain base64
    shell: { beep: () => beeps.push(Date.now()) },
    // As Electron 44 and later read it: a promise. A synthetic key, never the real clipboard's.
    clipboard: { readText: async () => ' sk-ant-sid01-pasted\n', clear: () => (clipboardCleared = true) },
  };
  let clipboardCleared = false;
  // Keep-awake's PowerShell helper, never really started: each child is numbered so a stop names the one it ends.
  const childProcess = { spawn: (cmd, args, opts) => {
    const id = powerCalls.filter(([what]) => what === 'start').length;
    powerCalls.push(['start', cmd, args.at(-1).includes('SetThreadExecutionState(0x80000001)') && opts.windowsHide && opts.stdio[0] === 'pipe']);
    return { on() { return this; }, kill: () => powerCalls.push(['stop', id]) };
  }, execFileSync: (cmd, args, opts) => {
    cfg.calls.push(args);
    if (!['/list', '/q', '/setacvalueindex', '/setactive'].includes(args[0])) cfg.unexpected.push(args);
    if (cfg.hang?.(args)) {
      // A powercfg that never answers: execFileSync waits out its timeout, here on the stood-in clock.
      cfg.clock += opts.timeout;
      throw Object.assign(new Error('spawnSync powercfg ETIMEDOUT'), { code: 'ETIMEDOUT' });
    }
    if (cfg.fail?.(args) || cmd !== 'powercfg' || !opts.windowsHide || !(opts.timeout > 0)) throw Object.assign(new Error('Command failed: powercfg'), { status: 1 });
    return cfg.odd?.(args) ?? powercfg(args);
  } };
  // powercfg as this PC answers, labels in French with the console's é read as U+FFFD; only GUIDs and hex numbers
  // mean anything. Each plan holds its plugged-in (ac) and battery (dc) sleep timers in seconds. `odd` stands in
  // other output for a call, `fail` makes one fail, `hang` makes one time out. Any verb but the four main.js
  // needs lands in `unexpected`.
  const cfg = { plans: {}, active: null, calls: [], unexpected: [], fail: null, odd: null, hang: null, clock: 0, wrote: null };
  const hex = (n) => '0x' + n.toString(16).padStart(8, '0');
  const powercfg = ([verb, plan, sub, setting, value, ...rest]) => {
    const failed = () => Object.assign(new Error('Command failed: powercfg'), { status: 1 });
    if (verb === '/list' && !plan) return "\r\nModes de gestion de l'alimentation existants (* Actif)\r\n-----------------------------------\r\n" + Object.keys(cfg.plans).map((g) => `GUID du mode de gestion de l'alimentation�: ${g}  (Plan)${g === cfg.active ? ' *' : ''}\r\n`).join('');
    if (verb === '/setactive' && plan === 'SCHEME_CURRENT' && !sub) return '';
    const p = cfg.plans[plan];
    if (!p || sub !== 'SUB_SLEEP' || setting !== 'STANDBYIDLE' || rest.length) throw failed();
    if (verb === '/setacvalueindex' || verb === '/setdcvalueindex') {
      if (!/^\d+$/.test(value)) throw failed();
      cfg.wrote?.(plan, Number(value));
      p[verb === '/setacvalueindex' ? 'ac' : 'dc'] = Number(value);
      return '';
    }
    if (verb !== '/q' || value !== undefined) throw failed();
    return `GUID du mode de gestion de l'alimentation�: ${plan}  (Plan)\r\n  Alias de GUID�: SCHEME_BALANCED\r\n  GUID du sous-groupe�: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Veille)\r\n    Alias de GUID�: SUB_SLEEP\r\n    GUID du param�tre d'alimentation�: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Veille apr�s)\r\n      Alias de GUID�: STANDBYIDLE\r\n      Valeur minimale possible�: 0x00000000\r\n      Valeur maximale possible�: 0xffffffff\r\n      Incr�ment possible des param�tres�: 0x00000001\r\n      Unit�s possibles des param�tres�: secondes\r\n    Index actuel du param�tre de courant alternatif�: ${hex(p.ac)}\r\n    Index actuel du param�tre de courant continu�: ${hex(p.dc)}\r\n\r\n`;
  };
  // The phone's HTTP handler is caught as main.js hands it to http, so no port opens: the installed overlay may hold 7430.
  let phoneHandler = null;
  const http = { createServer: (fn) => ((phoneHandler = fn), { on() { return this; }, listen() { return this; } }) };
  // One provider whose read the checks hold and finish by hand, and a CPU that answers at once; no real account is
  // ever asked.
  const held = { read: async () => ({ rows: [] }) };
  let cpuLoad = 5;
  const providers = { ...require('./providers'), PROVIDERS: [
    { id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', everyMs: 0, read: () => held.read() },
    { id: 'cpu', name: 'CPU', glyph: '▦', color: '#5b9cf5', everyMs: 0, local: true, read: async () => ({ rows: [{ label: 'Load', percent: cpuLoad }], updatedAt: Date.now() }) },
  ] };
  // The link's secret is a made-up one: the real one is never read.
  const link = { ...require('./link'), secret: () => 'e'.repeat(64) };
  const mod = { exports: {} };
  // The tray only exists once the window does, which the fake app never gets to; its menu is rebuilt into nothing.
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') + '\ntray = { setContextMenu() {} };\nmodule.exports = { readOne, tick, saveState, gate, last, servePhone, useConsoleKey, pasteConsoleKey, snapshot, loadState, savedReading, menu, savedCache: () => cache, setWin: (w) => (win = w), fetched, signedIn, crash: () => { flushState(); awakeBlocker = null; sleepAc = {}; } };';
  new Function('require', 'module', '__dirname', src)((id) => (id === 'electron' ? electron : id === 'http' ? http : id === 'child_process' ? childProcess : id === './providers' ? providers : id === './link' ? link : require(id)), mod, __dirname);
  const { readOne, tick, saveState, gate, last, servePhone, useConsoleKey, pasteConsoleKey, snapshot, loadState, savedReading, savedCache, setWin, fetched, signedIn } = mod.exports;
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const reading = (id, percent, wait = 0) => ({ id, everyMs: 0, read: async () => {
    await new Promise((r) => setTimeout(r, wait));
    return { rows: [{ label: 'Weekly', percent }], updatedAt: 1 };
  } });
  const realNow = Date.now;
  try {
    // Three providers landing inside one save debounce all reach disk, and quit doesn't wait for the debounce.
    await Promise.all(['claude', 'codex', 'opencode-go'].map((id) => readOne(reading(id, 5), true)));
    on['will-quit']();
    assert.deepStrictEqual(Object.keys(saved().cache).sort(), ['claude', 'codex', 'opencode-go'], 'no provider lost from the saved cache');

    // Two refreshes of one provider share a request, so a slow older answer can't land last.
    let calls = 0;
    const slow = reading('codex', 9, 20);
    const read = slow.read;
    slow.read = () => (calls++, read());
    await Promise.all([readOne(slow, true), readOne(slow, true)]);
    assert.strictEqual(calls, 1, 'overlapping refreshes join one request');

    // A local fallback older than the live reading on screen is no news; a newer reading still lands.
    const codexAt = (percent, updatedAt, extra) => ({ id: 'codex', everyMs: 0, read: async () => ({ rows: [{ label: '5h limit', percent }], updatedAt, ...extra }) });
    await readOne(codexAt(80, 2000), true);
    await readOne(codexAt(20, 1000, { why: 'Live refresh failed.' }), true);
    assert.strictEqual(last.get('codex').rows[0].percent, 80, 'an older fallback keeps the newer reading');
    assert.strictEqual(last.get('codex').note, undefined, 'with no message');
    await readOne(codexAt(10, 3000, { why: 'Live refresh failed.' }), true);
    assert.strictEqual(last.get('codex').rows[0].percent, 10, 'a newer fallback still lands');

    // Retry-After runs from the 429's arrival, 14s after the request left.
    let clock = realNow();
    Date.now = () => clock;
    await readOne({ id: 'claude', everyMs: 0, read: async () => ((clock += 14_000), { error: 'Rate limited', soft: true, retryAfter: 60 }) }, true);
    assert.strictEqual(gate.get('claude'), clock + 60_000, 'gate counts from receipt');
    Date.now = realNow;

    // A 429 is no news. The numbers on screen stay as they were, with no note; before any numbers the section just
    // waits. The read is due again as the gate lifts, not five minutes on.
    {
      const p = { id: 'gated', everyMs: 5 * 60_000 };
      let answer = { rows: [{ label: 'Weekly', percent: 40 }], updatedAt: 5000 };
      let asked = 0;
      p.read = async () => (asked++, answer);
      clock = realNow();
      Date.now = () => clock;
      await readOne(p, true);
      answer = { error: 'Rate limited', soft: true, retryAfter: 60 };
      await readOne(p, true);
      assert.deepStrictEqual(last.get('gated'), { rows: [{ label: 'Weekly', percent: 40 }], updatedAt: 5000 }, 'a 429 leaves the numbers on screen as they were');
      answer = { rows: [{ label: 'Weekly', percent: 41 }], updatedAt: 6000 };
      clock += 59_000;
      await readOne(p, false);
      assert.strictEqual(asked, 2, 'nothing is asked while the gate holds');
      clock += 2000;
      await readOne(p, false);
      assert.strictEqual(asked, 3, 'and the read is due the moment it lifts');
      assert.strictEqual(last.get('gated').rows[0].percent, 41);
      // Local numbers (readLocal: other clients' files, no request) land when they are newer than the ones on screen:
      // between reads, through a 429's gate, and after a failed read. Only the usage moves.
      let local = null;
      p.readLocal = () => local;
      const R5 = new Date(clock + 3 * 3600_000).toISOString();
      const R7 = new Date(clock + 40 * 3600_000).toISOString();
      answer = { plan: 'Max', apiCredit: { leftCents: 9000, grantedCents: 10000 }, bankedResets: 1, bankedResetExpiries: [1], rows: [{ label: 'Session', percent: 10, resetsAt: R5 }, { label: 'Weekly', percent: 41, resetsAt: R7 }], updatedAt: clock };
      await readOne(p, true);
      asked = 0;
      clock += 60_000;
      local = { rows: [{ label: 'Session', percent: 30, resetsAt: R5 }, { label: 'Weekly', percent: 41, resetsAt: R7 }, { label: 'Fable', percent: 2, resetsAt: R7 }], updatedAt: clock - 10_000 };
      await readOne(p, false);
      const took = last.get('gated');
      assert.strictEqual(asked, 0, 'between reads, local numbers cost no request');
      assert.deepStrictEqual(took.rows.map((r) => [r.label, r.percent]), [['Session', 30], ['Weekly', 41], ['Fable', 2]], 'a line that moved lands, one that agrees stays, a new current one joins');
      assert.deepStrictEqual([took.updatedAt, took.plan, took.apiCredit.leftCents, took.bankedResets], [clock - 10_000, 'Max', 9000, 1], 'dated by the source, with the plan, the credit and the banked resets as read');
      assert.strictEqual(savedCache().gated.rows[0].percent, 30, 'and saved');
      local = { rows: [{ label: 'Session', percent: 31, resetsAt: R5 }], updatedAt: clock - 5000 };
      await readOne(p, false);
      assert.deepStrictEqual([last.get('gated').rows.map((r) => r.percent), last.get('gated').updatedAt], [[31, 41, 2], clock - 10_000], 'a copy lacking lines on screen moves what it has, and dates nothing');
      local = { rows: [{ label: 'Session', percent: 5, resetsAt: R5 }], updatedAt: clock - 20_000 };
      await readOne(p, false);
      assert.strictEqual(last.get('gated').rows[0].percent, 31, 'older local numbers change nothing');
      // A newer copy can carry a stale line, since its date need not hold for every line. Each line is judged on its
      // own. In the same period the higher number is the later one; a later reset time is a new period, and a reset.
      const iso = (ms) => new Date(clock + ms).toISOString();
      const H = 3600_000;
      const S1 = iso(3 * H);
      const W1 = iso(40 * H).replace('Z', '+00:00'); // as the endpoint writes it
      const S2 = iso(8 * H);
      let seen = clock - 5000;
      const sight = async (rows) => ((local = { rows, updatedAt: ++seen }), await readOne(p, false), last.get('gated').rows.map((r) => [r.label, r.percent]));
      last.set('gated', { ...last.get('gated'), rows: [{ label: 'Session', percent: 30, resetsAt: S1 }, { label: 'Weekly', percent: 22, resetsAt: W1 }], updatedAt: seen });
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 31, resetsAt: S1 }, { label: 'Weekly', percent: 20, resetsAt: iso(40 * H) }]), [['Session', 31], ['Weekly', 22]], "a stale line in a fresher snapshot can't roll a number back");
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 2, resetsAt: S2 }]), [['Session', 2], ['Weekly', 22]], 'a later reset time is a new period, lower or not');
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 90, resetsAt: S1 }]), [['Session', 2], ['Weekly', 22]], 'and an earlier one is the period before, however high');
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 92, resetsAt: null }]), [['Session', 2], ['Weekly', 22]], 'a line with no reset time never displaces a dated one');
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 3, resetsAt: S2 }]), [['Session', 3], ['Weekly', 22]], 'and the period goes on climbing after it');
      // Just past a reset the endpoint can say 0% with no reset time: the period before, however high, stays gone.
      last.set('gated', { ...last.get('gated'), rows: [{ label: 'Session', percent: 0, resetsAt: null }, { label: 'Weekly', percent: 22, resetsAt: W1 }], updatedAt: seen });
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 92, resetsAt: iso(-60_000) }]), [['Session', 0], ['Weekly', 22]], 'a line whose period has ended never comes back');
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 4, resetsAt: S2 }]), [['Session', 4], ['Weekly', 22]], 'a current one takes over an undated one');
      last.set('gated', { ...last.get('gated'), rows: [{ label: 'Session', percent: 92, resetsAt: null }, { label: 'Weekly', percent: 22, resetsAt: W1 }], updatedAt: seen });
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 3, resetsAt: S2 }]), [['Session', 3], ['Weekly', 22]], 'however high the undated one is');
      last.set('gated', { ...last.get('gated'), rows: [{ label: 'Session', percent: 50, resetsAt: iso(-60_000) }, { label: 'Weekly', percent: 22, resetsAt: W1 }], updatedAt: seen });
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 5, resetsAt: S2 }]), [['Session', 5], ['Weekly', 22]], 'and one whose own period has ended');
      // A line not on screen yet joins only when it is current, so an ended one can't drive the summary.
      assert.deepStrictEqual(await sight([{ label: 'Session', percent: 5, resetsAt: S2 }, { label: 'Fable', percent: 98, resetsAt: iso(-60_000) }, { label: 'Opus', percent: 40, resetsAt: null }]), [['Session', 5], ['Weekly', 22]], 'an unseen line whose period has ended, or with no reset time, is left out');
      assert.deepStrictEqual(await sight([{ label: 'Fable', percent: 3, resetsAt: W1 }, { label: 'Opus', percent: 0, resetsAt: null }]), [['Session', 5], ['Weekly', 22], ['Fable', 3], ['Opus', 0]], 'a current one joins, and so does a window not started');
      // A newer copy that agrees with every current line it shares confirms them: the reading's age moves on, the old
      // note goes, and nothing beeps. One that disputes a line, with a stale number, dates nothing.
      last.set('gated', { ...last.get('gated'), rows: [{ label: 'Session', percent: 20, resetsAt: S2 }, { label: 'Weekly', percent: 22, resetsAt: W1 }], updatedAt: seen, note: 'Request timed out' });
      const before = seen;
      await sight([{ label: 'Session', percent: 18, resetsAt: S2 }, { label: 'Weekly', percent: 22, resetsAt: W1 }]);
      assert.deepStrictEqual([last.get('gated').updatedAt, last.get('gated').note], [before, 'Request timed out'], 'a copy with a stale line confirms nothing');
      await sight([{ label: 'Session', percent: 20, resetsAt: S2 }, { label: 'Weekly', percent: 22, resetsAt: W1.replace('+00:00', 'Z') }]);
      assert.deepStrictEqual([last.get('gated').rows.map((r) => r.percent), last.get('gated').updatedAt, last.get('gated').note], [[20, 22], seen, undefined], 'one that agrees dates the reading, and the note goes');
      // A line on screen the copy lacks may be stale, an ended 98% Fable driving the chip say: nothing is confirmed,
      // and a line that moves lands without dating the reading or dropping its note.
      last.set('gated', { ...last.get('gated'), rows: [{ label: 'Session', percent: 20, resetsAt: S2 }, { label: 'Fable', percent: 98, resetsAt: iso(-60_000) }], updatedAt: seen, note: 'Request timed out' });
      const stale = seen;
      await sight([{ label: 'Session', percent: 20, resetsAt: S2 }]);
      assert.deepStrictEqual([last.get('gated').updatedAt, last.get('gated').note], [stale, 'Request timed out'], 'a copy that lacks a line on screen confirms nothing');
      assert.deepStrictEqual([await sight([{ label: 'Session', percent: 25, resetsAt: S2 }]), last.get('gated').updatedAt, last.get('gated').note], [[['Session', 25], ['Fable', 98]], stale, 'Request timed out'], 'and a line that moves lands without dating the reading');
      // Two windows not started, 0% with no reset time on both sides, agree.
      last.set('gated', { ...last.get('gated'), rows: [{ label: 'Session', percent: 20, resetsAt: S2 }, { label: 'Fable', percent: 0, resetsAt: null }], updatedAt: seen, note: 'Request timed out' });
      await sight([{ label: 'Session', percent: 20, resetsAt: S2 }, { label: 'Fable', percent: 0, resetsAt: null }]);
      assert.deepStrictEqual([last.get('gated').updatedAt, last.get('gated').note], [seen, undefined], 'matching windows not started confirm too');
      last.set('gated', { ...last.get('gated'), rows: [{ label: 'Session', percent: 20, resetsAt: S2 }, { label: 'Weekly', percent: 22, resetsAt: W1 }], updatedAt: seen });
      // A new period seen locally is a reset, announced once like the endpoint's: a beep and the notice. A repeated
      // snapshot, or a fresher one with a stale line, says nothing. Claude is the provider the harness has turned on.
      {
        const sent = [];
        setWin({ isDestroyed: () => false, webContents: { send: (ch, v) => sent.push([ch, v]) } });
        const c = { id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', everyMs: 5 * 60_000 };
        let snap = null;
        c.read = async () => ({ rows: [{ label: 'Session', percent: 80, resetsAt: S1 }], updatedAt: clock });
        c.readLocal = () => snap;
        gate.delete('claude');
        await readOne(c, true);
        beeps.length = 0;
        snap = { rows: [{ label: 'Session', percent: 1, resetsAt: S2 }], updatedAt: clock + 1 };
        await readOne(c, false);
        const notices = () => sent.filter(([ch, v]) => ch === 'reset' && v);
        assert.deepStrictEqual([beeps.length, notices().map(([, v]) => [v.id, v.rows.map((r) => [r.label, r.percent])])], [1, [['claude', [['Session', 1]]]]], 'a new period seen locally beeps and says which limit reset');
        await readOne(c, false);
        snap = { rows: [{ label: 'Session', percent: 85, resetsAt: S1 }], updatedAt: clock + 2 };
        await readOne(c, false);
        assert.deepStrictEqual([beeps.length, notices().length, last.get('claude').rows[0].percent], [1, 1, 1], 'a repeated snapshot or a stale line says nothing more');
        setWin(null);
        for (const m of [last, gate, fetched]) m.delete('claude'); // as the later checks expect to find Claude
      }
      answer = { error: 'Rate limited', soft: true, retryAfter: 60 };
      await readOne(p, true);
      local = { rows: [{ label: 'Session', percent: 33, resetsAt: S2 }], updatedAt: clock };
      clock += 1000;
      await readOne(p, false);
      assert.deepStrictEqual([asked, last.get('gated').rows[0].percent, gate.get('gated') > clock], [1, 33, true], 'through the gate, newer local numbers land and nothing is asked');
      gate.delete('gated');
      answer = { error: 'Request timed out', soft: true };
      local = { rows: [{ label: 'Session', percent: 34, resetsAt: S2 }, { label: 'Weekly', percent: 22, resetsAt: W1 }], updatedAt: clock + 1 };
      await readOne(p, true);
      assert.deepStrictEqual([last.get('gated').rows[0].percent, last.get('gated').note], [34, undefined], 'after a failed read too, and its note goes with the numbers current again');
      p.readLocal = undefined;
      // A soft failure keeps the numbers on screen with no message, and a section with none yet waits for them. A 429
      // also ends an earlier error, since the endpoint answered; any other soft failure leaves one you must act on.
      const weekly7 = { rows: [{ label: 'Weekly', percent: 7 }], updatedAt: 1 };
      const noted = { id: 'noted', everyMs: 0, read: async () => weekly7 };
      await readOne(noted, true);
      noted.read = async () => ({ error: 'Request timed out', soft: true });
      await readOne(noted, true);
      assert.deepStrictEqual(last.get('noted'), weekly7, 'a timeout keeps the numbers, with no message');
      const first = { id: 'first', everyMs: 0, read: async () => ({ error: 'xAI usage not refreshed (HTTP 503).', soft: true }) };
      await readOne(first, true);
      assert.strictEqual(last.get('first'), undefined, 'a first read that fails soft shows no error');
      const signIn = { error: 'Grok sign-in expired — run `grok` to renew it.' };
      last.set('first', signIn);
      await readOne(first, true);
      assert.deepStrictEqual(last.get('first'), signIn, 'a soft failure leaves an error you must act on, adding nothing');
      first.read = async () => ({ error: 'Rate limited', soft: true, retryAfter: 1 });
      await readOne(first, true);
      assert.strictEqual(last.get('first'), undefined, 'a 429 ends it, so the section waits for numbers');
      gate.delete('first');
      // Only an older build's state.json holds a note, saved with a failed refresh: a restart drops it.
      saveState({ cache: { ...savedCache(), noted: { ...weekly7, note: 'Monthly usage not refreshed (HTTP 503).' } } });
      on['will-quit']();
      loadState();
      assert.deepStrictEqual(last.get('noted'), weekly7, "a restart drops an older build's note");
      const balance = { leftCents: 9195, grantedCents: 10000, expiresAt: 1 };
      assert.deepStrictEqual(savedReading({ ...weekly7, apiCredit: { ...balance, error: 'API credit not refreshed (HTTP 503), showing the last reading.' } }), { ...weekly7, apiCredit: balance }, 'and its credit warning, keeping the balance');
      assert.deepStrictEqual(savedReading({ ...weekly7, apiCredit: { error: 'API credit not refreshed (HTTP 503).' } }), weekly7, 'with no balance, the credit line goes');
      const sessionGone = { error: 'Console session expired. Copy a new `sessionKey` and pick Paste Console session key in the tray.' };
      assert.deepStrictEqual(savedReading({ ...weekly7, apiCredit: sessionGone }), { ...weekly7, apiCredit: sessionGone }, 'an error to act on stays');
      assert.deepStrictEqual(savedReading({ ...weekly7, bankedResets: 2, bankedResetExpiries: [1, 2, 3] }), { ...weekly7, bankedResets: 3, bankedResetExpiries: [1, 2, 3] }, 'a saved count behind its dates takes their number');
      assert.deepStrictEqual(savedReading({ ...weekly7, bankedResets: 2 }), { ...weekly7, bankedResets: 2 }, 'a count with no list stays');
      const fresh = { id: 'gated-fresh', everyMs: 5 * 60_000, read: async () => ({ error: 'Rate limited', soft: true, retryAfter: 60 }) };
      await readOne(fresh, true);
      assert.strictEqual(last.get('gated-fresh'), undefined, 'a 429 before any numbers leaves the section waiting for them');
      Date.now = realNow;
    }

    // CPU and RAM from known counters, read as a tick reads them: every read asks again and measures since the
    // last, nothing is cached, and each reading is dated, so a panel of only these two isn't "Loading…" forever.
    // A fresh providers module, so its CPU read is a first read whatever asked the CPU before.
    const real = { cpus: os.cpus, totalmem: os.totalmem, freemem: os.freemem };
    const key = require.resolve('./providers');
    const kept = require.cache[key];
    delete require.cache[key];
    const freshProviders = require('./providers');
    require.cache[key] = kept;
    let cores = [[0, 0], [0, 0]]; // per core, ms [idle, busy]
    os.cpus = () => cores.map(([idle, user]) => ({ model: ' Test CPU ', times: { user, nice: 0, sys: 0, idle, irq: 0 } }));
    os.totalmem = () => 16 * 2 ** 30;
    os.freemem = () => 4 * 2 ** 30;
    try {
      const [cpu, ram] = ['cpu', 'ram'].map((id) => freshProviders.PROVIDERS.find((p) => p.id === id));
      const load = async (then) => ((cores = then), await readOne(cpu, false), last.get('cpu').rows[0].percent);
      setTimeout(() => (cores = [[400, 100], [100, 400]]), 100); // within the first read's half second
      assert.strictEqual(await load(cores), 50, 'the first read measures its own half second');
      assert.strictEqual(await load([[500, 400], [200, 700]]), 75, 'the next read measures since the last one');
      assert.strictEqual(await load([[700, 400], [400, 700]]), 0, 'and the one after that, again');
      assert.strictEqual(last.get('cpu').plan, 'Test CPU');
      await readOne(ram, false);
      assert.deepStrictEqual([last.get('ram').plan, last.get('ram').rows[0].percent, last.get('ram').rows[0].resets], ['16.0 GB', 75, '12.0 GB'], 'RAM in use, its GB and the total');
      for (const id of ['cpu', 'ram']) {
        assert.ok(Number.isFinite(last.get(id).updatedAt), `${id} is dated`);
        assert.ok(!(id in savedCache()), `${id} is never cached`);
      }
    } finally {
      Object.assign(os, real);
    }

    // xAI asks twice per read. A throttled weekly lookup gates xAI though the monthly one answered: the
    // reading on screen stays whole, says why, and nothing more is asked before Retry-After.
    const xai = { ...require('./providers').PROVIDERS.find((p) => p.id === 'xai'), everyMs: 0 };
    const originalFetch = global.fetch;
    let xaiAsked = 0;
    let weeklyAnswer = () => ({ ok: true, json: async () => ({ config: { ...xaiWeekly.config, creditUsagePercent: 96 } }) });
    let monthlyAnswer = () => ({ ok: true, json: async () => ({ config: { monthlyLimit: { val: 400 }, used: { val: 100 } } }) });
    global.fetch = async (url) => {
      xaiAsked++;
      return url.endsWith('format=credits') ? weeklyAnswer() : monthlyAnswer();
    };
    fs.writeFileSync(path.join(codexHome, '.grok', 'auth.json'), JSON.stringify({ 'https://auth.x.ai::client': { key: 'test-token' } }));
    try {
      await readOne(xai, true);
      weeklyAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) });
      await readOne(xai, true);
      assert.deepStrictEqual(last.get('xai').rows.map((r) => [r.label, r.percent]), [['Weekly', 96], ['Monthly', 25]], 'a throttled weekly lookup keeps the reading on screen');
      assert.strictEqual(last.get('xai').note, undefined, 'and adds no note: a rate limit is no news');
      assert.ok(gate.get('xai') >= Date.now() + 89_000, 'gated by the weekly lookup\'s Retry-After');
      xaiAsked = 0;
      await readOne(xai, true);
      await readOne(xai, true);
      assert.strictEqual(xaiAsked, 0, 'refreshes by hand wait out the gate');
      // Both throttled: the longer Retry-After holds, whichever lookup drew it.
      gate.delete('xai');
      clock = realNow();
      Date.now = () => clock;
      monthlyAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) });
      weeklyAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) });
      await readOne(xai, true);
      clock += 91_000;
      xaiAsked = 0;
      await readOne(xai, true);
      assert.strictEqual(xaiAsked, 0, 'the longer of two Retry-Afters holds');
      clock += 510_000;
      await readOne(xai, true);
      assert.strictEqual(xaiAsked, 2, 'and a refresh past it asks again');
      // One lookup failing beside one that answers, its line on screen: the read failed, so every old number stays
      // with its age, with no message, and both lines move again once both answer.
      gate.delete('xai');
      Date.now = realNow;
      const weekly = (percent) => () => ({ ok: true, json: async () => ({ config: { ...xaiWeekly.config, creditUsagePercent: percent } }) });
      const monthly = (used) => () => ({ ok: true, json: async () => ({ config: { monthlyLimit: { val: 100 }, used: { val: used } } }) });
      [weeklyAnswer, monthlyAnswer] = [weekly(4), monthly(99)];
      await readOne(xai, true);
      const both = last.get('xai');
      [weeklyAnswer, monthlyAnswer] = [weekly(5), () => ({ ok: false, status: 503, headers: new Headers() })];
      await readOne(xai, true);
      assert.deepStrictEqual(last.get('xai'), both, 'a failed monthly lookup keeps both old lines and their age, with no message');
      monthlyAnswer = monthly(99);
      await readOne(xai, true);
      assert.deepStrictEqual(last.get('xai').rows.map((r) => [r.label, r.percent]), [['Weekly', 5], ['Monthly', 99]], 'both answer, both move');
      // An expired token whose renewal fails keeps the reading on screen and leaves auth.json as it was.
      const grokFile = path.join(codexHome, '.grok', 'auth.json');
      const lapsedAuth = JSON.stringify({ 'https://auth.x.ai::cid': { key: 'old-token', refresh_token: 'r1', expires_at: '2026-01-01T00:00:00Z', oidc_client_id: 'cid' } });
      fs.writeFileSync(grokFile, lapsedAuth);
      let tokenAnswer;
      let renewals = 0;
      global.fetch = async (url) => {
        if (url === 'https://auth.x.ai/oauth2/token') return (renewals++, tokenAnswer());
        return url.endsWith('format=credits') ? weeklyAnswer() : monthlyAnswer();
      };
      tokenAnswer = () => ({ ok: true, json: async () => { throw new TypeError('terminated'); } });
      await readOne(xai, true);
      assert.deepStrictEqual([last.get('xai').rows?.length, last.get('xai').note, renewals], [2, undefined, 1], 'a renewal cut off mid-body is soft, silent and not retried');
      assert.strictEqual(fs.readFileSync(grokFile, 'utf8'), lapsedAuth, 'and leaves auth.json as it was');
      tokenAnswer = () => ({ ok: true, json: async () => ({ refresh_token: 'r2', expires_in: 21600 }) });
      await readOne(xai, true);
      assert.deepStrictEqual([last.get('xai').rows?.length, last.get('xai').note], [2, undefined], 'an answer with no access token is soft and silent');
      assert.strictEqual(fs.readFileSync(grokFile, 'utf8'), lapsedAuth, 'and never reaches auth.json');
      // A throttled renewal gates xAI for its Retry-After, in seconds or as an HTTP date, not the 60s fallback.
      clock = realNow();
      Date.now = () => clock;
      // A body that broke before it was dropped changes nothing: cancelling it rejects, the status and wait stand.
      const broken = (status, headers) => new Response(new ReadableStream({ start(c) { c.error(new TypeError('body connection terminated')); } }), { status, headers });
      for (const [kind, answer] of [
        ['seconds', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '3600' }) })],
        ['an HTTP date', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': new Date(clock + 3600_000).toUTCString() }) })],
        ['seconds with a broken body', () => broken(429, { 'retry-after': '3600' })],
      ]) {
        gate.delete('xai');
        tokenAnswer = answer;
        renewals = 0;
        await readOne(xai, true);
        clock += 61_000;
        await readOne(xai, true);
        assert.strictEqual(renewals, 1, `a renewal throttled by Retry-After in ${kind} waits out the hour`);
        clock += 3_540_000;
        await readOne(xai, true);
        assert.strictEqual(renewals, 2, 'and asks again after it');
      }
      gate.delete('xai');
      tokenAnswer = () => broken(400);
      await readOne(xai, true);
      assert.match(last.get('xai').error, /Grok sign-in expired/, 'a refused refresh token with a broken body still says to run grok');
      Date.now = realNow;
    } finally {
      Date.now = realNow;
      global.fetch = originalFetch;
      gate.delete('xai');
      last.delete('xai');
    }

    // A save that fails partway, writing or replacing, leaves the last good file whole and keeps its
    // changes for the next save.
    saveState({ theme: 'paper' });
    on['will-quit']();
    const { writeFileSync, renameSync } = fs;
    try {
      fs.writeFileSync = (file, data, ...rest) => {
        writeFileSync(file, String(data).slice(0, 10), ...rest);
        throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
      };
      saveState({ scale: 0.68 });
      on['will-quit']();
      assert.strictEqual(saved().theme, 'paper', 'a partial write leaves the saved file whole');
      fs.writeFileSync = writeFileSync;
      fs.renameSync = () => { throw Object.assign(new Error('file in use'), { code: 'EPERM' }); };
      saveState({ edge: 'left' });
      on['will-quit']();
      assert.strictEqual(saved().theme, 'paper', 'so does a failed replace');
    } finally {
      Object.assign(fs, { writeFileSync, renameSync });
    }
    saveState({ autoHide: false });
    on['will-quit']();
    const after = saved();
    assert.deepStrictEqual([after.theme, after.scale, after.edge, after.autoHide], ['paper', 0.68, 'left', false], 'failed saves wait for the next one');
    assert.ok(Object.keys(after.cache).length, 'with the readings already saved');

    // The phone's settings: whatever arrives, the handler answers, and nothing escapes as an unhandled
    // rejection in the main process. Unknown keys, constructor and __proto__ among them, change nothing.
    servePhone();
    const ask = (method, url, body, { type = 'application/json', abort = false } = {}) => new Promise((resolve) => {
      const req = {
        method, url, headers: { host: '127.0.0.1:7430', 'content-type': type }, on() {},
        async *[Symbol.asyncIterator]() {
          if (abort) throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
          if (body !== undefined) yield Buffer.from(body);
        },
      };
      const res = { status: 200, headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; return this; }, write() {}, end(b) { resolve({ status: this.status, body: String(b ?? '') }); } };
      try {
        Promise.resolve(phoneHandler(req, res)).catch((e) => resolve({ threw: e.message }));
      } catch (e) {
        resolve({ threw: e.message });
      }
      setTimeout(() => resolve({ hung: true }), 1000);
    });
    for (const body of ['null', '[]', '"paper"', '7', 'not json']) {
      const r = await ask('POST', '/api/settings', body);
      assert.strictEqual(r.status, 400, `settings body ${body} gets a 400, not ${JSON.stringify(r)}`);
    }
    const aborted = await ask('POST', '/api/settings', undefined, { abort: true });
    assert.ok(!aborted.threw && !aborted.hung, `an aborted upload is answered, not ${JSON.stringify(aborted)}`);
    assert.strictEqual((await ask('POST', '/api/settings', '{}', { type: 'text/plain' })).status, 415, 'settings take JSON only');
    assert.strictEqual((await ask('POST', '/api/settings', JSON.stringify({ theme: 'x'.repeat(20_000) }))).status, 413, 'a huge body is refused');
    const odd = await ask('POST', '/api/settings', '{"choices":{"constructor":"x","__proto__":"Session","toString":""},"theme":7,"enabled":"claude"}');
    assert.strictEqual(odd.status, 200, `unknown settings are ignored, not ${JSON.stringify(odd)}`);
    assert.deepStrictEqual(JSON.parse(odd.body).choices, {}, 'and change nothing');
    assert.strictEqual(JSON.parse(odd.body).keepAwake, false, 'keep-awake defaults off');
    const awakeMenu = () => mod.exports.menu().find((item) => item.label === 'Keep PC awake');
    const powerStates = [];
    let closePowerStream;
    phoneHandler(
      { method: 'GET', url: '/api/events', headers: { host: 'localhost' }, on: (_, fn) => (closePowerStream = fn) },
      { writeHead() { return this; }, write: (chunk) => powerStates.push(JSON.parse(chunk.slice(6)).keepAwake), end() {} }
    );
    for (const value of ['true', 1, null, {}]) {
      assert.strictEqual((await ask('POST', '/api/settings', JSON.stringify({ keepAwake: value }))).status, 400);
    }
    assert.deepStrictEqual(powerCalls, [], 'invalid settings never start a blocker');
    assert.deepStrictEqual(cfg.calls, [], 'or touch a sleep timer');
    // This PC's three plans, and one already at Never.
    const [BAL, SIL, PERF, SAVER] = ['381b4222-f694-41f0-9685-ff5bb260df2e', '64a64f24-65b9-4b56-befd-5ec1eaced9b3', '27fa6203-3987-4dcc-918d-748559d549ec', 'a1841308-3541-4fab-bc81-f71556f20b4a'];
    const own = () => ({ [BAL]: { ac: 300, dc: 180 }, [SIL]: { ac: 300, dc: 180 }, [PERF]: { ac: 600, dc: 240 }, [SAVER]: { ac: 0, dc: 900 } });
    const timers = () => Object.fromEntries(Object.entries(cfg.plans).map(([plan, p]) => [plan, p.ac]));
    const writes = () => cfg.calls.filter(([verb]) => verb === '/setacvalueindex');
    const asOwn = { [BAL]: 300, [SIL]: 300, [PERF]: 600, [SAVER]: 0 };
    const never = { [BAL]: 0, [SIL]: 0, [PERF]: 0, [SAVER]: 0 };
    Object.assign(cfg, { plans: own(), active: PERF });
    const onDisk = [];
    cfg.wrote = (plan, seconds) => seconds === 0 && onDisk.push(saved().sleepAc?.[plan]);
    for (let i = 0; i < 2; i++) {
      const res = await ask('POST', '/api/settings', '{"keepAwake":true}');
      assert.strictEqual(JSON.parse(res.body).keepAwake, true);
    }
    assert.deepStrictEqual(powerCalls, [['start', 'powershell.exe', true]], 'repeated enable starts one hidden helper holding ES_SYSTEM_REQUIRED on an open stdin');
    assert.deepStrictEqual(timers(), never, 'every plan sleeps Never on mains');
    assert.deepStrictEqual(Object.values(cfg.plans).map((p) => p.dc), [180, 180, 240, 900], 'battery timers stay');
    assert.deepStrictEqual(saved().sleepAc, { [BAL]: 300, [SIL]: 300, [PERF]: 600 }, "each plan's own timer is on disk; one at Never has nothing to put back");
    assert.deepStrictEqual(onDisk, [300, 300, 600], 'each was on disk before its timer changed');
    assert.deepStrictEqual(cfg.calls.at(-1), ['/setactive', 'SCHEME_CURRENT'], 'the active plan applies its new timer');
    assert.strictEqual(writes().length, 3, 'the second enable changed nothing');
    assert.strictEqual(awakeMenu().checked, true, 'phone updates the PC menu');
    cfg.plans[SIL].ac = 900; // changed in Settings meanwhile
    awakeMenu().click({ checked: false });
    assert.deepStrictEqual(powerCalls.at(-1), ['stop', 0], 'PC toggle releases the same blocker');
    assert.deepStrictEqual(timers(), { ...asOwn, [SIL]: 900 }, 'switching off puts each timer back and keeps one changed meanwhile');
    assert.deepStrictEqual(powerStates, [false, true, false], 'both controls broadcast the state');
    closePowerStream();
    on['will-quit']();
    assert.strictEqual(saved().keepAwake, false);
    assert.deepStrictEqual(saved().sleepAc, {}, 'nothing left to put back');
    Object.assign(cfg, { plans: own() });
    awakeMenu().click({ checked: true });
    on['will-quit']();
    assert.deepStrictEqual(powerCalls.at(-1), ['stop', 1], 'quit releases the blocker');
    assert.deepStrictEqual(timers(), asOwn, 'and puts the timers back');
    assert.strictEqual(saved().keepAwake, true, 'quit preserves the saved choice');
    assert.deepStrictEqual(saved().sleepAc, {});
    loadState();
    assert.strictEqual(awakeMenu().checked, true, 'startup restores keep-awake');
    assert.deepStrictEqual(timers(), never, 'and holds the timers again');
    assert.deepStrictEqual(powerCalls.at(-1), ['start', 'powershell.exe', true]);
    assert.strictEqual(powerCalls.filter(([what]) => what === 'start').length, 3, 'one helper per enable');
    awakeMenu().click({ checked: false });
    on['will-quit']();
    assert.deepStrictEqual(timers(), asOwn);

    // A crash with the switch on leaves the timers at Never and their own values on disk. The next start holds
    // them without reading our 0 as theirs, so switching off then puts the real ones back.
    awakeMenu().click({ checked: true });
    mod.exports.crash();
    assert.deepStrictEqual([saved().keepAwake, saved().sleepAc], [true, { [BAL]: 300, [SIL]: 300, [PERF]: 600 }]);
    loadState();
    assert.deepStrictEqual(saved().sleepAc, { [BAL]: 300, [SIL]: 300, [PERF]: 600 }, 'a plan on record that reads our 0 keeps its record');
    assert.deepStrictEqual(timers(), never);
    awakeMenu().click({ checked: false });
    assert.deepStrictEqual(timers(), asOwn, 'the timers from before the crash come back');
    on['will-quit']();

    // A record left with the switch off (a crash while switching off) is put back at the next start. One that isn't
    // a lowercase plan GUID with a positive whole number of seconds is ignored.
    cfg.plans[PERF].ac = 0;
    cfg.plans[BAL].ac = 0;
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ ...saved(), keepAwake: false, sleepAc: { [PERF]: 600, [BAL]: '300', [SIL.toUpperCase()]: 5, [SAVER]: -1, 'x; shutdown /s': 60 } }));
    mod.exports.crash();
    cfg.calls = [];
    loadState();
    assert.deepStrictEqual(writes(), [['/setacvalueindex', PERF, 'SUB_SLEEP', 'STANDBYIDLE', '600']], 'only the valid record is put back');
    assert.deepStrictEqual(timers(), { ...asOwn, [BAL]: 0 });
    assert.strictEqual(awakeMenu().checked, false);
    on['will-quit']();
    assert.deepStrictEqual(saved().sleepAc, {});
    cfg.plans[BAL].ac = 300;

    // A timer that can't be put back stays on record for quit, and then the next start, to try again.
    awakeMenu().click({ checked: true });
    cfg.fail = ([verb]) => verb === '/setacvalueindex';
    awakeMenu().click({ checked: false });
    on['will-quit']();
    assert.deepStrictEqual(saved().sleepAc, { [BAL]: 300, [SIL]: 300, [PERF]: 600 }, 'kept on record');
    cfg.fail = null;
    loadState();
    assert.deepStrictEqual(timers(), asOwn, 'put back at the next start');
    on['will-quit']();
    assert.deepStrictEqual(saved().sleepAc, {});

    // A plan deleted while held drops off the record instead of failing every switch-off after.
    awakeMenu().click({ checked: true });
    delete cfg.plans[SIL];
    awakeMenu().click({ checked: false });
    on['will-quit']();
    assert.deepStrictEqual(saved().sleepAc, {}, 'a deleted plan leaves no record');
    cfg.plans = own();

    // With state.json unwritable, the timers are left alone: nothing on disk could put them back.
    const before = fs.readFileSync(statePath);
    fs.rmSync(statePath);
    fs.mkdirSync(statePath);
    cfg.calls = [];
    awakeMenu().click({ checked: true });
    assert.deepStrictEqual(writes(), [], 'no timer changes without its record on disk');
    assert.strictEqual(awakeMenu().checked, true, 'the helper still holds');
    awakeMenu().click({ checked: false });
    fs.rmdirSync(statePath);
    fs.writeFileSync(statePath, before);
    on['will-quit']();
    assert.deepStrictEqual(timers(), asOwn);

    // With no powercfg at all, the switch, startup and quit still work, on the helper alone.
    cfg.fail = () => true;
    awakeMenu().click({ checked: true });
    assert.strictEqual(awakeMenu().checked, true);
    on['will-quit']();
    assert.strictEqual(saved().keepAwake, true, 'quit still flushes');
    loadState();
    assert.strictEqual(awakeMenu().checked, true, 'startup still restores the switch');
    awakeMenu().click({ checked: false });
    on['will-quit']();
    cfg.fail = null;

    // A /list with no plan in it, from a powercfg that still exits 0, can't drop the records.
    awakeMenu().click({ checked: true });
    cfg.odd = ([verb]) => (verb === '/list' ? 'Rien\r\n' : undefined);
    awakeMenu().click({ checked: false });
    on['will-quit']();
    assert.deepStrictEqual(saved().sleepAc, { [BAL]: 300, [SIL]: 300, [PERF]: 600 }, 'an empty plan list keeps the records');
    cfg.odd = null;
    loadState();
    assert.deepStrictEqual(timers(), asOwn);
    on['will-quit']();

    // A /q cut short, to the minimum, maximum and step, or missing its minimum, so the fourth number is the battery
    // timer. No timer is taken from either, so none can come back wrong.
    for (const cut of [(q) => q.split('Unit')[0], (q) => q.replace(/Valeur minimale[^\n]*\n/, '')]) {
      cfg.odd = (args) => (args[0] === '/q' ? cut(powercfg(args)) : undefined);
      awakeMenu().click({ checked: true });
      cfg.odd = null;
      assert.deepStrictEqual([saved().sleepAc, timers()], [{}, asOwn], 'nothing taken from a short /q, nothing changed');
      awakeMenu().click({ checked: false });
      on['will-quit']();
    }

    // One plan refusing its write stops neither the others nor the active plan applying them.
    cfg.calls = [];
    cfg.fail = ([verb, plan]) => verb === '/setacvalueindex' && plan === BAL;
    awakeMenu().click({ checked: true });
    assert.deepStrictEqual(timers(), { ...never, [BAL]: 300 }, 'the other plans still go to Never');
    assert.deepStrictEqual(cfg.calls.at(-1), ['/setactive', 'SCHEME_CURRENT']);
    cfg.fail = null;
    awakeMenu().click({ checked: false });
    assert.deepStrictEqual(timers(), asOwn);
    on['will-quit']();
    assert.deepStrictEqual(saved().sleepAc, {});

    // Timers put back but not applied, because setactive failed, stay on record for quit or the next start.
    awakeMenu().click({ checked: true });
    cfg.fail = ([verb]) => verb === '/setactive';
    awakeMenu().click({ checked: false });
    on['will-quit']();
    assert.deepStrictEqual(timers(), asOwn, 'the timers are back');
    assert.deepStrictEqual(saved().sleepAc, { [BAL]: 300, [SIL]: 300, [PERF]: 600 }, 'but on record until applied');
    cfg.fail = null;
    cfg.calls = [];
    loadState();
    assert.deepStrictEqual([cfg.calls.at(-1), writes()], [['/setactive', 'SCHEME_CURRENT'], []], 'the next start applies them, writing nothing');
    on['will-quit']();
    assert.deepStrictEqual(saved().sleepAc, {});

    // A switch-off whose writes powercfg refuses leaves Windows at Never while the switch says off. The menu and the
    // phone say so, and the release is tried again by itself, a minute on, then twice as long each time up to every 30,
    // until Windows has the timers. A try starts no helper, keeps a timer changed in Settings meanwhile, and a switch-on,
    // a quit or a start that puts them back cancels the next one.
    {
      const timeoutWas = global.setTimeout;
      const clearWas = global.clearTimeout;
      const tries = []; // restoreLater's waits, run by hand
      global.setTimeout = (fn, ms, ...rest) => (ms >= 60_000 ? (tries.push({ fn, ms, live: true, unref() {} }), tries.at(-1)) : timeoutWas(fn, ms, ...rest));
      global.clearTimeout = (t) => (tries.includes(t) ? (t.live = false) : clearWas(t));
      const waits = () => tries.filter((t) => t.live).map((t) => t.ms);
      const retry = () => {
        const t = tries.find((x) => x.live);
        t.live = false;
        t.fn();
      };
      const said = async () => [mod.exports.menu().some((item) => /^Sleep timers still at Never/.test(item.label)), JSON.parse((await ask('POST', '/api/settings', '{}')).body).restoringSleep];
      const helpers = () => powerCalls.filter(([what]) => what === 'start').length;
      try {
        awakeMenu().click({ checked: true });
        assert.deepStrictEqual(await said(), [false, false], 'nothing to say while it is on');
        const started = helpers();
        cfg.fail = ([verb]) => verb === '/setacvalueindex';
        awakeMenu().click({ checked: false });
        assert.deepStrictEqual([awakeMenu().checked, timers()], [false, never], 'off, with the timers still at Never');
        assert.deepStrictEqual(await said(), [true, true], 'the menu and the phone say they are not back yet');
        assert.deepStrictEqual(waits(), [60_000], 'tried again a minute on');
        const delays = [];
        for (let i = 0; i < 7; i++) {
          retry();
          delays.push(...waits());
        }
        assert.deepStrictEqual(delays, [120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000], 'then twice as long each time, up to every 30 minutes');
        await new Promise((r) => timeoutWas(r, 450)); // the tries' debounced saves land
        assert.deepStrictEqual(saved().sleepAc, { [BAL]: 300, [SIL]: 300, [PERF]: 600 }, 'each plan\'s own timer stays on disk meanwhile');
        cfg.fail = null;
        cfg.plans[SIL].ac = 900; // changed in Settings meanwhile
        retry();
        assert.deepStrictEqual(timers(), { ...asOwn, [SIL]: 900 }, 'a try that goes through puts them back, and keeps one changed meanwhile');
        assert.deepStrictEqual([waits(), await said(), helpers()], [[], [false, false], started], 'then stops, says nothing more, and never started the helper again');
        cfg.plans[SIL].ac = 300;

        // A switch-on cancels the next try, and a try already under way when it fires finds the switch on and does
        // nothing, so it can't put back timers the switch now holds.
        awakeMenu().click({ checked: true });
        cfg.fail = ([verb]) => verb === '/setacvalueindex';
        awakeMenu().click({ checked: false });
        const stale = tries.find((t) => t.live);
        cfg.fail = null;
        awakeMenu().click({ checked: true });
        assert.deepStrictEqual([waits(), stale.live], [[], false], 'a switch-on cancels the next try');
        cfg.calls = [];
        stale.fn();
        assert.deepStrictEqual([timers(), writes(), awakeMenu().checked, helpers()], [never, [], true, started + 2], 'and a late one changes nothing');
        awakeMenu().click({ checked: false });
        assert.deepStrictEqual([timers(), waits()], [asOwn, []]);

        // A quit cancels it too, leaving the records for the next start. A start that can't put them back tries again.
        awakeMenu().click({ checked: true });
        cfg.fail = ([verb]) => verb === '/setacvalueindex';
        awakeMenu().click({ checked: false });
        on['will-quit']();
        assert.deepStrictEqual([waits(), saved().sleepAc], [[], { [BAL]: 300, [SIL]: 300, [PERF]: 600 }], 'a quit cancels the next try and keeps the records');
        loadState();
        assert.deepStrictEqual([waits(), awakeMenu().checked, await said()], [[60_000], false, [true, true]], 'a start that still can\'t put them back tries again');
        cfg.fail = null;
        retry();
        assert.deepStrictEqual([timers(), waits(), await said()], [asOwn, [], [false, false]]);
        on['will-quit']();
        assert.deepStrictEqual(saved().sleepAc, {});
      } finally {
        Object.assign(global, { setTimeout: timeoutWas, clearTimeout: clearWas });
        cfg.fail = null;
      }
    }

    // Nor can such a record bring an old timer back later. A plan that no longer reads 0 has its own timer
    // again, here one changed in Settings since, and the next switch-on keeps that one. If that plan can't be
    // read at the next switch-on, it is left as it is rather than held on the old record.
    for (const unread of [false, true]) {
      awakeMenu().click({ checked: true });
      cfg.fail = ([verb]) => verb === '/setactive';
      awakeMenu().click({ checked: false });
      cfg.fail = unread ? ([verb, plan]) => verb === '/q' && plan === SIL : null;
      cfg.plans[SIL].ac = 900;
      awakeMenu().click({ checked: true });
      assert.deepStrictEqual(timers(), unread ? { ...never, [SIL]: 900 } : never, unread ? 'a plan that could not be read is not held on an old record' : 'every plan held');
      cfg.fail = null;
      awakeMenu().click({ checked: false });
      assert.deepStrictEqual(timers(), { ...asOwn, [SIL]: 900 }, 'a timer changed after a half-done release comes back, not the old one');
      on['will-quit']();
      assert.deepStrictEqual(saved().sleepAc, {});
      cfg.plans[SIL].ac = 300;
    }

    // A powercfg that hangs costs a switch, or a quit, 3 s in all rather than 5 s for each call.
    awakeMenu().click({ checked: true });
    const clockWas = Date.now;
    Object.assign(cfg, { hang: ([verb]) => verb !== '/list', clock: 0, calls: [] });
    Date.now = () => cfg.clock;
    try {
      awakeMenu().click({ checked: false });
      assert.deepStrictEqual([cfg.calls.map(([verb]) => verb), cfg.clock], [['/list', '/q'], 3000], 'switching off gives a hung powercfg 3 s in all');
      on['will-quit']();
      assert.strictEqual(cfg.clock, 6000, 'and quit 3 s more');
    } finally {
      Date.now = clockWas;
      cfg.hang = null;
    }
    assert.deepStrictEqual(saved().sleepAc, { [BAL]: 300, [SIL]: 300, [PERF]: 600 }, 'quit still flushed, with the records');
    loadState();
    assert.deepStrictEqual(timers(), asOwn);
    on['will-quit']();
    assert.deepStrictEqual(cfg.unexpected, [], 'nothing but /list, /q, /setacvalueindex and /setactive, so never a battery timer');
    cfg.wrote = null;

    // The link's secret never goes down the link. A gateway that relays the handshake between this PC and the phone
    // can send its own GO, get a pipe to this port, and say it is a.b.ts.net: the pipe still comes from
    // link.PIPE_FROM, and is refused. Anything else goes through, and tailscale serve, from 127.0.0.1, gets the secret.
    {
      const net = require('net');
      const key = 'f'.repeat(64); // the link's, made up too
      const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
      const overlay = await listen(require('http').createServer(phoneHandler));
      let request, relayed;
      const gateway = await listen(net.createServer((s) => {
        const nonce = 'c'.repeat(32);
        let got = '';
        s.write(`LINK1 ${nonce}\n`);
        s.once('data', (hello) => {
          const [name, theirs] = String(hello).trim().split(' ');
          s.write(`${link.hmac(key, `phone|${name}|${nonce}|${theirs}`)}\nGO\n`);
          s.on('data', (d) => (got += d) === 'OK\n' && s.write(`GET ${request} HTTP/1.1\r\nHost: a.b.ts.net\r\nConnection: close\r\n\r\n`));
          s.on('close', () => relayed(got));
        });
      }));
      const realConnect = net.connect;
      net.connect = (opts, ...rest) => realConnect({ ...opts, port: opts.port === link.PORT ? gateway.address().port : opts.port }, ...rest);
      const relay = (url) => new Promise((r) => {
        [request, relayed] = [url, r];
        link.connect('127.0.0.1', 'overlay', overlay.address().port, key, () => {});
      });
      try {
        assert.match(await relay('/api/link'), /^OK\nHTTP\/1\.1 403 /, 'a pipe gets no secret, whatever Host it says');
        assert.match(await relay('/api/options'), /^OK\nHTTP\/1\.1 200 /, 'anything else goes through');
        const served = await new Promise((r) => require('http').get({ host: '127.0.0.1', port: overlay.address().port, path: '/api/link', headers: { host: 'a.b.ts.net' }, agent: false }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d)).on('end', () => r(body));
        }));
        assert.deepStrictEqual(JSON.parse(served), { secret: 'e'.repeat(64) }, 'tailscale serve gets it');
      } finally {
        net.connect = realConnect;
        overlay.close();
        gateway.close();
      }
    }

    // Snapshots are numbered in the order the PC makes them, which is not the order they reach a phone: a
    // read waits on its provider before it snapshots, so a stream message sent meanwhile is the older one,
    // though it arrives first. The phone keeps the newest by number.
    last.set('claude', { rows: [{ label: 'Weekly', percent: 10 }], updatedAt: 1 });
    gate.delete('claude');
    let finish = null;
    held.read = () => new Promise((r) => (finish = r));
    const usage = ask('GET', '/api/usage');
    for (let i = 0; i < 50 && !finish; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(finish, 'the read is waiting on its provider');
    const streamed = [];
    let hangUp = () => {};
    phoneHandler(
      { method: 'GET', url: '/api/events', headers: { host: '127.0.0.1:7430' }, on: (e, fn) => e === 'close' && (hangUp = fn) },
      { writeHead() { return this; }, write: (chunk) => streamed.push(JSON.parse(String(chunk).replace(/^data: /, ''))), end() {} }
    );
    finish({ rows: [{ label: 'Weekly', percent: 80 }], updatedAt: 2 });
    const fresh = JSON.parse((await usage).body);
    hangUp();
    const [cached] = streamed;
    assert.strictEqual(cached.providers[0].rows[0].percent, 10, 'the stream opened on the cached reading');
    assert.strictEqual(fresh.providers[0].rows[0].percent, 80, 'the read answered with the fresh one');
    assert.ok(typeof fresh.run === 'string' && fresh.run === cached.run, `both from one run of the overlay, not ${fresh.run} and ${cached.run}`);
    assert.ok(fresh.rev > cached.rev, `the fresh snapshot is numbered after the cached one, not ${fresh.rev} after ${cached.rev}`);

    // One slow provider holds back nobody else. Each read pushes as it settles: the window and the phones hear CPU's
    // load while Claude's read is still out, and a phone's read answers with what there is after a short wait, not
    // after Claude's 30 s. Claude's numbers follow both ways once they land.
    {
      const sent = [];
      setWin({ isDestroyed: () => false, webContents: { send: (ch, v) => ch === 'data' && sent.push(v.map((p) => p.rows[0].percent)) } });
      last.set('claude', { rows: [{ label: 'Weekly', percent: 20 }], updatedAt: 1 });
      gate.delete('claude');
      let finish = null;
      held.read = () => new Promise((r) => (finish = r));
      cpuLoad = 41;
      const beat = tick();
      for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(finish, "Claude's read is out");
      assert.deepStrictEqual(sent, [[20, 41]], "the window hears CPU while Claude's read is still out");
      const streamed = [];
      let hangUp = () => {};
      phoneHandler(
        { method: 'GET', url: '/api/events', headers: { host: '127.0.0.1:7430' }, on: (e, fn) => e === 'close' && (hangUp = fn) },
        { writeHead() { return this; }, write: (chunk) => streamed.push(JSON.parse(String(chunk).replace(/^data: /, '')).providers.map((p) => p.rows[0].percent)), end() {} }
      );
      cpuLoad = 42;
      // The cap's wait runs out at once, since what counts is what the answer holds while Claude's read is out.
      const realTimeout = global.setTimeout;
      global.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms > 1000 ? 0 : ms, ...rest);
      const usage = ask('GET', '/api/usage');
      global.setTimeout = realTimeout;
      const answered = await usage;
      assert.deepStrictEqual(answered.body && JSON.parse(answered.body).providers.map((p) => p.rows[0].percent), [20, 42], `the phone's read answers with what there is, not ${JSON.stringify(answered)}`);
      finish({ rows: [{ label: 'Weekly', percent: 21 }], updatedAt: 2 });
      await beat;
      hangUp();
      assert.deepStrictEqual([sent.at(-1), streamed.at(-1)], [[21, 42], [21, 42]], 'then Claude follows, to the window and down the stream');
      setWin(null);
    }

    // Forgetting the Console session takes its credit off the screen, the phones and the saved cache at once,
    // even while Claude's reads are gated, and keeps the usage rows.
    const claude = providers.PROVIDERS[0];
    held.read = async () => ({ rows: [{ label: 'Weekly', percent: 30 }], apiCredit: { leftCents: 9195, grantedCents: 10000, expiresAt: null }, updatedAt: 3 });
    await readOne(claude, true);
    gate.set('claude', Date.now() + 3_600_000);
    useConsoleKey('', undefined);
    on['will-quit']();
    assert.deepStrictEqual([last.get('claude').apiCredit, last.get('claude').rows[0].percent], [undefined, 30], 'the credit leaves the screen, the usage stays');
    assert.deepStrictEqual([saved().cache.claude.apiCredit, saved().cache.claude.rows[0].percent], [undefined, 30], 'and the saved cache, so a restart does not bring it back');
    const shown = JSON.parse((await ask('GET', '/api/usage')).body).providers[0];
    assert.deepStrictEqual([shown.apiCredit, shown.rows[0].percent], [undefined, 30], 'and the phones');

    // A read in flight began under the old session, so a session change reads again after it instead of joining it.
    gate.delete('claude');
    let reads = 0;
    held.read = () => (reads++, new Promise((r) => (finish = r)));
    const inFlight = readOne(claude, true);
    useConsoleKey('', undefined);
    finish({ rows: [{ label: 'Weekly', percent: 31 }], updatedAt: 4 });
    await inFlight;
    for (let i = 0; i < 50 && reads < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(reads, 2, 'a fresh read follows the one in flight');
    finish({ rows: [{ label: 'Weekly', percent: 32 }], updatedAt: 5 });
    await new Promise((r) => setTimeout(r, 0));

    // A balance past its deadline isn't funds, whatever kept the reading. Here the usage gate skips the read:
    // up to the deadline the balance shows; from it on the snapshot says it expired, the usage stays, and
    // nothing is asked to get round the gate.
    const lapsing = { rows: [{ label: 'Weekly', percent: 40 }], apiCredit: { leftCents: 9195, grantedCents: 10000, expiresAt: deadline }, updatedAt: 6 };
    const shownClaude = () => snapshot().find((p) => p.id === 'claude');
    Date.now = () => deadline - 60_000;
    last.set('claude', lapsing);
    gate.set('claude', deadline + 3_600_000);
    reads = 0;
    held.read = async () => (reads++, lapsing);
    Date.now = () => deadline - 1;
    assert.strictEqual(shownClaude().apiCredit.leftCents, 9195, 'up to its deadline the balance shows');
    Date.now = () => deadline;
    await readOne(claude, true);
    assert.strictEqual(reads, 0, 'the gate still holds');
    assert.deepStrictEqual([shownClaude().apiCredit, shownClaude().rows[0].percent], [{ expired: true, expiresAt: deadline }, 40], 'from its deadline the balance is gone, the usage stays');
    last.set('claude', { ...lapsing, bankedResets: 3, bankedResetExpiries: [1, 2, null] });
    assert.strictEqual(shownClaude().bankedResetExpiries, undefined, 'a reset with no deadline leaves the count alone, without dates');
    last.set('claude', { ...lapsing, bankedResets: 2, bankedResetExpiries: [1, 2] });
    assert.deepStrictEqual(shownClaude().bankedResetExpiries, [1, 2], 'with every deadline known, the dates show');
    // The next bill shows with its countdown until it passes; a kept reading's date gone by says nothing.
    last.set('claude', { ...lapsing, renewsAt: deadline + 2 * 3_600_000, renewsGuess: true });
    assert.deepStrictEqual([shownClaude().renewsIn, shownClaude().renewsGuess], ['in 2h', true], 'a bill ahead shows its countdown');
    last.set('claude', { ...lapsing, renewsAt: deadline, renewsGuess: true });
    assert.deepStrictEqual([shownClaude().renewsAt, shownClaude().renewsGuess, shownClaude().renewsIn], [undefined, undefined, undefined], 'a bill gone by goes');
    // A read that says nothing of the next bill (its lookup failed, or a restart hasn't asked yet) keeps the date on
    // hand for the same account. One that says there is none, another account's, or a date gone by doesn't.
    gate.delete('claude');
    const carried = async (prev, res) => {
      last.set('claude', { ...lapsing, ...prev });
      savedCache().claude = last.get('claude');
      held.read = async () => ({ rows: [{ label: 'Weekly', percent: 40 }], updatedAt: 7, ...res });
      await readOne(claude, true);
      return last.get('claude').renewsAt;
    };
    const ahead = deadline + 5 * 86_400_000;
    assert.strictEqual(await carried({ renewsAt: ahead, renewsGuess: true }, {}), ahead, 'a read that says nothing keeps the date on hand');
    assert.strictEqual(last.get('claude').renewsGuess, true, 'and whether it was worked out');
    assert.strictEqual(await carried({ renewsAt: ahead, renewsFor: 'a' }, { renewsFor: 'a' }), ahead, 'for the same account');
    assert.strictEqual(await carried({ renewsAt: ahead, renewsFor: 'a' }, { renewsFor: 'b' }), undefined, 'not for another');
    assert.strictEqual(await carried({ renewsAt: ahead }, { renewsAt: null }), null, 'a read that says there is none drops it');
    assert.strictEqual(await carried({ renewsAt: deadline - 1 }, {}), undefined, 'a date gone by is not kept');
    // Signed in to another account, the plan and date on hand go even when the read keeps the reading on screen (a
    // failure, an older fallback), and from the saved cache too. A read that can't tell whose it is (no sign-in to read)
    // keeps them. On disk too: account A's saved, B's read fails, and the next start finds neither.
    last.set('claude', { ...lapsing, plan: 'Max', renewsAt: ahead, renewsFor: 'a', bankedResets: 1, bankedResetExpiries: [ahead] });
    savedCache().claude = last.get('claude');
    saveState({ cache: savedCache() });
    on['will-quit']();
    held.read = async () => ({ error: 'HTTP 503', soft: true, renewsFor: 'b' });
    await readOne(claude, true);
    assert.deepStrictEqual([last.get('claude').plan, last.get('claude').renewsAt], [undefined, undefined], 'another account\'s failed read');
    assert.deepStrictEqual([shownClaude().bankedResets, shownClaude().bankedResetExpiries, savedCache().claude.bankedResets], [undefined, undefined, undefined], 'the previous account\'s banked resets are gone too');
    on['will-quit']();
    last.clear();
    loadState();
    assert.deepStrictEqual([last.get('claude')?.rows?.[0]?.percent, last.get('claude')?.plan, last.get('claude')?.renewsAt], [40, undefined, undefined], 'and not after a restart');
    // Claude Code's own copy for the account the last read named, B, between reads or while gated: its usage replaces
    // A's still on screen (that read failed) rather than mixing with it, and A's plan and date stay gone.
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    last.set('claude', { ...lapsing, plan: 'Max', renewsAt: ahead, renewsFor: 'a' });
    gate.set('claude', Date.now() + 60_000);
    let copy = { rows: [{ label: 'Weekly', percent: 55, resetsAt: soon }], updatedAt: Date.now(), renewsFor: 'b' };
    claude.readLocal = () => copy;
    try {
      await readOne(claude, true);
      assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').plan, last.get('claude').renewsAt, last.get('claude').renewsFor, last.get('claude').apiCredit], [55, undefined, undefined, 'b', lapsing.apiCredit], "the signed-in account's local copy, with the Console's credit still");
      last.set('claude', { ...lapsing, plan: 'Max', renewsAt: ahead, renewsFor: 'b' });
      await readOne(claude, true);
      assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').plan, last.get('claude').renewsAt], [55, 'Max', ahead], 'the same account\'s keeps them');
      // A copy for anyone else (~/.claude.json still names A after B's token came) is left alone: B's plan, date and
      // numbers stay. Before any read, the reading's own account is the one signed in.
      last.set('claude', { ...lapsing, plan: 'Max', renewsAt: ahead, renewsFor: 'b' });
      copy = { rows: [{ label: 'Weekly', percent: 90, resetsAt: soon }], updatedAt: Date.now(), renewsFor: 'a' };
      await readOne(claude, true);
      assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').plan, last.get('claude').renewsAt, last.get('claude').renewsFor], [40, 'Max', ahead, 'b'], "a copy for an account not signed in changes nothing");
      signedIn.delete('claude'); // as at a start
      await readOne(claude, true);
      assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').plan], [40, 'Max'], 'nor before any read');
      // A reading saved before readings named their account (an upgrade) can't be shown to be the copy's: replaced.
      last.set('claude', { ...lapsing, plan: 'Max', renewsAt: ahead });
      copy = { rows: [{ label: 'Weekly', percent: 55, resetsAt: soon }], updatedAt: Date.now(), renewsFor: 'b' };
      await readOne(claude, true);
      assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').plan, last.get('claude').renewsAt, last.get('claude').renewsFor], [55, undefined, undefined, 'b'], 'an untagged reading gives way to a copy that names its account');
      assert.strictEqual(savedCache().claude.plan, undefined, 'on disk too');

      // Signed in to B since A's 90% of the same week: B's 20% is never merged up to 90, nor announced as a reset,
      // whether B's read answers or fails and B's copy lands. A reset within one account still beeps.
      gate.delete('claude');
      const sent = [];
      setWin({ isDestroyed: () => false, webContents: { send: (ch, v) => sent.push([ch, v]) } });
      beeps.length = 0;
      const week = (percent, resetsAt = soon) => ({ rows: [{ label: 'Weekly', percent, resetsAt }], updatedAt: Date.now() });
      last.set('claude', { ...week(90), plan: 'Max', renewsFor: 'a' });
      held.read = async () => ({ error: 'HTTP 503', soft: true, renewsFor: 'b' });
      copy = { ...week(20), renewsFor: 'b' };
      await readOne(claude, true);
      assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').renewsFor, beeps.length], [20, 'b', 0], "B's failed read: B's copy, not A's higher number, and no reset");
      last.set('claude', { ...week(90), plan: 'Max', renewsFor: 'a' });
      held.read = async () => ({ ...week(20), plan: 'Pro', renewsFor: 'b' });
      await readOne(claude, true);
      assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').plan, beeps.length], [20, 'Pro', 0], "B's read: no reset from A's 90% to B's 20%");
      held.read = async () => ({ ...week(1, new Date(Date.now() + 7 * 86_400_000).toISOString()), plan: 'Pro', renewsFor: 'b' });
      await readOne(claude, true);
      assert.strictEqual(beeps.length, 1, "B's own new week is a reset");
      // A new token whose usage and profile both fail (accountUnknown): the plan and date go, but copies for the account
      // last known go on landing, as they must through a 429 when Claude Code rotates the token.
      last.set('claude', { ...week(30), plan: 'Pro', renewsFor: 'b' });
      held.read = async () => ({ error: 'Rate limited', soft: true, retryAfter: 30, renewsFor: 'm', accountUnknown: true });
      copy = { ...week(35), updatedAt: Date.now() + 1, renewsFor: 'b' };
      await readOne(claude, true);
      assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').plan, signedIn.get('claude')], [35, undefined, 'b'], 'a read that knows no account leaves the copies to the last one known');
      gate.delete('claude');
      setWin(null);

      // The same rotation with the usage answering and only the profile failing, through the real provider and Claude
      // Code's file: the usage shows without the plan or date, and between reads a newer copy for the account last
      // confirmed lands, while an older one or another account's doesn't. After a restart the reading saved names that
      // account. Fresh tokens and module, so no profile is on hand from the checks above.
      loadCodex(codexHome, codexHome);
      const real = require('./providers').PROVIDERS.find((p) => p.id === 'claude');
      const creds = path.join(codexHome, '.claude', '.credentials.json');
      const config = path.join(codexHome, '.claude.json');
      const credsWas = fs.readFileSync(creds);
      const fetchWas = global.fetch;
      let t = deadline;
      Date.now = () => t;
      let usage = 10;
      let profileUp = true;
      global.fetch = async (url) => {
        if (!url.endsWith('/profile')) return { ok: true, json: async () => ({ limits: [{ kind: 'session', percent: usage, resets_at: soon }] }) };
        if (!profileUp) return { ok: false, status: 503, headers: new Headers() };
        return { ok: true, json: async () => ({ account: { uuid: 'account-a' }, organization: { uuid: 'org-a', rate_limit_tier: 'default_claude_max_5x', billing_type: 'stripe_subscription', subscription_status: 'active', subscription_created_at: '2026-01-05T10:00:00Z' } }) };
      };
      const useToken = (token) => fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
      const localCopy = (account, percent, at) => fs.writeFileSync(config, JSON.stringify({ oauthAccount: { accountUuid: account, organizationUuid: 'org-a' }, cachedUsageUtilization: { fetchedAtMs: at, accountUuid: account, utilization: { limits: [{ kind: 'session', percent, resets_at: soon }] } } }));
      const shows = () => [last.get('claude').rows[0].percent, last.get('claude').plan, last.get('claude').renewsAt];
      try {
        held.read = real.read;
        claude.readLocal = real.readLocal;
        claude.everyMs = 5 * 60_000;
        last.delete('claude');
        signedIn.delete('claude');
        useToken('token-rotating-1');
        await readOne(claude, true);
        const a = last.get('claude');
        assert.ok(a.rows[0].percent === 10 && a.plan === 'Max' && a.renewsAt > t && signedIn.get('claude') === a.renewsFor, "A's token, its profile confirmed");
        t += 60_000;
        useToken('token-rotating-2');
        profileUp = false;
        usage = 20;
        await readOne(claude, true);
        assert.deepStrictEqual([...shows(), signedIn.get('claude'), shownClaude().accountUnknown], [20, '', undefined, a.renewsFor, undefined], "the rotated token's usage without A's plan or date, and A still signed in");
        on['will-quit']();
        assert.strictEqual(saved().cache.claude.accountUnknown, true, 'the unverified reading reaches disk');
        last.clear();
        signedIn.clear();
        loadState();
        assert.deepStrictEqual([shows()[0], signedIn.get('claude')], [20, a.renewsFor], 'a saved unverified reading keeps the last confirmed identity through loadState');
        useToken('token-rotating-after-restart');
        await readOne(claude, true);
        localCopy('account-a', 15, t - 30_000);
        await readOne(claude);
        assert.strictEqual(shows()[0], 20, "A's copy from before that read doesn't roll it back");
        t += 60_000;
        localCopy('account-b', 90, t);
        await readOne(claude);
        assert.strictEqual(shows()[0], 20, "another account's copy stays out, though newer");
        localCopy('account-a', 30, t);
        await readOne(claude);
        assert.deepStrictEqual([...shows(), last.get('claude').renewsFor], [30, undefined, undefined, a.renewsFor], "A's newer copy lands between reads");
        signedIn.delete('claude'); // a restart, with A's reading saved
        useToken('token-rotating-3');
        usage = 25;
        await readOne(claude, true);
        t += 60_000;
        localCopy('account-a', 35, t);
        await readOne(claude);
        assert.deepStrictEqual([shows()[0], signedIn.get('claude')], [35, a.renewsFor], 'after a restart too');
        profileUp = true;
        await readOne(claude, true);
        assert.deepStrictEqual([shows()[1], signedIn.get('claude')], ['Max', a.renewsFor], 'until the profile answers');
      } finally {
        global.fetch = fetchWas;
        fs.writeFileSync(creds, credsWas);
        fs.rmSync(config, { force: true });
        claude.everyMs = 0;
        Date.now = () => deadline;
      }
    } finally {
      claude.readLocal = undefined;
      setWin(null);
    }
    // A reading saved before readings named their account: a read that names one and fails (a 429 here) drops its
    // plan and date, on screen and on disk, since they can't be shown to be this account's. Codex's stay, as before.
    gate.delete('claude');
    last.set('claude', { ...lapsing, plan: 'Max', renewsAt: ahead });
    savedCache().claude = last.get('claude');
    held.read = async () => ({ error: 'Rate limited', soft: true, retryAfter: 30, renewsFor: 'b' });
    await readOne(claude, true);
    assert.deepStrictEqual([last.get('claude').rows[0].percent, last.get('claude').plan, last.get('claude').renewsAt, savedCache().claude.plan, savedCache().claude.renewsAt], [40, undefined, undefined, undefined, undefined], 'an untagged reading loses its plan and date to a failed read that names an account');
    gate.delete('claude');
    const codex = { id: 'codex', name: 'Codex', everyMs: 0, read: async () => ({ error: 'HTTP 503', soft: true, renewsFor: 'b' }) };
    last.set('codex', { rows: [{ label: 'Weekly', percent: 12 }], plan: 'Plus', renewsAt: ahead, updatedAt: 1 });
    await readOne(codex, true);
    assert.deepStrictEqual([last.get('codex').plan, last.get('codex').renewsAt], ['Plus', ahead], "an untagged Codex reading keeps them");
    last.delete('codex');

    gate.delete('claude');
    assert.strictEqual(await carried({ renewsAt: ahead, renewsFor: 'a', updatedAt: 10 }, { why: 'Live refresh failed.', updatedAt: 5, renewsFor: 'b' }), undefined, 'another account\'s older fallback');
    assert.strictEqual(last.get('claude').updatedAt, 10, 'which still keeps the newer numbers');
    assert.strictEqual(await carried({ renewsAt: ahead, renewsFor: 'a' }, { why: 'Live refresh unavailable.', updatedAt: 8 }), ahead, 'a read that can\'t tell whose keeps it');
    assert.strictEqual(last.get('claude').renewsFor, 'a', 'and whose it is');
    last.set('claude', { ...lapsing, renewsAt: ahead, renewsFor: 'a' });
    assert.deepStrictEqual([shownClaude().renewsAt, shownClaude().renewsFor], [ahead, undefined], 'whose date it is stays in main');

    // The same reading and gate restored at startup, with a Console session that decrypts.
    saveState({ cache: { claude: lapsing }, gate: { claude: deadline + 3_600_000 }, consoleSession: Buffer.from('sk-ant-sid01-synthetic').toString('base64') });
    on['will-quit']();
    for (const [at, want] of [[deadline - 60_000, lapsing.apiCredit], [deadline + 60_000, { expired: true, expiresAt: deadline }]]) {
      Date.now = () => at;
      last.clear();
      gate.clear();
      loadState();
      assert.deepStrictEqual([shownClaude().apiCredit, shownClaude().rows[0].percent, gate.get('claude')], [want, 40, deadline + 3_600_000], `restored at ${new Date(at).toISOString()}`);
    }

    // A Console session key pasted from the tray menu, though Electron 44 made reading the clipboard asynchronous:
    // it is saved sealed, and taken off the clipboard.
    Date.now = realNow;
    await pasteConsoleKey();
    on['will-quit']();
    assert.deepStrictEqual([Buffer.from(saved().consoleSession, 'base64').toString(), clipboardCleared], ['sk-ant-sid01-pasted', true], 'a pasted Console session key is saved sealed, and leaves the clipboard');
  } finally {
    Date.now = realNow;
    on['will-quit']?.(); // flush before the folder goes, or a pending save recreates it
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- link.js: a gateway that answers the PC's link but never finishes a line of the handshake is cut off,
// whether it floods or trickles, while a phone that proves itself waits on past that deadline. Stand-ins on
// loopback ports of their own, since the link's 7499 may be taken.
async function linkChecks() {
  const net = require('net');
  const link = require('./link');
  const key = 'f'.repeat(64); // made up: the real shared secret never enters a check
  const servers = [];
  const listen = (onConnection) => new Promise((resolve) => {
    const server = net.createServer((s) => onConnection(s.on('error', () => {})));
    servers.push(server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  });
  const settle = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('pending'), ms))]);
  const gateway = async (bytes, everyMs) => {
    let closed;
    const port = await listen((s) => {
      const timer = setInterval(() => s.write(bytes), everyMs);
      closed = new Promise((r) => s.on('close', () => r(clearInterval(timer))));
    });
    return { port, closed: () => closed };
  };
  const flood = await gateway('x'.repeat(1024), 1);
  const trickle = await gateway('x', 100);
  let proven;
  const phone = await listen((s) => {
    proven = s;
    const nonce = 'a'.repeat(32);
    s.write(`LINK1 ${nonce}\n`);
    s.once('data', (hello) => {
      const [name, theirs] = String(hello).trim().split(' ');
      s.write(`${link.hmac(key, `phone|${name}|${nonce}|${theirs}`)}\n`);
    });
  });
  const realConnect = net.connect;
  let to;
  net.connect = (opts, ...rest) => realConnect({ ...opts, port: opts.port === link.PORT ? to : opts.port }, ...rest);
  const connect = (port) => ((to = port), link.connect('127.0.0.1', 'overlay', 1, key, () => {}));
  try {
    const [flooded, trickled, proved] = [connect(flood.port), connect(trickle.port), connect(phone)];
    assert.strictEqual(await settle(proved, 1000), true, 'a phone that proves itself is taken');
    assert.strictEqual(await settle(flooded, 1000), false, 'a flood with no line is refused before it piles up');
    assert.notStrictEqual(await settle(flood.closed(), 1000), 'pending', 'and its connection closed');
    assert.strictEqual(await settle(trickled, 4500), false, 'a trickle that never proves itself is refused at the deadline');
    assert.notStrictEqual(await settle(trickle.closed(), 1000), 'pending', 'and its connection closed');
    const pong = new Promise((r) => proven.once('data', (d) => r(String(d))));
    proven.write('P\n');
    assert.strictEqual(await settle(pong, 1000), 'P\n', 'the proven connection still waits past that deadline');
  } finally {
    net.connect = realConnect;
    proven?.destroy();
    for (const server of servers) server.close();
  }
}

// A made-up `tailscale` that answers as told and records what it was asked. Its backend stops on down and runs
// again on an up that works, as the real one's does. A ping's answer can be a function, called as it's asked, and
// `o.downHeld` a promise its down waits on.
const tailnetPhone = { OS: 'android', Online: true, UserID: 1, TailscaleIPs: ['100.1.1.1'] };
function fakeTailscale({ peers = [tailnetPhone], failedUps = 0, ...o } = {}) {
  o = { backend: 'Running', tsmp: false, relay: true, ...o };
  const asked = [];
  const run = async (args) => {
    asked.push(args[0]);
    if (args[0] === 'status') return JSON.stringify({ BackendState: o.backend, Self: { UserID: 1 }, Peer: { ...peers } });
    if (args[0] === 'ping') {
      const answer = args[1] === '--tsmp' ? o.tsmp : o.relay;
      return (await (typeof answer === 'function' ? answer() : answer)) ? 'pong' : null;
    }
    if (args[0] === 'down') await o.downHeld;
    if (args[0] === 'up' && failedUps-- > 0) return null;
    if (args[0] === 'down' || args[0] === 'up') o.backend = args[0] === 'down' ? 'Stopped' : 'Running';
    return '';
  };
  return { o, run, reconnects: () => asked.filter((a) => a === 'down' || a === 'up') };
}

// --- link.js heal(): Tailscale reconnects on this PC only for a tunnel frozen 90 s while the phone still answers
// through the relay, once per 10 minutes at most, and never while it works, the phone is away or Tailscale is off.
async function healChecks() {
  const { heal } = require('./link');
  const phone = tailnetPhone;
  const tailscale = fakeTailscale;
  const t = 1_000_000_000;
  const looks = async (ts, ...at) => {
    const w = { frozenAt: 0, fixedAt: 0 };
    const seen = [];
    for (const dt of at) seen.push(await heal(w, ts.run, t + dt));
    return seen;
  };

  const frozen = tailscale();
  assert.deepStrictEqual(await looks(frozen, 0, 89_000), ['frozen', 'frozen'], 'the phone answers the relay, not the tunnel');
  assert.deepStrictEqual(frozen.reconnects(), [], 'frozen under 90 s: left alone');
  const fixed = tailscale();
  await looks(fixed, 0, 90_000, 200_000, 600_000);
  assert.deepStrictEqual(fixed.reconnects(), ['down', 'up'], 'frozen 90 s: down and up, then nothing for 10 minutes');
  const again = tailscale();
  await looks(again, 0, 90_000, 690_000);
  assert.deepStrictEqual(again.reconnects(), ['down', 'up', 'down', 'up'], 'still frozen 10 minutes on: once more');
  const stubborn = tailscale({ failedUps: 1 });
  await looks(stubborn, 0, 90_000);
  assert.deepStrictEqual(stubborn.reconnects(), ['down', 'up', 'up'], 'an up that fails is tried again');
  const lost = tailscale({ failedUps: 3 });
  const lw = { frozenAt: 0, fixedAt: 0 };
  for (const dt of [0, 90_000, 105_000, 120_000]) await heal(lw, lost.run, t + dt);
  assert.deepStrictEqual(lost.reconnects(), ['down', 'up', 'up', 'up', 'up'], 'its own down, both ups failed: up on every look until one works');
  assert.strictEqual(lost.o.backend, 'Running', 'and Tailscale runs again');
  lost.o.backend = 'Stopped'; // the user turns it off
  for (const dt of [135_000, 700_000]) await heal(lw, lost.run, t + dt);
  assert.strictEqual(lost.reconnects().length, 5, 'turned off by the user after that: left alone');
  let relays = 0;
  const off = tailscale({ relay: () => (++relays === 2 && (off.o.backend = 'Stopped'), true) });
  assert.deepStrictEqual(await looks(off, 0, 90_000), ['frozen', 'frozen'], 'the second look saw it frozen');
  assert.deepStrictEqual(off.reconnects(), [], 'turned off by the user while that look pinged: left off');
  const booting = tailscale({ backend: 'NoState' });
  await heal({ frozenAt: 0, fixedAt: 0, down: true }, booting.run, t);
  assert.deepStrictEqual(booting.reconnects(), ['up'], 'its own down, and tailscaled still starting: up all the same');
  const back = tailscale();
  const bw = { frozenAt: 0, fixedAt: 0 };
  await heal(bw, back.run, t);
  let statuses = 0;
  const proofDuringRecheck = (args) => (args[0] === 'status' && ++statuses === 2 && (bw.frozenAt = 0), back.run(args));
  await heal(bw, proofDuringRecheck, t + 90_000);
  assert.deepStrictEqual(back.reconnects(), [], 'back on the hotspot while it read the status again: no reconnect');
  const blip = tailscale();
  const w = { frozenAt: 0, fixedAt: 0 };
  await heal(w, blip.run, t);
  await heal(w, tailscale({ tsmp: true }).run, t + 60_000);
  await heal(w, blip.run, t + 100_000);
  await heal(w, blip.run, t + 180_000);
  assert.deepStrictEqual(blip.reconnects(), [], 'a look that gets through starts the 90 s over');
  for (const [what, ts, state] of [
    ['working', tailscale({ tsmp: true }), 'ok'],
    ['the phone away', tailscale({ relay: false }), 'away'],
    ['Tailscale off on this PC', tailscale({ backend: 'Stopped' }), 'away'],
    ['the phone offline', tailscale({ peers: [{ ...phone, Online: false }] }), 'away'],
    ["someone else's phone", tailscale({ peers: [{ ...phone, UserID: 2 }] }), 'away'],
    ['no tailscale', { run: async () => null, reconnects: () => [] }, 'away'],
  ]) {
    assert.deepStrictEqual(await looks(ts, 0, 90_000, 700_000), [state, state, state], `${what}: seen as ${state}`);
    assert.deepStrictEqual(ts.reconnects(), [], `${what}: no reconnect`);
  }
}

// --- link.js start(): the watcher as the overlay runs it, with a stand-in phone on loopback, a made-up `tailscale`
// and a clock the check moves. The check fires the 15 s look itself. A fresh copy of link.js keeps its secret, and
// anything else it keeps on disk, in a folder of the check's own, so the real ones are never read or written.
async function startChecks() {
  const cp = require('child_process');
  const net = require('net');
  const real = { setInterval, now: Date.now, execFile: cp.execFile, connect: net.connect, local: process.env.LOCALAPPDATA, gw: process.env.LINK_GATEWAY };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-overlay-link-'));
  let ts, watch, to, server;
  let clock = Date.now();
  let sockets = [];
  let pongs = 0;
  const until = async (fn, what) => {
    for (const end = real.now() + 5000; ; await new Promise((r) => setTimeout(r, 10))) {
      const v = fn();
      if (v) return v;
      if (real.now() > end) throw new Error(`timed out waiting for ${what}`);
    }
  };
  process.env.LOCALAPPDATA = dir;
  process.env.LINK_GATEWAY = '127.0.0.1';
  // A copy of link.js as a new process would load it, taking the made-up execFile and the check's folder.
  const fresh = () => {
    cp.execFile = (cmd, args, opts, cb) => void ts.run(args).then((out) => cb(out === null ? new Error('exit 1') : null, out ?? ''));
    delete require.cache[require.resolve('./link')];
    try {
      return require('./link');
    } finally {
      cp.execFile = real.execFile;
    }
  };
  const link = fresh();
  const key = link.secret();
  net.connect = (opts, ...rest) => real.connect({ ...opts, port: opts.port === link.PORT ? to : opts.port }, ...rest);
  Date.now = () => clock;
  // The phone's hotspot. The PC on it: six connections proven, each one's P answered, so the PC has counted it.
  const hotspot = async () => {
    server = net.createServer((s) => {
      sockets.push(s.on('error', () => {}));
      const nonce = 'b'.repeat(32);
      s.write(`LINK1 ${nonce}\n`);
      s.once('data', (hello) => {
        const [name, theirs] = String(hello).trim().split(' ');
        s.write(`${link.hmac(key, `phone|${name}|${nonce}|${theirs}`)}\nP\n`);
        s.once('data', () => pongs++);
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    [to, pongs] = [server.address().port, 0];
  };
  // A round that failed while the clock stood still waits 5 s on it: the clock moves on while the phone comes back.
  const joined = () => until(() => ((clock += 1000), pongs === 6), 'six proven connections');
  const join = () => hotspot().then(joined);
  // Off it: nothing listens any more, and what waited is gone.
  const leave = () => {
    server?.close();
    sockets.forEach((s) => s.destroy());
    sockets = [];
  };
  const watched = async (fake, steps) => {
    ts = fakeTailscale(fake);
    await hotspot();
    global.setInterval = (fn, ms) => real.setInterval(ms === 15_000 ? ((watch = fn), () => {}) : fn, ms);
    let stop;
    try {
      stop = link.start('overlay', 1);
    } finally {
      global.setInterval = real.setInterval;
    }
    try {
      await joined();
      leave();
      await until(() => watch(), 'the first look off the hotspot'); // frozen from here
      await steps();
    } finally {
      stop();
      leave();
    }
  };
  const restore = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  try {
    await watched({ failedUps: 2 }, async () => {
      clock += 90_000;
      await watch(); // down, and both ups fail
      assert.strictEqual(ts.o.backend, 'Stopped', 'both ups failed');
      await join();
      await watch();
      assert.strictEqual(ts.o.backend, 'Running', 'its own down is undone on the hotspot too');
    });
    await watched({}, async () => {
      clock += 90_000;
      let release;
      const asked = new Promise((r) => (ts.o.tsmp = () => (r(), new Promise((go) => (release = go)))));
      const look = watch();
      await asked;
      await join(); // back on the hotspot while the look's ping is still out
      release(false);
      await look;
      assert.deepStrictEqual(ts.reconnects(), [], 'back on the hotspot during a look: no reconnect');
    });

    // The overlay as Electron runs it, each launch a new process: main.js with its own fresh link.js, and an Electron
    // whose window, tray and screen take any call. main.js's own timers stand still; the link's run.
    const anything = new Proxy(function () {}, {
      get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : k === 'then' ? undefined : anything),
      apply: () => anything,
      construct: () => anything,
    });
    const launch = async () => {
      const own = fresh();
      const on = {};
      let exited;
      const exit = new Promise((r) => (exited = r));
      const app = { commandLine: anything, requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on: (e, fn) => (on[e] = fn), getPath: () => dir, quit() {}, exit: exited };
      const electron = new Proxy({ app }, { get: (t, k) => t[k] ?? anything });
      const start = (...args) => {
        global.setInterval = (fn, ms) => real.setInterval(ms === 15_000 ? ((watch = fn), () => {}) : fn, ms);
        try {
          return own.start(...args);
        } finally {
          global.setInterval = still;
        }
      };
      const still = (fn, ms) => real.setInterval(() => {}, ms);
      global.setInterval = still;
      watch = null;
      try {
        const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
        const deps = { electron, http: { createServer: () => anything }, './link': { ...own, start } };
        new Function('require', 'module', '__dirname', src)((id) => deps[id] ?? require(id), { exports: {} }, __dirname);
        await until(() => watch, 'the link started on ready');
      } finally {
        global.setInterval = real.setInterval;
      }
      // Electron's quit: true when main.js held it back.
      const quit = () => {
        let held = false;
        on['will-quit']({ preventDefault: () => (held = true) });
        return held;
      };
      return { quit, exit };
    };
    // On the hotspot, off it, frozen for 90 s, and the look that reconnects run as far as its down.
    const toDown = async () => {
      await joined();
      leave();
      await until(() => watch(), 'the first look off the hotspot');
      clock += 90_000;
      const look = watch();
      await until(() => ts.reconnects().includes('down'), 'the down');
      await new Promise((r) => setImmediate(r)); // and its answer, unless it's held
      return { look }; // not the look itself, which an await would wait out
    };

    ts = fakeTailscale();
    await hotspot();
    let overlay = await launch();
    let { look } = await toDown();
    assert.strictEqual(ts.o.backend, 'Stopped', 'its down done, its up 3 s off');
    assert.strictEqual(overlay.quit(), true, 'quitting then waits');
    await overlay.exit;
    assert.strictEqual(ts.o.backend, 'Running', 'for an up, before the overlay exits');
    await look; // its own up, 3 s on, from a process that would be gone
    leave();

    let downs;
    ts = fakeTailscale({ downHeld: new Promise((r) => (downs = r)) });
    await hotspot();
    overlay = await launch();
    ({ look } = await toDown());
    assert.strictEqual(overlay.quit(), true, 'quitting while its down is still out waits too');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(ts.reconnects(), ['down'], 'with no up before the down has answered');
    downs();
    await overlay.exit;
    assert.strictEqual(ts.o.backend, 'Running', 'and the up after it');
    await look;
    leave();

    ts = fakeTailscale({ failedUps: 3 });
    await hotspot();
    overlay = await launch();
    ({ look } = await toDown());
    assert.strictEqual(overlay.quit(), true, 'its down done');
    await overlay.exit; // the quit's up fails, and the quit still ends
    await look; // as do the look's own two
    assert.strictEqual(ts.o.backend, 'Stopped', 'every up failed: Tailscale is off');
    leave();
    overlay = await launch(); // the next start, after a quit or a crash between down and up alike
    await until(() => watch(), 'its first look');
    assert.strictEqual(ts.o.backend, 'Running', 'brings Tailscale back');
    assert.strictEqual(overlay.quit(), false, 'and quits at once after that');

    ts = fakeTailscale();
    await hotspot();
    overlay = await launch();
    await joined();
    leave();
    await until(() => watch(), 'the first look off the hotspot');
    clock += 90_000;
    let release;
    const asked = new Promise((r) => (ts.o.tsmp = () => (r(), new Promise((go) => (release = go)))));
    look = watch();
    await asked;
    assert.strictEqual(overlay.quit(), false, 'quitting while a look pings, with no down of its own yet: at once');
    release(false);
    await look;
    assert.deepStrictEqual(ts.reconnects(), [], 'and that look reconnects nothing after it');
    leave();

    ts = fakeTailscale({ backend: 'Stopped' });
    overlay = await launch();
    assert.strictEqual(watch(), undefined, 'Tailscale the user turned off, and no down of its own: no look');
    assert.strictEqual(overlay.quit(), false, 'quit at once');
    assert.deepStrictEqual(ts.reconnects(), [], 'and no up');
  } finally {
    Date.now = real.now;
    net.connect = real.connect;
    restore('LOCALAPPDATA', real.local);
    restore('LINK_GATEWAY', real.gw);
    delete require.cache[require.resolve('./link')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
