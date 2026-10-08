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

// providers.js reads its paths once, at require. Orca's root is set too, or the test reads the real one.
function loadCodex(home, orca) {
  const saved = { CODEX_HOME: process.env.CODEX_HOME, ORCA_CODEX_HOME: process.env.ORCA_CODEX_HOME };
  const homedir = os.homedir;
  Object.assign(process.env, { CODEX_HOME: home, ORCA_CODEX_HOME: orca });
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
  .then(mainChecks)
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
  };
  // The phone's HTTP handler is caught as main.js hands it to http, so no port opens: the installed overlay may hold 7430.
  let phoneHandler = null;
  const http = { createServer: (fn) => ((phoneHandler = fn), { on() { return this; }, listen() { return this; } }) };
  // One provider whose read the checks hold and finish by hand; no real account is ever asked.
  const held = { read: async () => ({ rows: [] }) };
  const providers = { ...require('./providers'), PROVIDERS: [{ id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', everyMs: 0, read: () => held.read() }] };
  const mod = { exports: {} };
  const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') + '\nmodule.exports = { readOne, saveState, gate, last, servePhone };';
  new Function('require', 'module', '__dirname', src)((id) => (id === 'electron' ? electron : id === 'http' ? http : id === './providers' ? providers : require(id)), mod, __dirname);
  const { readOne, saveState, gate, last, servePhone } = mod.exports;
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
  } finally {
    Date.now = realNow;
    on['will-quit']?.(); // flush before the folder goes, or a pending save recreates it
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
