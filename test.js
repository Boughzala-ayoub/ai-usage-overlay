'use strict';
// Pure-logic checks. No electron, no network: node test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shapeClaude, shapeCodex, shapeCodexUsage, shapeCodexResetCredits, shapeOpenCodeGo, fmtReset, windowLabel, ringPercent, resetRows, lastRateLimits } = require('./providers');

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

// A reset is observed from provider data, not inferred from its estimated reset time.
assert.deepStrictEqual(
  resetRows(
    [{ label: 'Session', percent: 82 }, { label: 'Weekly', percent: 10 }],
    [{ label: 'Session', percent: 3 }, { label: 'Weekly', percent: 11 }, { label: 'New', percent: 0 }]
  ).map((r) => r.label),
  ['Session']
);

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
    JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 9, window_minutes: 300 } } } }) + '\n'
);
assert.strictEqual(lastRateLimits(tmp).primary.used_percent, 9);
fs.unlinkSync(tmp);
assert.strictEqual(lastRateLimits(path.join(os.tmpdir(), 'nope.jsonl')), null);

// Codex and Orca select isolated session trees through CODEX_HOME.
const codexHome = path.join(os.tmpdir(), 'usage-overlay-codex-home');
const rolloutDir = path.join(codexHome, 'sessions', '2026', '08', '30');
fs.mkdirSync(rolloutDir, { recursive: true });
fs.writeFileSync(
  path.join(rolloutDir, 'rollout-test.jsonl'),
  JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 77, window_minutes: 10080 } } } }) + '\n'
);
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = codexHome;
const originalHomedir = os.homedir;
os.homedir = () => codexHome;
delete require.cache[require.resolve('./providers')];
const configuredProvider = require('./providers').PROVIDERS.find((p) => p.id === 'codex');
os.homedir = originalHomedir;
if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
else process.env.CODEX_HOME = previousCodexHome;
configuredProvider.read()
  .then((configured) => assert.strictEqual(configured.rows[0].percent, 77, 'Codex usage follows CODEX_HOME'))
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
    const originalFetch = global.fetch;
    const originalKey = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'test-key';
    const networkError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    try {
      for (const provider of require('./providers').PROVIDERS) {
        let calls = 0;
        let mode = 'recover';
        global.fetch = async (url, options) => {
          assert.ok(options.signal instanceof AbortSignal, 'every provider request has a deadline');
          if (url.endsWith('/profile')) return { ok: true, json: async () => ({}) };
          calls++;
          if (mode === 'offline' || (mode === 'recover' && calls === 1)) throw networkError();
          if (mode === 'timeout') return { ok: true, json: async () => { throw new DOMException('deadline', 'TimeoutError'); } };
          if (mode === '429' || mode === '401') return { ok: false, status: Number(mode), headers: new Headers({ 'retry-after': '120' }) };
          return { ok: true, json: async () => ({
            limits: [{ kind: 'session', percent: 12 }],
            rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } },
            usage: { rolling: { percent: 12 } },
          }) };
        };
        const recovered = await provider.read();
        assert.strictEqual(recovered.rows?.[0]?.percent, 12, `${provider.id} recovers from a transient fetch failure`);
        assert.strictEqual(calls, 2, 'one retry after a transport failure');
        for (mode of ['offline', 'timeout', '429', '401']) {
          calls = 0;
          const result = await provider.read();
          assert.strictEqual(calls, mode === 'offline' || mode === 'timeout' ? 2 : 1, 'bounded retry, never retry HTTP errors');
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
      if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = originalKey;
    }
  })
  .then(() => console.log('ok'))
  .finally(() => fs.rmSync(codexHome, { recursive: true, force: true }));
