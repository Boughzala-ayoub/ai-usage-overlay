'use strict';
// Pure-logic checks. No electron, no network: node test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shapeApiCredit, creditExpired, shapeClaude, shapeCodex, shapeCodexUsage, shapeCodexResetCredits, shapeOpenCodeGo, shapeXai, fmtReset, windowLabel, ringPercent, resetRows, lastRateLimits } = require('./providers');

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
assert.strictEqual(claude.plan, 'Max 5x');
assert.deepStrictEqual(
  claude.rows.map((r) => [r.label, r.percent]),
  [['Session', 6], ['All models', 100], ['Fable', 14]]
);
assert.strictEqual(ringPercent(claude.rows, 'Session'), 6);
assert.strictEqual(ringPercent(claude.rows, 'All models'), 100);
assert.strictEqual(ringPercent(claude.rows, 'Fable'), 14);
assert.strictEqual(ringPercent(claude.rows, ''), 100, 'no selection keeps the highest-limit default');
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
    let mode = 'ok';
    global.fetch = async (url, options) => {
      assert.strictEqual(options.headers.Authorization, 'Bearer test-token', 'Codex login comes only from ~/.codex, ignoring CODEX_HOME and Orca');
      if (url.endsWith('/usage')) return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 604800 } }, rate_limit_reset_credits: { available_count: 1 } }) };
      detailCalls++;
      if (mode === 'error') throw new Error('Offline');
      if (mode === 'throttled') return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
      return { ok: true, json: async () => ({ credits: [{ status: 'available', expires_at: '2026-10-04T05:36:14Z' }] }) };
    };
    try {
      assert.deepStrictEqual((await configuredProvider.read()).bankedResetExpiries, [Date.parse('2026-10-04T05:36:14Z')]);
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
      for (const provider of require('./providers').PROVIDERS) {
        let calls = 0;
        let mode = 'recover';
        global.fetch = async (url, options) => {
          assert.ok(options.signal instanceof AbortSignal, 'every provider request has a deadline');
          if (url.endsWith('/profile') || url.endsWith('format=credits')) return { ok: true, json: async () => ({}) };
          calls++;
          if (mode === 'offline' || (mode === 'recover' && calls === 1)) throw networkError();
          if (mode === 'timeout') return { ok: true, json: async () => { throw new DOMException('deadline', 'TimeoutError'); } };
          // What held Claude's read for 12 hours on 2026-10-29: a request that never answers, deaf to its signal.
          if (mode === 'lost') return new Promise(() => {});
          if (mode === '429' || mode === '401') return { ok: false, status: Number(mode), headers: new Headers({ 'retry-after': '120' }) };
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
        for (mode of ['offline', 'timeout', 'lost', '429', '401']) {
          calls = 0;
          const result = await settles(provider.read(), `${provider.id} ${mode}`);
          assert.strictEqual(calls, ['offline', 'timeout', 'lost'].includes(mode) ? 2 : 1, 'bounded retry, never retry HTTP errors');
          if (mode === '429') {
            assert.strictEqual(result.retryAfter, 120);
            assert.strictEqual(result.soft, true);
          } else if (provider.id !== 'codex') {
            if (mode === '401') assert.ok(!result.soft, 'invalid credentials remain a hard error');
            else {
              assert.strictEqual(result.soft, true, 'network failures preserve the last reading');
              assert.match(result.error, mode === 'offline' ? /UND_ERR_CONNECT_TIMEOUT/ : /timed out/);
            }
          } else assert.match(result.note, /local usage/, 'Codex retains its offline fallback');
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
      assert.deepStrictEqual(weeklyLost.rows.map((r) => r.label), ['Monthly'], 'a failed weekly lookup keeps the monthly line');
      assert.strictEqual(weeklyLost.note, 'Weekly usage not refreshed (HTTP 500).', 'and says the weekly one did not refresh');
      // And the other way round, on the unified pool too: a monthly outage costs only the monthly line, a 429 still gates.
      const week96 = { config: { ...xaiWeekly.config, creditUsagePercent: 96 } };
      global.fetch = async (url) => (url.endsWith('format=credits') ? { ok: true, json: async () => week96 } : { ok: false, status: 503, headers: new Headers() });
      assert.deepStrictEqual((await xai.read()).rows?.map((r) => [r.label, r.percent]), [['Weekly', 96]], 'a failed monthly lookup keeps the weekly line');
      global.fetch = async (url) => (url.endsWith('format=credits') ? { ok: true, json: async () => week96 } : { ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) });
      assert.strictEqual((await xai.read()).retryAfter, 90, 'a throttled monthly lookup gates xAI');
      global.fetch = async (url) => ({ ok: false, status: 429, headers: new Headers(url.endsWith('format=credits') ? {} : { 'retry-after': '30' }) });
      assert.strictEqual((await xai.read()).retryAfter, 60, 'a 429 with no Retry-After counts as its 60s fallback against the other');
      // The unified weekly pool: no monthly limit, which is no outage, so the weekly lookup failing is the read failing.
      const pooled = { config: { monthlyLimit: { val: 0 }, used: { val: 0 }, billingPeriodEnd: '2026-11-01T00:00:00Z' } };
      global.fetch = async (url) => ({ ok: true, json: async () => (url.endsWith('format=credits') ? xaiWeekly : pooled) });
      const pool = await xai.read();
      assert.deepStrictEqual([pool.rows.map((r) => r.label), pool.note], [['Weekly'], undefined], 'a zero monthly limit is no outage');
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
        assert.deepStrictEqual([failed.leftCents, failed.error], [9195, 'API credit not refreshed (HTTP 503), showing the last reading.']);
        Date.now = () => Date.parse('2026-10-28T12:00:00Z');
        const lapsed = await claude.read();
        assert.deepStrictEqual(lapsed.apiCredit, { error: 'API credit not refreshed (HTTP 503).' }, 'expired funds are not shown as available');
        assert.strictEqual(lapsed.rows[0].percent, 12, 'while usage keeps refreshing');
      } finally {
        Date.now = realNow;
      }
    } finally {
      global.fetch = originalFetch;
    }
  })
  .then(mainChecks)
  .then(linkChecks)
  .then(healChecks)
  .then(startChecks)
  .then(() => console.log('ok'))
  .finally(() => fs.rmSync(codexHome, { recursive: true, force: true }));

// --- main.js polling and persistence, with Electron faked and fake providers: the paths no renderer test reaches.
async function mainChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-overlay-main-'));
  const on = {};
  const electron = {
    app: { commandLine: { appendSwitch() {} }, whenReady: () => new Promise(() => {}), on: (e, fn) => (on[e] = fn), getPath: () => dir },
    ipcMain: { on() {}, handle() {} },
    globalShortcut: { unregisterAll() {} },
    Menu: { buildFromTemplate: (template) => template },
    screen: { getAllDisplays: () => [{ id: 1 }], getPrimaryDisplay: () => ({ id: 1 }) },
    safeStorage: { decryptString: (sealed) => sealed.toString() }, // synthetic keys only, sealed as plain base64
  };
  // The phone's HTTP handler is caught as main.js hands it to http, so no port opens: the installed overlay may hold 7430.
  let phoneHandler = null;
  const http = { createServer: (fn) => ((phoneHandler = fn), { on() { return this; }, listen() { return this; } }) };
  // One provider whose read the checks hold and finish by hand; no real account is ever asked.
  const held = { read: async () => ({ rows: [] }) };
  const providers = { ...require('./providers'), PROVIDERS: [{ id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', everyMs: 0, read: () => held.read() }] };
  const mod = { exports: {} };
  // The tray only exists once the window does, which the fake app never gets to; its menu is rebuilt into nothing.
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') + '\ntray = { setContextMenu() {} };\nmodule.exports = { readOne, saveState, gate, last, servePhone, useConsoleKey, snapshot, loadState };';
  new Function('require', 'module', '__dirname', src)((id) => (id === 'electron' ? electron : id === 'http' ? http : id === './providers' ? providers : require(id)), mod, __dirname);
  const { readOne, saveState, gate, last, servePhone, useConsoleKey, snapshot, loadState } = mod.exports;
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
    await readOne(codexAt(20, 1000, { note: 'Live refresh failed; showing local usage.', why: 'Live refresh failed.' }), true);
    assert.strictEqual(last.get('codex').rows[0].percent, 80, 'an older fallback keeps the newer reading');
    assert.strictEqual(last.get('codex').note, 'Live refresh failed.', 'and says why it did not move');
    await readOne(codexAt(10, 3000, { note: 'Live refresh failed; showing local usage.', why: 'Live refresh failed.' }), true);
    assert.strictEqual(last.get('codex').rows[0].percent, 10, 'a newer fallback still lands');

    // Retry-After runs from the 429's arrival, 14s after the request left.
    let clock = realNow();
    Date.now = () => clock;
    await readOne({ id: 'claude', everyMs: 0, read: async () => ((clock += 14_000), { error: 'Rate limited', soft: true, retryAfter: 60 }) }, true);
    assert.strictEqual(gate.get('claude'), clock + 60_000, 'gate counts from receipt');
    Date.now = realNow;

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
      assert.strictEqual(last.get('xai').note, 'Rate limited', 'and says why it did not move');
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
      // One lookup failing beside one that answers: the good line lands with a note naming what didn't refresh,
      // and the note goes once both answer again.
      gate.delete('xai');
      Date.now = realNow;
      const weekly = (percent) => () => ({ ok: true, json: async () => ({ config: { ...xaiWeekly.config, creditUsagePercent: percent } }) });
      const monthly = (used) => () => ({ ok: true, json: async () => ({ config: { monthlyLimit: { val: 100 }, used: { val: used } } }) });
      [weeklyAnswer, monthlyAnswer] = [weekly(4), monthly(99)];
      await readOne(xai, true);
      [weeklyAnswer, monthlyAnswer] = [weekly(5), () => ({ ok: false, status: 503, headers: new Headers() })];
      await readOne(xai, true);
      assert.deepStrictEqual(last.get('xai').rows.map((r) => [r.label, r.percent]), [['Weekly', 5]], 'the weekly line lands');
      assert.strictEqual(last.get('xai').note, 'Monthly usage not refreshed (HTTP 503).', 'with a note saying the monthly one did not');
      monthlyAnswer = monthly(99);
      await readOne(xai, true);
      assert.deepStrictEqual([last.get('xai').rows.length, last.get('xai').note], [2, undefined], 'both back, the note goes');
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
      assert.deepStrictEqual([last.get('xai').rows?.length, last.get('xai').note, renewals], [2, 'terminated', 1], 'a renewal cut off mid-body is soft and not retried');
      assert.strictEqual(fs.readFileSync(grokFile, 'utf8'), lapsedAuth, 'and leaves auth.json as it was');
      tokenAnswer = () => ({ ok: true, json: async () => ({ refresh_token: 'r2', expires_in: 21600 }) });
      await readOne(xai, true);
      assert.deepStrictEqual([last.get('xai').rows?.length, last.get('xai').note], [2, 'Grok sign-in not renewed (no access token).'], 'an answer with no access token is soft');
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
      const app = { commandLine: anything, whenReady: () => Promise.resolve(), on: (e, fn) => (on[e] = fn), getPath: () => dir, quit() {}, exit: exited };
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
