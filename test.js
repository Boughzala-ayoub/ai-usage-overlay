'use strict';
// Pure-logic checks. No electron, no network: node test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shapeApiCredit, creditExpired, nextMonthly, shapeClaude, shapeCodexRenewal, shapeCodex, shapeCodexUsage, shapeCodexResetCredits, shapeOpenCodeGo, shapeXai, shapeAntigravity, fmtReset, windowLabel, ringPercent, resetRows, lastRateLimits, retryAfterSeconds } = require('./providers');

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

// --- Antigravity: remainingFraction inverted to used %, 5h ordered before weekly, proto3 omitted 0 treated as 100% used.
const agSummary = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9781029, resetTime: '2026-11-26T21:01:25Z' },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.96206635, resetTime: '2026-11-20T02:01:25Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-26T22:08:58Z' },
        { bucketId: '3p-5h', window: '5h', resetTime: '2026-11-20T03:08:58Z' },
      ],
    },
  ],
};
const ag = shapeAntigravity(agSummary, { currentTier: { id: 'free-tier', name: 'Antigravity' }, paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } });
assert.strictEqual(ag.plan, 'AI Ultra');
assert.deepStrictEqual(ag.rows.map((r) => [r.id, r.label, r.percent, r.resetsAt]), [
  ['gemini-5h', 'Gemini 5h', 3.8, '2026-11-20T02:01:25Z'],
  ['gemini-weekly', 'Gemini wk', 2.2, '2026-11-26T21:01:25Z'],
  ['3p-5h', 'Other 5h', 100, '2026-11-20T03:08:58Z'],
  ['3p-weekly', 'Other wk', 0, '2026-11-26T22:08:58Z'],
], '5h comes before weekly, remainingFraction becomes used %, and proto3-omitted remainingFraction with a resetTime is 100% used');
// Disabled buckets are unavailable (100% used) even when remainingFraction says 1; ProtoJSON quoted fractions parse;
// malformed fractions are skipped; epoch-0 timestamps in any ISO form count as no reset time.
const agEdge = shapeAntigravity({
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-5h', window: '5h', disabled: true, remainingFraction: 1, resetTime: '2026-11-20T02:01:25Z' },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: '0.8', resetTime: '2026-11-26T21:01:25Z' },
        { bucketId: 'exp-frac', window: '5h', remainingFraction: '5e-1', resetTime: '2026-11-20T02:01:25Z' },
        { bucketId: 'bad-nan', window: '5h', remainingFraction: 'NaN', resetTime: '2026-11-20T02:01:25Z' },
        { bucketId: 'bad-bin', window: '5h', remainingFraction: '0b0', resetTime: '2026-11-20T02:01:25Z' },
        { bucketId: 'bad-hex', window: '5h', remainingFraction: '0x1', resetTime: '2026-11-20T02:01:25Z' },
        { bucketId: 'bad-hi', window: '5h', remainingFraction: 1.5, resetTime: '2026-11-20T02:01:25Z' },
        { bucketId: 'bad-lo', window: '5h', remainingFraction: -0.2, resetTime: '2026-11-20T02:01:25Z' },
      ],
    },
    {
      displayName: 'Gemini 4 Argon',
      buckets: [
        { bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.15, resetTime: '2026-11-26T21:01:25Z' },
      ],
    },
  ],
}, null);
assert.deepStrictEqual(agEdge.rows.map((r) => [r.id, r.label, r.percent]), [
  ['gemini-5h', 'Gemini 5h', 100],
  ['exp-frac', 'exp-frac', 50],
  ['gemini-weekly', 'Gemini wk', 20],
  ['argon-weekly', 'Gemini 4 Argon wk', 85],
], 'disabled bucket is 100%, valid ProtoJSON decimal/exponent fractions parse, non-decimal/out-of-range fractions are skipped, and Argon pool stays distinct');
// Collision-safe numeric suffix: even when "Gemini wk (2)" already exists, a third collision skips to "(3)".
const collideLabels = shapeAntigravity({
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: 'weekly', remainingFraction: 0.9 },
        { displayName: 'Gemini wk (2)', window: 'other', remainingFraction: 0.8 },
        { window: 'weekly', remainingFraction: 0.7 },
      ],
    },
  ],
}, null);
assert.strictEqual(new Set(collideLabels.rows.map((r) => r.label)).size, 3, 'generated label suffixes never collide with existing labels');
// Exact bucket ID match takes precedence even when an earlier row's label equals the chosen ID.
assert.strictEqual(
  ringPercent([{ id: 'other-id', label: 'gemini-weekly', percent: 85 }, { id: 'gemini-weekly', label: 'Gemini wk', percent: 10 }], 'gemini-weekly'),
  10,
  'exact ID match beats an earlier row whose label happens to equal the ID'
);
// Duplicate bucketIds receive unique stable IDs and collision-safe labels, so two unchanged rows never trigger a false reset.
const dupBuckets = shapeAntigravity({
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.2 },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 },
      ],
    },
  ],
}, null);
assert.strictEqual(new Set(dupBuckets.rows.map((r) => r.id)).size, 2, 'duplicate bucketIds get distinct stable IDs');
assert.strictEqual(new Set(dupBuckets.rows.map((r) => r.label)).size, 2, 'and distinct labels');
assert.deepStrictEqual(resetRows(dupBuckets.rows, dupBuckets.rows), [], 'unchanged duplicate bucketIds never trigger a false reset');
// Reversing two unchanged buckets with identical qualifiers triggers no false reset, and configured choices stay
// tied to their intended pool (never falling back to an unrelated bucket like Other 5h).
const dupRev = shapeAntigravity({
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.2 },
      ],
    },
    {
      displayName: 'Other Models',
      buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.05 }],
    },
  ],
}, null);
assert.deepStrictEqual(resetRows(dupBuckets.rows, dupRev.rows), [], 'reversing identical-qualifier duplicate buckets triggers no false reset');
assert.strictEqual(ringPercent(dupRev.rows, 'gemini-weekly'), 80, 'fixed gemini-weekly choice stays tied to the gemini-weekly pool, not Other 5h (95%)');
// Reversing duplicate buckets that lack any qualifier fields must ALSO keep the pool maximum (never flipping between 10% and 80%).
const dupNoQual1 = shapeAntigravity({ groups: [{ buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.9 }, { bucketId: 'gemini-weekly', remainingFraction: 0.2 }] }] }, null);
const dupNoQual2 = shapeAntigravity({ groups: [{ buckets: [{ bucketId: 'gemini-weekly', remainingFraction: 0.2 }, { bucketId: 'gemini-weekly', remainingFraction: 0.9 }] }] }, null);
assert.ok(dupNoQual1.rows.every((r) => r.id !== 'gemini-weekly' && r.bucketId === 'gemini-weekly'), 'qualifier-less duplicates each get a distinct row ID while retaining bucketId');
assert.strictEqual(ringPercent(dupNoQual1.rows, 'gemini-weekly'), 80, 'qualifier-less duplicates select pool max (order 1)');
assert.strictEqual(ringPercent(dupNoQual2.rows, 'gemini-weekly'), 80, 'qualifier-less duplicates select pool max (order 2)');
assert.deepStrictEqual(resetRows(dupNoQual1.rows, dupNoQual2.rows), [], 'reversing qualifier-less duplicates triggers no false reset');
// Reordering two groups that share the same bucketId keeps each row's disambiguated ID stable (no false reset).
const grpAlpha = { displayName: 'Alpha Models', buckets: [{ bucketId: 'shared-wk', window: 'weekly', remainingFraction: 0.2 }] };
const grpBeta = { displayName: 'Beta Models', buckets: [{ bucketId: 'shared-wk', window: 'weekly', remainingFraction: 0.9 }] };
const dupOrder1 = shapeAntigravity({ groups: [grpAlpha, grpBeta] }, null);
const dupOrder2 = shapeAntigravity({ groups: [grpBeta, grpAlpha] }, null);
const alphaId = dupOrder1.rows.find((r) => r.percent === 80).id;
assert.strictEqual(dupOrder2.rows.find((r) => r.percent === 80).id, alphaId, 'reordering groups keeps duplicate bucketId stable');
assert.strictEqual(ringPercent(dupOrder2.rows, alphaId), 80, 'and keeps ringPercent selection on the same row');
assert.deepStrictEqual(resetRows(dupOrder1.rows, dupOrder2.rows), [], 'reordering duplicate-ID groups triggers no false reset');
// ID-less rows and ID-bearing rows occupy separate namespaces in resetRows.
assert.deepStrictEqual(
  resetRows(
    [{ label: 'gemini-weekly', percent: 85 }, { id: 'gemini-weekly', label: 'Gemini wk', percent: 10 }],
    [{ label: 'gemini-weekly', percent: 85 }, { id: 'gemini-weekly', label: 'Gemini wk', percent: 10 }]
  ),
  [],
  'an ID-less row whose label matches another row\'s ID never collides in resetRows'
);
// Round 23 Fix 3: Reordering unchanged ID-less buckets when display-label disambiguation produces "Alpha (2)"
// alongside a separate ID-less bucket literally named "Alpha (2)" must never trigger a false reset, while a real
// drop on the ID-less "Alpha" row still fires a reset.
{
  const idRow = { bucketId: 'id-1', displayName: 'Alpha', remainingFraction: 0.5 };
  const idlessAlpha = { displayName: 'Alpha', remainingFraction: 0.2 };
  const idlessAlpha2 = { displayName: 'Alpha (2)', remainingFraction: 0.9 };
  const order1 = shapeAntigravity({ groups: [{ buckets: [idRow, idlessAlpha, idlessAlpha2] }] }, null);
  const order2 = shapeAntigravity({ groups: [{ buckets: [idlessAlpha, idRow, idlessAlpha2] }] }, null);
  const order3 = shapeAntigravity({ groups: [{ buckets: [idRow, idlessAlpha2, idlessAlpha] }] }, null);
  assert.deepStrictEqual(resetRows(order1.rows, order2.rows), [], 'reordering ID-less Alpha before ID-bearing Alpha triggers no false reset');
  assert.deepStrictEqual(resetRows(order1.rows, order3.rows), [], 'reordering ID-less Alpha (2) before suffixed Alpha (2) triggers no false reset');
  assert.deepStrictEqual(resetRows(order3.rows, order1.rows), [], 'reordering back triggers no false reset');
  const dropped = shapeAntigravity({ groups: [{ buckets: [{ displayName: 'Alpha', remainingFraction: 0.95 }, idRow, idlessAlpha2] }] }, null);
  assert.strictEqual(resetRows(order1.rows, dropped.rows).length, 1, 'a genuine drop on the ID-less Alpha bucket still triggers a reset');
}
// Round 24 Fix 3: a duplicate's generated ID never takes a bucketId the answer uses literally, in either order, and
// resetRows matches each bucket by what it is (bucketId, group, window, name), not by its place among duplicates.
{
  const idOf = (rows, pct) => rows.find((r) => r.percent === pct).id;
  const alpha = { displayName: 'Alpha', buckets: [{ bucketId: 'shared', remainingFraction: 0.1 }] };
  const beta = { displayName: 'Beta', buckets: [{ bucketId: 'shared', remainingFraction: 0.8 }] };
  const bare = [{ bucketId: 'shared', remainingFraction: 0.1 }, { bucketId: 'shared', remainingFraction: 0.8 }];
  for (const literal of ['shared@Alpha', 'shared#1', 'shared#2', 'shared@Alpha#2']) {
    const gamma = { displayName: 'Gamma', buckets: [{ bucketId: literal, remainingFraction: 0.95 }] };
    const orders = [
      [shapeAntigravity({ groups: [alpha, beta, gamma] }, null).rows, shapeAntigravity({ groups: [gamma, beta, alpha] }, null).rows, true],
      // Qualifier-less duplicates generate `#n` IDs. Nothing tells two of them apart, so which takes which ID can follow
      // the order: both are ambiguous, and resetRows skips them.
      [shapeAntigravity({ groups: [{ buckets: [...bare, gamma.buckets[0]] }] }, null).rows, shapeAntigravity({ groups: [{ buckets: [gamma.buckets[0], bare[1], bare[0]] }] }, null).rows, false],
    ];
    for (const [fwd, rev, told] of orders) {
      for (const rows of [fwd, rev]) {
        assert.strictEqual(idOf(rows, 5), literal, `the literal ${literal} keeps its own ID in either order`);
        assert.strictEqual(ringPercent(rows, literal), 5, `a ${literal} choice shows that bucket, never a generated duplicate`);
        assert.strictEqual(ringPercent(rows, 'shared'), 90, 'a shared choice shows the pool maximum');
        assert.strictEqual(new Set(rows.map((r) => r.id)).size, 3, 'every row ID is distinct');
        assert.deepStrictEqual(rows.map((r) => !!r.ambiguous), rows.map((r) => !told && r.percent !== 5), 'only duplicates nothing tells apart are ambiguous');
      }
      if (told) {
        assert.strictEqual(idOf(fwd, 90), idOf(rev, 90), 'a duplicate keeps its generated ID in either order');
        assert.strictEqual(idOf(fwd, 20), idOf(rev, 20), 'and so does the other');
      }
      assert.deepStrictEqual(resetRows(fwd, rev), [], `reversing duplicates beside a literal ${literal} reports no reset`);
      assert.deepStrictEqual(resetRows(rev, fwd), [], 'nor reversing back');
    }
  }
  // Two duplicates whose qualifiers join to the same text ('G|a') are still two buckets: stable IDs, a reset on either.
  const joinA = { bucketId: 'x', window: 'a', remainingFraction: 0.1 };
  const joinB = { bucketId: 'x', displayName: 'a', remainingFraction: 0.8 };
  const join1 = shapeAntigravity({ groups: [{ displayName: 'G', buckets: [joinA, joinB] }] }, null).rows;
  const join2 = shapeAntigravity({ groups: [{ displayName: 'G', buckets: [joinB, joinA] }] }, null).rows;
  assert.deepStrictEqual([idOf(join1, 90), idOf(join1, 20)], [idOf(join2, 90), idOf(join2, 20)], 'qualifiers that join alike still keep their IDs in either order');
  assert.deepStrictEqual(resetRows(join1, join2), [], 'and reordering them reports no reset');
  const joinDrop = shapeAntigravity({ groups: [{ displayName: 'G', buckets: [joinB, { ...joinA, remainingFraction: 0.7 }] }] }, null).rows;
  assert.deepStrictEqual(resetRows(join1, joinDrop).map((r) => r.percent), [30], 'a drop on one of them is a reset');
  // A lone bucket that gains a duplicate in the same answer keeps its comparison key: its drop is still a reset, and
  // the newcomer, not seen before, is none.
  const gemini = (frac) => ({ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: frac }] });
  const extra = { displayName: 'Extra Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.5 }] };
  const lone = shapeAntigravity({ groups: [gemini(0.2)] }, null).rows;
  assert.strictEqual(lone[0].id, 'gemini-weekly', 'a lone bucket keeps its bucketId as its ID');
  const grew = shapeAntigravity({ groups: [gemini(0.9), extra] }, null).rows;
  assert.deepStrictEqual(resetRows(lone, grew).map((r) => [r.label, r.percent]), [['Gemini wk', 10]], 'a lone bucket that resets as a duplicate appears still reports its reset');
  assert.deepStrictEqual(resetRows(lone, shapeAntigravity({ groups: [gemini(0.2), extra] }, null).rows), [], 'unchanged usage as a duplicate appears is no reset');
  assert.deepStrictEqual(resetRows(grew, shapeAntigravity({ groups: [gemini(0.9)] }, null).rows), [], 'nor as the duplicate goes');
  assert.deepStrictEqual(resetRows(shapeAntigravity({ groups: [gemini(0.2), extra] }, null).rows, lone.map((r) => ({ ...r, percent: 10 }))).map((r) => r.percent), [10], 'a reset as the duplicate goes still shows');
}
// Round 25 Fix 3: the comparison key is the API's own fields, before the label drops "Models" or shortens "weekly". Groups
// "Alpha Models" and "Alpha" both show as "Alpha wk", yet stay two buckets, with or without a bucketId: a drop on the first
// is a reset, and their order is none.
{
  for (const bucketId of ['shared', undefined]) {
    const pair = (first, second) => [
      { displayName: 'Alpha Models', buckets: [{ bucketId, window: 'weekly', remainingFraction: first }] },
      { displayName: 'Alpha', buckets: [{ bucketId, window: 'weekly', remainingFraction: second }] },
    ];
    const before = shapeAntigravity({ groups: pair(0.1, 0.5) }, null).rows;
    const tag = bucketId ? 'with a bucketId' : 'ID-less';
    assert.ok(before.every((r) => !r.ambiguous), `${tag}: neither is ambiguous`);
    assert.deepStrictEqual(resetRows(before, shapeAntigravity({ groups: pair(0.9, 0.5) }, null).rows).map((r) => r.percent), [10], `${tag}: Alpha Models falling from 90% to 10% is a reset`);
    const reversed = shapeAntigravity({ groups: pair(0.1, 0.5).reverse() }, null).rows;
    assert.deepStrictEqual(resetRows(before, reversed), [], `${tag}: reversing them is no reset`);
    assert.deepStrictEqual(resetRows(reversed, before), [], `${tag}: nor reversing back`);
    if (bucketId) assert.deepStrictEqual([90, 50].map((p) => reversed.find((r) => r.percent === p).id), [90, 50].map((p) => before.find((r) => r.percent === p).id), 'each keeps its ID in either order');
  }
}
// Object.prototype property names in bucketId or tier id never resolve to prototype methods.
const protoSafe = shapeAntigravity(
  { groups: [{ displayName: 'Test', buckets: [{ bucketId: 'constructor', window: '5h', remainingFraction: 0.5 }] }] },
  { paidTier: { id: 'constructor', name: 'Google Custom' }, currentTier: { id: 'toString' } }
);
assert.strictEqual(typeof protoSafe.plan, 'string');
assert.strictEqual(protoSafe.plan, 'Custom');
assert.strictEqual(typeof protoSafe.rows[0].label, 'string');
assert.strictEqual(protoSafe.rows[0].label, 'Test 5h');
// Standard Gemini weekly selector picks gemini-weekly even if another Gemini pool precedes it.
const argonFirst = shapeAntigravity({
  groups: [
    { displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.15 }] },
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 }] },
  ],
}, null);
assert.strictEqual(ringPercent(argonFirst.rows, 'gemini-weekly'), 10, 'bucket ID selection picks the standard weekly pool, not Argon');
assert.strictEqual(ringPercent(argonFirst.rows, 'argon-weekly'), 85);
// Round 25 Fix 2: a choice of a known bucket finds an ID-less bucket that shows under its label, never another bucket's
// higher number. Several such are its pool, a second one suffixed "(2)" included, and a bucket with another ID is none.
for (const [choice, group, window, other] of [['gemini-5h', 'Gemini Models', '5h', '3p-5h'], ['gemini-weekly', 'Gemini Models', 'weekly', '3p-weekly'], ['3p-5h', 'Other Models', '5h', 'gemini-5h'], ['3p-weekly', 'Other Models', 'weekly', 'gemini-weekly']]) {
  const rows = shapeAntigravity({ groups: [
    { displayName: group, buckets: [{ window, remainingFraction: 0.95 }] },
    { displayName: 'Third', buckets: [{ bucketId: other, window, remainingFraction: 0.05 }] },
  ] }, null).rows;
  assert.strictEqual(ringPercent(rows, choice), 5, `a ${choice} choice shows the ID-less bucket, not ${other}'s 95%`);
}
{
  const crowded = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-5h-next', window: '5h', remainingFraction: 0.05 },
    { window: '5h', remainingFraction: 0.95 },
    { window: '5h', displayName: 'Flash', remainingFraction: 0.8 },
  ] }] }, null).rows;
  assert.deepStrictEqual(crowded.map((r) => r.label), ['Gemini 5h', 'Gemini 5h (2)', 'Gemini 5h (3)']);
  assert.strictEqual(ringPercent(crowded, 'gemini-5h'), 20, 'the ID-less pair is the pool, the suffixed one included, and gemini-5h-next is not in it');
}
assert.deepStrictEqual(
  resetRows(
    [{ id: 'argon-weekly', label: 'Gemini 4 Argon wk', percent: 85 }, { id: 'gemini-weekly', label: 'Gemini wk', percent: 50 }],
    [{ id: 'argon-weekly', label: 'Gemini 4 Argon wk', percent: 85 }, { id: 'gemini-weekly', label: 'Gemini wk', percent: 5 }]
  ).map((r) => r.id),
  ['gemini-weekly'],
  'reset detection keys by stable bucket ID'
);
for (const epoch of ['1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00+00:00', 'not-a-date']) {
  const r = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', resetTime: epoch }] }] }, null);
  assert.deepStrictEqual([r.rows[0].percent, r.rows[0].resetsAt], [0, null], `epoch/invalid resetTime "${epoch}" with omitted remainingFraction is untouched (0%)`);
}
assert.strictEqual(shapeAntigravity(agSummary, { currentTier: { id: 'free-tier', name: 'Antigravity' } }).plan, 'Free');
assert.strictEqual(shapeAntigravity(agSummary, { paidTier: {}, currentTier: { id: 'free-tier', name: 'Antigravity' } }).plan, 'Free', 'empty paidTier falls back to currentTier');
assert.strictEqual(shapeAntigravity(agSummary, { paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }).plan, 'AI Pro');
assert.strictEqual(shapeAntigravity(agSummary, { paidTier: { id: 'g1-next', name: 'Google AI Next' } }).plan, 'AI Next');
assert.strictEqual(shapeAntigravity(agSummary, null).plan, '');
assert.ok(shapeAntigravity({ groups: [] }, null).error, 'no quota groups is an error, not a zero reading');
assert.ok(shapeAntigravity({}, null).error, 'an answer of another shape is an error');
// Round 26 Fix 1: an HTTP date is UTC in each of its three forms, asctime's too, whatever the process's zone. An
// impossible calendar date, a time out of range or another zone gives no delay (null), never a rolled-over one.
{
  const clockWas = Date.now;
  const tzWas = process.env.TZ;
  process.env.TZ = 'America/New_York';
  Date.now = () => Date.parse('2026-11-20T12:00:00Z');
  try {
    for (const [header, seconds] of [
      ['Fri Nov 20 12:01:00 2026', 60],
      ['Fri Nov 20 12:02:00 2026', 120],
      ['Fri, 20 Nov 2026 12:02:00 GMT', 120],
      ['Friday, 20-Nov-26 12:02:00 GMT', 120],
      ['Fri, 20 Nov 2026 12:00:60 GMT', 60], // a leap second
      ['Sun Nov  6 08:49:37 1994', 0],
      ['Sunday, 06-Nov-94 08:49:37 GMT', 0], // 2094 is over 50 years ahead, so 1994
      ['Friday, 20-Nov-76 12:00:00 GMT', (Date.UTC(2076, 10, 20, 12) - Date.UTC(2026, 10, 20, 12)) / 1000], // 50 years ahead is no more than 50
      ['Friday, 20-Nov-77 12:00:00 GMT', 0], // 2077 is, so 1977
      // Round 27 Fix 3: the 50 years run to the second, not the calendar year. 2076's 21 Nov is a day past them, so 1976.
      ['Sunday, 21-Nov-76 12:00:00 GMT', 0],
      ['Friday, 20-Nov-76 12:00:01 GMT', 0],
      ['Thursday, 19-Nov-76 12:00:00 GMT', (Date.UTC(2076, 10, 19, 12) - Date.UTC(2026, 10, 20, 12)) / 1000],
      ['120', 120],
      ['Fri, 31 Nov 2026 12:01:00 GMT', null],
      ['Sun, 29 Feb 2026 12:01:00 GMT', null],
      ['Fri, 00 Nov 2026 12:01:00 GMT', null],
      ['Fri Nov 31 12:01:00 2026', null],
      ['Friday, 31-Nov-26 12:01:00 GMT', null],
      ['Fri, 20 Nov 2026 24:00:00 GMT', null],
      ['Fri, 20 Nov 2026 12:60:00 GMT', null],
      ['Fri, 20 Nov 2026 12:01:00 EST', null],
      ['Fri, 20 Nov 2026 12:01 GMT', null],
      ['-5', null],
      ['abc', null],
    ]) assert.strictEqual(retryAfterSeconds(header), seconds, `Retry-After: ${header}`);
    // Round 27 Fix 3: half a second past noon, 2076's 20 Nov at noon is under 50 years ahead, so it stays. In January
    // 2050, 29 Feb 2100 would be over 50 years ahead, so 29-Feb-00 is 2000's, a leap year: a date, and past.
    Date.now = () => Date.parse('2026-11-20T12:00:00.500Z');
    assert.strictEqual(retryAfterSeconds('Friday, 20-Nov-76 12:00:00 GMT'), (Date.UTC(2076, 10, 20, 12) - Date.now()) / 1000, 'under 50 years by half a second stays ahead');
    Date.now = () => Date.parse('2050-01-15T00:00:00Z');
    assert.strictEqual(retryAfterSeconds('Tuesday, 29-Feb-00 12:00:00 GMT'), 0, '29 Feb in a century back is a date');
  } finally {
    Date.now = clockWas;
    if (tzWas === undefined) delete process.env.TZ;
    else process.env.TZ = tzWas;
  }
}
// Round 26 Fix 4: a choice of a known bucket takes every row in its pool. An ID-less bucket of the third-party group
// ("Claude and GPT models") is Other 5h's or Other wk's, and an ID-less Gemini 5h beside an explicit gemini-5h counts too.
{
  const rows = shapeAntigravity({ groups: [
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.05 }, { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.05 }] },
    { displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 0.95 }, { window: 'weekly', remainingFraction: 0.9 }] },
  ] }, null).rows;
  assert.deepStrictEqual(['3p-5h', '3p-weekly', 'gemini-5h'].map((c) => ringPercent(rows, c)), [5, 10, 95], 'an ID-less Claude and GPT bucket is the Other pool, never Gemini\'s 95%');
  const mixed = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95 },
    { window: '5h', remainingFraction: 0.1 },
  ] }] }, null).rows;
  assert.strictEqual(ringPercent(mixed, 'gemini-5h'), 90, 'an explicit gemini-5h and an ID-less Gemini 5h are one pool: its maximum shows');
  const argon = shapeAntigravity({ groups: [{ displayName: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingFraction: 0.1 }] }, { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 }] }] }, null).rows;
  assert.strictEqual(ringPercent(argon, 'gemini-weekly'), 10, 'an ID-less Argon bucket stays out of the standard Gemini pool');
  // Round 30 Fix 1: an unnamed group with an ID-less bucket carrying both displayName and window must NOT let the
  // window mask the displayName before pool matching.
  const unnamedGem = shapeAntigravity({ groups: [{ buckets: [
    { displayName: 'Gemini 5h', window: '5h', remainingFraction: 0.95 },
    { bucketId: '3p-5h', window: '5h', remainingFraction: 0.05 },
  ] }] }, null).rows;
  assert.deepStrictEqual([unnamedGem[0].label, ringPercent(unnamedGem, 'gemini-5h')], ['Gemini 5h', 5], 'unnamed-group Gemini 5h with window: "5h" stays in the gemini-5h pool (5%, not 95%)');
  const unnamedMore = shapeAntigravity({ groups: [{ buckets: [
    { displayName: 'Gemini weekly', window: 'weekly', remainingFraction: 0.9 },
    { displayName: 'Claude and GPT models', window: '5h', remainingFraction: 0.85 },
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.05 },
  ] }] }, null).rows;
  assert.deepStrictEqual(['gemini-weekly', '3p-5h'].map((c) => ringPercent(unnamedMore, c)), [10, 15], 'unnamed-group Gemini weekly and Claude/GPT 5h match their pools');
  // Round 31 Fix 1: a named Gemini Models group with ID-less displayName-only buckets ("Gemini 5h" / "Gemini weekly")
  // must still assign them to their pools rather than ignoring disp and falling back to 3p-5h (95%).
  const namedDisp = shapeAntigravity({ groups: [
    { displayName: 'Gemini Models', buckets: [
      { displayName: 'Gemini 5h', remainingFraction: 0.95 },
      { displayName: 'Gemini weekly', remainingFraction: 0.9 },
    ] },
    { displayName: 'Other Models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.05 }] },
  ] }, null).rows;
  assert.deepStrictEqual(['gemini-5h', 'gemini-weekly'].map((c) => ringPercent(namedDisp, c)), [5, 10], 'named-group displayName-only Gemini 5h and Gemini weekly match their pools (5% and 10%, not 95%)');
  // Round 31 Fix 2: unnamed group with two ID-less buckets named "Gemini" carrying 5h and weekly windows keeps both window labels.
  const winLabels = shapeAntigravity({ groups: [{ buckets: [
    { displayName: 'Gemini', window: '5h', remainingFraction: 0.8 },
    { displayName: 'Gemini', window: 'weekly', remainingFraction: 0.4 },
  ] }] }, null).rows;
  assert.deepStrictEqual(winLabels.map((r) => [r.label, r.percent]), [['Gemini 5h', 20], ['Gemini wk', 60]], 'unnamed-group buckets keep their 5h and wk window labels instead of becoming Gemini / Gemini (2)');
  // Round 31 Fix 3: array buckets (`[]`) and empty field-less objects (`{}`) are ignored rather than turned into 0% "Usage" rows.
  assert.strictEqual(shapeAntigravity({ groups: [{ buckets: [[]] }] }, null).error, 'No usage windows reported.', 'array bucket is rejected');
  assert.strictEqual(shapeAntigravity({ groups: [{ buckets: [{}] }] }, null).error, 'No usage windows reported.', 'empty bucket object is rejected');
}
// Round 26 Fix 5: a lone bucket that gains or loses display fields is the same bucket, so its drop is a reset.
{
  const lone = (group, frac) => shapeAntigravity({ groups: [{ ...(group ? { displayName: group } : {}), buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: frac }] }] }, null).rows;
  assert.deepStrictEqual(resetRows(lone(null, 0.1), lone('Gemini Models', 0.9)).map((r) => [r.id, r.label, r.percent]), [['gemini-5h', 'Gemini 5h', 10]], 'a lone bucket that gains its group name still reports its reset');
  assert.deepStrictEqual(resetRows(lone('Gemini Models', 0.1), lone(null, 0.9)).map((r) => r.percent), [10], 'and so does one that loses it');
  assert.deepStrictEqual(resetRows(lone(null, 0.1), lone('Gemini Models', 0.1)), [], 'unchanged usage is no reset');
}
// Round 27 Fix 4: a lone bucket's window is what it is. Two buckets share bucketId "shared", a 5h at 90% and a weekly at
// 10%; then the answer holds only the 5h, unchanged, then only the weekly, unchanged: no reset at either step.
{
  const shared = (...buckets) => shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets }] }, null).rows;
  const fiveH = { bucketId: 'shared', window: '5h', remainingFraction: 0.1 };
  const weekly = { bucketId: 'shared', window: 'weekly', remainingFraction: 0.9 };
  const [both, only5h, onlyWk] = [shared(fiveH, weekly), shared(fiveH), shared(weekly)];
  assert.deepStrictEqual([resetRows(both, only5h), resetRows(only5h, onlyWk)], [[], []], 'a 5h and a weekly bucket taking turns under one bucketId is no reset');
  const knownWk = shared({ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 });
  assert.deepStrictEqual(resetRows(knownWk, shared({ bucketId: 'gemini-weekly', window: 'weekly', displayName: 'Weekly', remainingFraction: 0.95 })).map((r) => r.percent), [5], 'a known lone bucket gaining a displayName still resets');
  const bare = (group, frac) => shapeAntigravity({ groups: [{ ...(group ? { displayName: group } : {}), buckets: [{ bucketId: 'gemini-5h', remainingFraction: frac }] }] }, null).rows;
  assert.deepStrictEqual(resetRows(bare(null, 0.1), bare('Gemini Models', 0.9)).map((r) => r.percent), [10], 'a bucket with no window that gains its group name still resets');
}
// Round 28 Fix 1 & Round 29 Fix 1 & Fix 2:
// - Unknown shared bucketIds with differing groups or displayNames (including Flash -> unnamed) never false-reset.
// - A known lone bucket (gemini-5h) that gains display metadata AND changes rendered label due to label collision still resets.
{
  const grp = (name, frac, disp) => ({ displayName: name, buckets: [{ bucketId: 'shared', window: '5h', remainingFraction: frac, ...(disp ? { displayName: disp } : {}) }] });
  const shapeG = (...groups) => shapeAntigravity({ groups }, null).rows;
  const gem = grp('Gemini', 0.1);
  const oth = grp('Other', 0.9);
  const [both, onlyGem, onlyOth] = [shapeG(gem, oth), shapeG(gem), shapeG(oth)];
  assert.deepStrictEqual([resetRows(both, onlyGem), resetRows(onlyGem, onlyOth)], [[], []], 'Gemini and Other taking turns under one bucketId + 5h window is no reset');
  const unnamed = { buckets: [{ bucketId: 'shared', window: '5h', remainingFraction: 0.9 }] };
  assert.deepStrictEqual(resetRows(onlyGem, shapeG(unnamed)), [], 'named group followed by unnamed unknown bucket is no reset');
  assert.deepStrictEqual(resetRows(shapeG(grp('Gemini', 0.1, 'Flash')), shapeG(grp('Gemini', 0.9, 'Pro'))), [], 'distinct non-empty bucket displayNames under one bucketId is no reset');
  assert.deepStrictEqual(resetRows(shapeG(grp('Alpha Models', 0.1)), shapeG(grp('Alpha', 0.9))), [], 'Alpha Models followed by Alpha under one bucketId is no reset');
  // Round 29 Fix 1: unknown `shared` + `5h` with no group, `Flash` (90%) -> unnamed (10%) must NOT false-reset.
  const noGrpFlash = shapeG({ buckets: [{ bucketId: 'shared', window: '5h', displayName: 'Flash', remainingFraction: 0.1 }] });
  const noGrpUnnamed = shapeG({ buckets: [{ bucketId: 'shared', window: '5h', remainingFraction: 0.9 }] });
  assert.deepStrictEqual(resetRows(noGrpFlash, noGrpUnnamed), [], 'unknown shared bucket dropping displayName (Flash -> unnamed) does not false-reset');
  assert.deepStrictEqual(resetRows(noGrpUnnamed, noGrpFlash), [], 'unknown shared bucket gaining displayName does not false-reset');
  // Round 29 Fix 2: known `gemini-5h` at 90% followed by ID-less 5h -> reversed order + displayName: 'Flash' at 10%
  // changes rendered label from "Gemini 5h" to "gemini-5h" and MUST still report the genuine reset.
  const beforeColl = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.1 },
    { window: '5h', remainingFraction: 0.7 },
  ] }] }, null).rows;
  const afterColl = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [
    { window: '5h', remainingFraction: 0.7 },
    { bucketId: 'gemini-5h', window: '5h', displayName: 'Flash', remainingFraction: 0.9 },
  ] }] }, null).rows;
  assert.deepStrictEqual([beforeColl[0].label, afterColl[1].label], ['Gemini 5h', 'gemini-5h'], 'label collision renames gemini-5h row');
  assert.deepStrictEqual(resetRows(beforeColl, afterColl).map((r) => [r.id, r.percent]), [['gemini-5h', 10]], 'known lone bucket still reports genuine reset despite label collision and added displayName');
}
// Round 32 Fix 3: a window padded with whitespace is that window: ' weekly ' joins Other weekly's pool, and ' 5h ' sorts first.
{
  const gem90 = { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.1 }] };
  const padded = shapeAntigravity({ groups: [{ displayName: 'Claude and GPT Models', buckets: [{ window: ' weekly ', remainingFraction: 0.9 }] }, gem90] }, null).rows;
  assert.strictEqual(ringPercent(padded, '3p-weekly'), 10, "an ID-less Claude and GPT bucket with window ' weekly ' is Other weekly (10%, not Gemini's 90%)");
  const paddedDisp = shapeAntigravity({ groups: [{ buckets: [{ displayName: 'Claude and GPT Models', window: ' weekly ', remainingFraction: 0.9 }] }, gem90] }, null).rows;
  assert.strictEqual(ringPercent(paddedDisp, '3p-weekly'), 10, 'and so is one named by its own displayName');
  const sorted = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [{ window: ' weekly ', remainingFraction: 0.4 }, { window: ' 5h ', remainingFraction: 0.8 }] }] }, null).rows;
  assert.deepStrictEqual(sorted.map((r) => [r.label, r.percent]), [['Gemini 5h', 20], ['Gemini wk', 60]], "' 5h ' sorts before ' weekly ', as 5h before weekly");
}
// Round 32 Fix 4: a known lone bucket that gains its window is the same bucket, so its drop is a reset; one whose window
// changes is another bucket, and is none.
{
  const lone = (win, frac) => shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', ...(win ? { window: win } : {}), displayName: 'Gemini', remainingFraction: frac }] }] }, null).rows;
  const after = lone('5h', 0.9);
  assert.deepStrictEqual(resetRows(lone(null, 0.1), after), after, 'a lone gemini-5h at 90% that gains window 5h at 10% reports the reset');
  assert.deepStrictEqual(resetRows(lone('5h', 0.1), lone(null, 0.9)).map((r) => r.percent), [10], 'and so does one that loses it');
  assert.deepStrictEqual(resetRows(lone('5h', 0.1), lone('weekly', 0.9)), [], 'a lone gemini-5h whose window turns 5h -> weekly is no reset');
  const keyless = (win, frac) => lone(win, frac).map(({ key: _k, ...r }) => r);
  assert.deepStrictEqual(resetRows(lone('5h', 0.1), keyless('weekly', 0.9)), [], 'a row saved without a key still compares its window');
  assert.deepStrictEqual(resetRows(lone(null, 0.1), keyless('5h', 0.9)).map((r) => r.percent), [10], 'and matches when one side has none');
}
// Round 33 Fix 3: an ID-less bucket in a non-standard Gemini group ("Gemini 4 Argon") must never join the standard
// gemini-weekly pool even when its own displayName says "Gemini weekly".
{
  const argonWk = shapeAntigravity({ groups: [
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 }] },
    { displayName: 'Gemini 4 Argon', buckets: [{ window: 'weekly', displayName: 'Gemini weekly', remainingFraction: 0.1 }] },
  ] }, null).rows;
  assert.deepStrictEqual([argonWk[1].label, ringPercent(argonWk, 'gemini-weekly')], ['Gemini 4 Argon wk', 10], 'Argon row with displayName "Gemini weekly" stays out of gemini-weekly pool (10%, not 90%)');
  const argonNoWin = shapeAntigravity({ groups: [
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 }] },
    { displayName: 'Gemini 4 Argon', buckets: [{ displayName: 'Gemini weekly', remainingFraction: 0.1 }] },
  ] }, null).rows;
  assert.strictEqual(ringPercent(argonNoWin, 'gemini-weekly'), 10, 'and stays out even when window is omitted');
  // Round 34 Fix 3: standard Gemini/Other group names and windows match their pools case-insensitively.
  const lowerGem = shapeAntigravity({ groups: [
    { displayName: 'gemini models', buckets: [{ window: 'weekly', remainingFraction: 0.9 }] },
    { displayName: 'Other Models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.05 }] },
  ] }, null).rows;
  assert.strictEqual(ringPercent(lowerGem, 'gemini-weekly'), 10, 'lowercase "gemini models" weekly joins gemini-weekly pool (10%, not 95%)');
  const upperOther = shapeAntigravity({ groups: [
    { displayName: 'OTHER MODELS', buckets: [{ window: '5H', remainingFraction: 0.85 }] },
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.05 }] },
  ] }, null).rows;
  assert.strictEqual(ringPercent(upperOther, '3p-5h'), 15, 'uppercase "OTHER MODELS" 5H joins 3p-5h pool (15%, not 95%)');
  // Round 35 Fix 3: window capitalization changes ("weekly" -> "WEEKLY") must still report a genuine reset.
  const wkLower = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.1, resetTime: '2026-11-26T21:00:00Z' }] }] }, null).rows;
  const wkUpper = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'WEEKLY', remainingFraction: 0.9, resetTime: '2026-12-03T21:00:00Z' }] }] }, null).rows;
  assert.deepStrictEqual(resetRows(wkLower, wkUpper).map((r) => [r.id, r.percent]), [['gemini-weekly', 10]], 'window: "weekly" -> "WEEKLY" still reports a genuine reset');
  // Round 36 Fix 2: uppercase "WK" on an ID-less third-party bucket joins 3p-weekly instead of falling back to Gemini's 95%.
  const upperWk = shapeAntigravity({ groups: [
    { displayName: 'Claude and GPT models', buckets: [{ window: 'WK', remainingFraction: 0.85 }] },
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.05 }] },
  ] }, null).rows;
  assert.strictEqual(ringPercent(upperWk, '3p-weekly'), 15, 'uppercase "WK" on Claude and GPT models joins 3p-weekly (15%, not 95%)');
  // Round 36 Fix 3: a legacy saved ID-less row with uppercase "WEEKLY" in its stored key still matches its lowercased
  // successor after upgrade and reports a genuine reset.
  const legacySaved = [{ key: JSON.stringify(['Gemini Models', 'WEEKLY', '']), label: 'Gemini wk', percent: 90, resetsAt: null }];
  const upgradedNow = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [{ window: 'weekly', remainingFraction: 0.85 }] }] }, null).rows;
  assert.deepStrictEqual(resetRows(legacySaved, upgradedNow).map((r) => r.percent), [15], 'legacy saved uppercase WEEKLY key still fires a reset against lowercased weekly');
  // Round 37 Fix 2: two legacy cached rows collapsing onto one normalized key (weekly at 15% and WEEKLY at 90%) are
  // ambiguous and must NOT overwrite 15% with 90% and trigger a false reset on unchanged 15%.
  const legacyDup = [
    { key: JSON.stringify(['Gemini Models', 'weekly', '']), label: 'Gemini wk', percent: 15, resetsAt: null },
    { key: JSON.stringify(['Gemini Models', 'WEEKLY', '']), label: 'Gemini wk (2)', percent: 90, resetsAt: null },
  ];
  assert.deepStrictEqual(resetRows(legacyDup, upgradedNow), [], 'two legacy rows colliding after window normalization trigger no false reset');
  // Round 37 Fix 3: Gemini Models group with ID-less { displayName: 'Weekly' } (no window) joins gemini-weekly pool (15%, not 95%).
  const grpPlusDisp = shapeAntigravity({ groups: [
    { displayName: 'Gemini Models', buckets: [{ displayName: 'Weekly', remainingFraction: 0.85 }] },
    { displayName: 'Other Models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.05 }] },
  ] }, null).rows;
  assert.strictEqual(ringPercent(grpPlusDisp, 'gemini-weekly'), 15, 'Gemini Models + displayName "Weekly" without window joins gemini-weekly pool (15%, not 95%)');
  // Round 38 Fix 3: legacy key collisions on known bucket IDs (weekly 15% + WEEKLY 90%) or with one disabled row must
  // NOT fall through to beforeLone or survive disabled filtering and trigger a false reset.
  const legacyKnownDup = [
    { id: 'gemini-weekly', key: JSON.stringify(['gemini-weekly', 'Gemini Models', 'weekly', '']), win: 'weekly', label: 'Gemini wk', percent: 15, resetsAt: null },
    { id: 'gemini-weekly', key: JSON.stringify(['gemini-weekly', 'Gemini Models', 'WEEKLY', '']), win: 'WEEKLY', label: 'Gemini wk (2)', percent: 90, resetsAt: null },
  ];
  const curGemWk15 = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.85 }] }] }, null).rows;
  assert.deepStrictEqual(resetRows(legacyKnownDup, curGemWk15), [], 'colliding legacy gemini-weekly keys do not fall through to beforeLone');
  const legacyDisDup = [
    { id: 'shared@Gemini|wk', bucketId: 'shared', key: JSON.stringify(['shared', 'Gemini Models', 'weekly', '']), win: 'weekly', disabled: true, label: 'Gemini wk', percent: 100, resetsAt: null },
    { id: 'shared@Gemini|WEEKLY', bucketId: 'shared', key: JSON.stringify(['shared', 'Gemini Models', 'WEEKLY', '']), win: 'WEEKLY', label: 'Gemini wk (2)', percent: 90, resetsAt: null },
  ];
  const curShared15 = shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'shared', window: 'weekly', remainingFraction: 0.85 }] }] }, null).rows;
  assert.deepStrictEqual(resetRows(legacyDisDup, curShared15), [], 'disabled legacy row still counts toward key collision so enabled sibling does not false-reset');
  // Round 38 Fix 4: displayName ("5h") must NOT override an explicit window ("weekly") in pool matching.
  const dispVsWin = shapeAntigravity({ groups: [
    { displayName: 'Gemini Models', buckets: [{ window: 'weekly', displayName: '5h', remainingFraction: 0.85 }] },
    { displayName: 'Other Models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.05 }] },
  ] }, null).rows;
  assert.deepStrictEqual([dispVsWin[0].label, dispVsWin[0].bucketId, ringPercent(dispVsWin, 'gemini-weekly')], ['Gemini wk', 'gemini-weekly', 15], 'explicit weekly window wins over displayName "5h" (15%, not 95%)');
}
// Round 33 Fix 4: re-enabling a disabled bucket (disabled: true -> false) with unchanged quota and resetTime must NOT
// report a false reset even though the displayed percentage drops from 100% to its real usage (30%).
{
  const mk = (disabled, frac = 0.7) => shapeAntigravity({ groups: [{ displayName: 'Gemini Models', buckets: [
    { bucketId: 'gemini-5h', window: '5h', remainingFraction: frac, resetTime: '2026-11-20T05:00:00Z', disabled },
  ] }] }, null).rows;
  const off = mk(true, 0.7);
  const on = mk(false, 0.7);
  assert.deepStrictEqual([off[0].percent, on[0].percent, resetRows(off, on)], [100, 30, []], 'disabled: true -> false does not fire a false reset');
  assert.deepStrictEqual(resetRows(on, mk(false, 0.9)).map((r) => r.percent), [10], 'a subsequent real drop while enabled still fires a reset');
}
// Round 26 Fix 6: a malformed group or tier name costs nothing: the valid rows all land, and the plan falls back.
{
  const bad = { toString: null };
  const out = shapeAntigravity({ groups: [...agSummary.groups, { displayName: bad, buckets: [] }, null, 'x', { displayName: 7, buckets: [{ bucketId: 'odd', window: '5h', remainingFraction: 0.5 }] }] }, { paidTier: { id: bad, name: bad }, currentTier: { id: 'free-tier' } });
  assert.deepStrictEqual([out.plan, out.error, out.rows.map((r) => [r.id, r.percent])], ['Free', undefined, [...ag.rows.map((r) => [r.id, r.percent]), ['odd', 50]]], 'a malformed group is skipped and every valid row stays');
}

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
    const agAuthFile = path.join(codexHome, 'antigravity-auth.json');
    fs.writeFileSync(agAuthFile, JSON.stringify({ token: { access_token: 'ag-test-token' } }));
    const originalFetch = global.fetch;
    const originalKey = process.env.OPENCODE_API_KEY;
    const originalAgAuth = process.env.ANTIGRAVITY_AUTH_FILE;
    process.env.OPENCODE_API_KEY = 'test-key';
    process.env.ANTIGRAVITY_AUTH_FILE = agAuthFile;
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
          if (url.endsWith('/profile') || url.endsWith('format=credits') || url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({}) };
          calls++;
          if (mode === 'offline' || (mode === 'recover' && calls === 1)) throw networkError();
          if (mode === 'timeout') return { ok: true, json: async () => { throw new DOMException('deadline', 'TimeoutError'); } };
          if (mode === 'truncated') return { ok: true, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } };
          // What held Claude's read for 12 hours on 2026-10-29: a request that never answers, deaf to its signal.
          if (mode === 'lost') return new Promise(() => {});
          if (/^\d+/.test(mode)) {
            const [status, retry = '120'] = mode.split(':');
            return { ok: false, status: Number(status), headers: new Headers(retry === 'none' ? {} : { 'retry-after': retry }) };
          }
          return { ok: true, json: async () => ({
            limits: [{ kind: 'session', percent: 12 }],
            rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } },
            usage: { rolling: { percent: 12 } },
            config: { monthlyLimit: { val: 100 }, used: { val: 12 } },
            groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.88 }] }],
          }) };
        };
        const recovered = await provider.read();
        assert.strictEqual(recovered.rows?.[0]?.percent, 12, `${provider.id} recovers from a transient fetch failure`);
        assert.strictEqual(calls, 2, 'one retry after a transport failure');
        // Round 25 Fix 1: a 429's Retry-After: 0 is a delay of none, and one that gives no delay (none, or so many digits
        // its deadline can't be a number) waits the 60s fallback.
        const huge = `429:${'9'.repeat(307)}`;
        for (mode of ['offline', 'timeout', 'lost', 'truncated', '429', '429:0', '429:none', huge, '401', '503', '408']) {
          calls = 0;
          const result = await settles(provider.read(), `${provider.id} ${mode}`);
          assert.strictEqual(calls, ['offline', 'timeout', 'lost', 'truncated'].includes(mode) ? 2 : 1, 'bounded retry, never retry HTTP errors');
          if (mode.startsWith('429')) {
            assert.strictEqual(result.retryAfter, { 429: 120, '429:0': 0 }[mode] ?? 60, `${provider.id} ${mode === huge ? '429 with 307 digits' : mode}: its wait`);
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
      if (originalAgAuth === undefined) delete process.env.ANTIGRAVITY_AUTH_FILE;
      else process.env.ANTIGRAVITY_AUTH_FILE = originalAgAuth;
    }
  })
  .then(async () => {
    // Antigravity: non-blocking loadCodeAssist with single in-flight + Retry-After + no blank cache,
    // 401 vs 403 permission denial, expired/missing credentials, and Windows CredRead failure/fallback handling.
    const mod = require('./providers');
    const ag = mod.PROVIDERS.find((p) => p.id === 'antigravity');
    const agAuthFile = path.join(codexHome, 'antigravity-auth.json');
    const agCliFallback = path.join(codexHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    const originalFetch = global.fetch;
    const originalAgAuth = process.env.ANTIGRAVITY_AUTH_FILE;
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    process.env.ANTIGRAVITY_AUTH_FILE = agAuthFile;
    let assistCalls = 0;
    let assistMode = 'ok';
    let releaseAssist = null;
    let quotaStatus = 200;
    let quotaBodyText = null;
    const sentAuth = [];
    global.fetch = async (url, options) => {
      sentAuth.push([url, options.headers.Authorization, options.headers['User-Agent']]);
      if (url.endsWith(':loadCodeAssist')) {
        assistCalls++;
        if (assistMode === 'hold') {
          await new Promise((r) => (releaseAssist = r));
          return { ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } }) };
        }
        if (assistMode === 'empty') return { ok: true, json: async () => ({}) };
        if (assistMode === '429') return { ok: false, status: 429, headers: new Headers({ 'retry-after': '180' }) };
        if (assistMode === '503') return { ok: false, status: 503, headers: new Headers({ 'retry-after': '360' }) };
        return { ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } }) };
      }
      if (quotaStatus !== 200) {
        return {
          ok: false,
          status: quotaStatus,
          headers: new Headers({ 'retry-after': '75' }),
          ...(quotaBodyText === 'stall' ? { text: () => new Promise(() => {}) } : quotaBodyText ? { text: async () => quotaBodyText } : {}),
        };
      }
      return { ok: true, json: async () => agSummary };
    };
    try {
      // A -> B -> A while A's loadCodeAssist is still in flight must NOT start a second simultaneous request for A.
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'a@example.com', token: { access_token: 'ag-tok-1', expiry: new Date(clock + 3600_000).toISOString() } }));
      assistMode = 'hold';
      const fastQuota = await ag.read();
      assert.strictEqual(fastQuota.plan, '');
      assert.strictEqual(fastQuota.rows.length, 4, 'quota returns immediately while loadCodeAssist is still pending');
      assert.strictEqual(assistCalls, 1);
      // Switch to B and back to A while A's tier request is still held.
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'other@example.com', token: { access_token: 'ag-tok-o', expiry: new Date(clock + 3600_000).toISOString() } }));
      assistMode = 'empty';
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, 2);
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'a@example.com', token: { access_token: 'ag-tok-1', expiry: new Date(clock + 3600_000).toISOString() } }));
      assistMode = 'ok';
      await ag.read();
      assert.strictEqual(assistCalls, 2, 'switching A -> B -> A preserves A\'s in-flight loadCodeAssist without starting a duplicate');
      releaseAssist();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual((await ag.read()).plan, 'AI Ultra', 'once loadCodeAssist settles, the cached tier lands without re-fetching');
      assert.strictEqual(assistCalls, 2);
      assert.ok(sentAuth.some(([, a, ua]) => a === 'Bearer ag-tok-1' && ua.startsWith('antigravity/hub/')));

      // Confirmed sign-out invalidates the cached plan so signing back into the same account fetches the current plan.
      fs.rmSync(agAuthFile, { force: true });
      assert.ok((await ag.read()).signedOut);
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'a@example.com', token: { access_token: 'ag-tok-1', expiry: new Date(clock + 3600_000).toISOString() } }));
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, 3, 'signing back in after sign-out refetches the account\'s current plan');

      // An in-flight loadCodeAssist started before sign-out must NOT repopulate the cache after sign-out.
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'signout-race@example.com', token: { access_token: 'so-tok-1', expiry: new Date(clock + 3600_000).toISOString() } }));
      assistMode = 'hold';
      releaseAssist = null;
      const beforeSignout = await ag.read();
      assert.ok(releaseAssist, 'pre-sign-out loadCodeAssist started');
      fs.rmSync(agAuthFile, { force: true });
      assert.ok((await ag.read()).signedOut);
      releaseAssist();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(ag.cachedPlan(beforeSignout.renewsFor), '', 'discarded pre-sign-out loadCodeAssist did not repopulate the plan cache');
      // Restoring the exact same bearer token after sign-out must fetch fresh tier (not reuse the discarded pre-sign-out plan).
      assistMode = 'ok';
      const callsBeforeResign = assistCalls;
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'signout-race@example.com', token: { access_token: 'so-tok-1', expiry: new Date(clock + 3600_000).toISOString() } }));
      await ag.read();
      assert.strictEqual(assistCalls, callsBeforeResign + 1, 'signing back in with the same bearer fetches fresh tier');
      await new Promise((r) => setImmediate(r));
      assert.strictEqual((await ag.read()).plan, 'AI Ultra');

      // Known account tier refreshes on token rotation and after the 6h TTL (e.g. plan upgrade AI Pro -> AI Ultra).
      const prevFetch = global.fetch;
      let dynamicTier = { id: 'g1-pro-tier', name: 'Google AI Pro' };
      global.fetch = async (url, options) => {
        if (url.endsWith(':loadCodeAssist')) {
          assistCalls++;
          return { ok: true, json: async () => ({ paidTier: dynamicTier }) };
        }
        return prevFetch(url, options);
      };
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'upgrade@example.com', token: { access_token: 'up-tok-1', refresh_token: 'up-rt', expiry: new Date(clock + 3600_000).toISOString() } }));
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual((await ag.read()).plan, 'AI Pro');
      const callsBeforeRotate = assistCalls;
      dynamicTier = { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' };
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'upgrade@example.com', token: { access_token: 'up-tok-2', refresh_token: 'up-rt', expiry: new Date(clock + 3600_000).toISOString() } }));
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeRotate + 1, 'token rotation refreshes the cached plan');
      assert.strictEqual((await ag.read()).plan, 'AI Ultra');
      clock += 6 * 3600_000 + 1000;
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'upgrade@example.com', token: { access_token: 'up-tok-2', refresh_token: 'up-rt', expiry: new Date(clock + 3600_000).toISOString() } }));
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeRotate + 2, 'cached plan refreshes after 6h TTL even with same token');
      global.fetch = prevFetch;

      // A 200 {} tier response does not permanently cache a blank tier; it retries after cooldown.
      const callsBeforeB = assistCalls;
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'b@example.com', token: { access_token: 'ag-tok-2', expiry: new Date(clock + 3600_000).toISOString() } }));
      assistMode = 'empty';
      assert.strictEqual((await ag.read()).plan, '');
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeB + 1);
      assistMode = 'ok';
      await ag.read();
      assert.strictEqual(assistCalls, callsBeforeB + 1, 'empty tier response cools down instead of hammering on manual refresh');
      clock += 5 * 60_000 + 1000;
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeB + 2, 'retries after cooldown and picks up a usable tier');
      assert.strictEqual((await ag.read()).plan, 'AI Ultra');

      // Both 429 and 503 with Retry-After on loadCodeAssist respect the full Retry-After deadline (including weak identities across token rotation and slot churn).
      const callsBeforeC = assistCalls;
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'c@example.com', token: { access_token: 'ag-tok-3', expiry: new Date(clock + 3600_000).toISOString() } }));
      assistMode = '429';
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeC + 1);
      assistMode = 'ok';
      clock += 60_000;
      await ag.read();
      assert.strictEqual(assistCalls, callsBeforeC + 1, 'loadCodeAssist respects its 180s Retry-After on 429');
      clock += 121_000;
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeC + 2);
      assert.strictEqual((await ag.read()).plan, 'AI Ultra');
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'd@example.com', token: { access_token: 'ag-tok-4', expiry: new Date(clock + 3600_000).toISOString() } }));
      assistMode = '503';
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeC + 3);
      assistMode = 'ok';
      clock += 61_000;
      await ag.read();
      assert.strictEqual(assistCalls, callsBeforeC + 3, 'loadCodeAssist honors 360s Retry-After on 503 too');
      // Access-token-only (weak identity) 503 with Retry-After: 360 stays backed off even after token rotation and 10 other accounts.
      const callsBeforeWeakTier = assistCalls;
      fs.writeFileSync(agAuthFile, JSON.stringify({ token: { access_token: 'weak-tier-1', expiry: new Date(clock + 3600_000).toISOString() } }));
      assistMode = '503';
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeWeakTier + 1);
      assistMode = 'ok';
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: `churn${i}@example.com`, token: { access_token: `churn-tok-${i}`, expiry: new Date(clock + 3600_000).toISOString() } }));
        await ag.read();
        await new Promise((r) => setImmediate(r));
      }
      const callsAfterChurn = assistCalls;
      fs.writeFileSync(agAuthFile, JSON.stringify({ token: { access_token: 'weak-tier-2', expiry: new Date(clock + 3600_000).toISOString() } }));
      clock += 60_000;
      await ag.read();
      assert.strictEqual(assistCalls, callsAfterChurn, 'weak-identity loadCodeAssist 503 Retry-After survives token rotation and slot churn');
      // Adding refresh_token to weak-tier-2 (which inherited the wait) must ALSO stay backed off!
      fs.writeFileSync(agAuthFile, JSON.stringify({ token: { access_token: 'weak-tier-2', refresh_token: 'weak-tier-rt', expiry: new Date(clock + 3600_000).toISOString() } }));
      await ag.read();
      assert.strictEqual(assistCalls, callsAfterChurn, 'adding refresh_token to a rotated weak token still respects the inherited tier Retry-After');
      clock += 301_000;
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsAfterChurn + 1, 'and resumes once Retry-After expires');
      // Two overlapping weak loadCodeAssist calls: a late shorter 60s failure must NOT shorten an active 600s Retry-After!
      {
        const savedFetchTier = global.fetch;
        let releaseLate60;
        let tierN = 0;
        let overlapCalls = 0;
        global.fetch = async (url) => {
          if (!url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => agSummary };
          overlapCalls++;
          const n = ++tierN;
          if (n === 1) return new Promise((r) => (releaseLate60 = () => r({ ok: false, status: 503, headers: new Headers({ 'retry-after': '60' }) })));
          if (n === 2) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) };
          return { ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) };
        };
        try {
          fs.writeFileSync(agAuthFile, JSON.stringify({ token: { access_token: 'ov-weak-1', expiry: new Date(clock + 7200_000).toISOString() } }));
          await ag.read(); // starts n=1 (held)
          fs.writeFileSync(agAuthFile, JSON.stringify({ token: { access_token: 'ov-weak-2', expiry: new Date(clock + 7200_000).toISOString() } }));
          await ag.read(); // starts n=2 -> settles immediately with 600s Retry-After
          await new Promise((r) => setImmediate(r));
          releaseLate60(); // n=1 settles late with 60s Retry-After
          await new Promise((r) => setImmediate(r));
          clock += 120_000; // past 60s, still well inside 600s!
          fs.writeFileSync(agAuthFile, JSON.stringify({ token: { access_token: 'ov-weak-3', expiry: new Date(clock + 7200_000).toISOString() } }));
          await ag.read();
          assert.strictEqual(overlapCalls, 2, 'late 60s tier response never shortens an active 600s Retry-After');
          clock += 500_000; // advance past 600s for subsequent tests
        } finally {
          global.fetch = savedFetchTier;
        }
      }
      // Round 7 Fix 2 (tier side): email + refresh_token 429 stays gated on loadCodeAssist even if email disappears and bearer rotates!
      const callsBeforeEmailDrop = assistCalls;
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'drop-email@example.com', token: { access_token: 'de-tok-1', refresh_token: 'de-rt-1', expiry: new Date(clock + 7200_000).toISOString() } }));
      assistMode = '429';
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeEmailDrop + 1);
      assistMode = 'ok';
      fs.writeFileSync(agAuthFile, JSON.stringify({ token: { access_token: 'de-tok-2', refresh_token: 'de-rt-1', expiry: new Date(clock + 7200_000).toISOString() } }));
      await ag.read();
      assert.strictEqual(assistCalls, callsBeforeEmailDrop + 1, 'tier Retry-After holds when email disappears and bearer rotates with same refresh_token');
      // Round 11 Fix 4: a refresh token first seen while loadCodeAssist is pending is covered by that lookup's 429, and
      // the email dropping mid-lookup never starts a second lookup for the same account.
      {
        const savedFetchR11 = global.fetch;
        const held = [];
        global.fetch = async (url) => {
          if (!url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => agSummary };
          return new Promise((r) => held.push(r));
        };
        const exp = new Date(clock + 7200_000).toISOString();
        const writeR11 = (cred) => fs.writeFileSync(agAuthFile, JSON.stringify(cred));
        try {
          writeR11({ id_token_email: 'r11-tier@example.com', token: { access_token: 'r11-tier-t1', expiry: exp } });
          await ag.read();
          writeR11({ id_token_email: 'r11-tier@example.com', token: { access_token: 'r11-tier-t1', refresh_token: 'r11-tier-rt', expiry: exp } });
          await ag.read();
          assert.strictEqual(held.length, 1, 'the same account and bearer joins the pending lookup');
          held[0]({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
          await new Promise((r) => setImmediate(r));
          writeR11({ token: { access_token: 'r11-tier-t2', refresh_token: 'r11-tier-rt', expiry: exp } });
          await ag.read();
          assert.strictEqual(held.length, 1, 'the refresh token seen during the pending lookup stays under its 429');

          writeR11({ id_token_email: 'r11-dedupe@example.com', token: { access_token: 'r11-dedupe-t1', refresh_token: 'r11-dedupe-rt', expiry: exp } });
          await ag.read();
          assert.strictEqual(held.length, 2);
          writeR11({ token: { access_token: 'r11-dedupe-t1', refresh_token: 'r11-dedupe-rt', expiry: exp } });
          await ag.read();
          assert.strictEqual(held.length, 2, 'dropping the email mid-lookup does not start a second lookup for the account');
          held[1]({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
          await new Promise((r) => setImmediate(r));
        } finally {
          global.fetch = savedFetchR11;
        }
      }
      // The same `__weak__` rule on the tier side: A's 429, carried onto `__weak__` when A shows its bare bearer, holds
      // back a bare bearer nothing names but not C's bare bearer, which C's email came with.
      {
        const savedFetchWeak = global.fetch;
        const tierBearers = [];
        global.fetch = async (url, options) => {
          if (!url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => agSummary };
          tierBearers.push(options.headers.Authorization);
          if (options.headers.Authorization === 'Bearer r11-tw-a1') return { ok: false, status: 429, headers: new Headers({ 'retry-after': '180' }) };
          return { ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) };
        };
        const exp = new Date(clock + 7200_000).toISOString();
        const readAs = async (email, access) => {
          fs.writeFileSync(agAuthFile, JSON.stringify({ ...(email ? { id_token_email: email } : {}), token: { access_token: access, expiry: exp } }));
          await ag.read();
          await new Promise((r) => setImmediate(r));
        };
        try {
          await readAs('r11-tw-a@example.com', 'r11-tw-a1');
          await readAs(null, 'r11-tw-a1');
          await readAs(null, 'r11-tw-a2');
          assert.deepStrictEqual(tierBearers, ['Bearer r11-tw-a1'], 'A\'s bare bearer and a bare bearer nothing names stay under A\'s tier 429');
          await readAs('r11-tw-c@example.com', 'r11-tw-c1');
          await readAs(null, 'r11-tw-c1');
          assert.deepStrictEqual(tierBearers.slice(1), ['Bearer r11-tw-c1'], 'C\'s bare bearer is C\'s: it shares C\'s lookup (Round 16)');
          ag.onSignedOut(); // no plan on hand, so the bare bearer must look itself
          await readAs(null, 'r11-tw-c1');
          assert.deepStrictEqual(tierBearers.slice(1), ['Bearer r11-tw-c1', 'Bearer r11-tw-c1'], 'C\'s bare bearer is C\'s, not held by A');
          clock += 181_000; // past A's wait for the checks below
        } finally {
          global.fetch = savedFetchWeak;
        }
      }
      // Round 12 Fix 1 (tier side): a bare bearer that waited under A's tier 429 (left on `__weak__` by A's bare bearer)
      // is released once it is named as B. One a bearer nothing named drew still holds its rotation once that is named.
      {
        mod.clearAntigravityTierGates();
        const savedFetchR12 = global.fetch;
        const tierBearers = [];
        global.fetch = async (url, options) => {
          if (!url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => agSummary };
          tierBearers.push(options.headers.Authorization);
          if (/ r12-tw-(a1|w1)$/.test(options.headers.Authorization)) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '180' }) };
          return { ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) };
        };
        const readAs = async (email, access) => {
          fs.writeFileSync(agAuthFile, JSON.stringify({ ...(email ? { id_token_email: email } : {}), token: { access_token: access, expiry: new Date(clock + 7200_000).toISOString() } }));
          await ag.read();
          await new Promise((r) => setImmediate(r));
        };
        try {
          await readAs(null, 'r12-tw-w1');
          await readAs(null, 'r12-tw-w2');
          await readAs('r12-tw-w@example.com', 'r12-tw-w2');
          assert.deepStrictEqual(tierBearers, ['Bearer r12-tw-w1'], 'an unnamed bearer\'s tier 429 holds its bare rotation, named or not');
          clock += 181_000;
          await readAs('r12-tw-a@example.com', 'r12-tw-a1');
          await readAs(null, 'r12-tw-a1');
          await readAs(null, 'r12-tw-b1');
          assert.deepStrictEqual(tierBearers.slice(1), ['Bearer r12-tw-a1'], 'a bare bearer nothing names waits under A\'s tier 429');
          await readAs('r12-tw-b@example.com', 'r12-tw-b1');
          assert.deepStrictEqual(tierBearers.slice(2), ['Bearer r12-tw-b1'], 'named as B, it is no longer held by A\'s wait');
          await readAs('r12-tw-a@example.com', 'r12-tw-a2');
          assert.strictEqual(tierBearers.length, 3, 'A still is');
          clock += 181_000;
        } finally {
          global.fetch = savedFetchR12;
        }
      }
      // Back to d@example.com whose 360s deadline has now elapsed too.
      const callsBeforeDResume = assistCalls;
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'd@example.com', token: { access_token: 'ag-tok-4', expiry: new Date(clock + 3600_000).toISOString() } }));
      await ag.read();
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(assistCalls, callsBeforeDResume + 1);

      // 401 is session expired; plain 403 is access denied; 403 with UNAUTHENTICATED status or later token-expired
      // reason is session expired (even past 8 KiB); stalled 403 near the 15s deadline never retries or turns into
      // TimeoutError, and cancels its stream reader cleanly.
      quotaStatus = 401;
      const unauth = await ag.read();
      assert.match(unauth.error, /Session expired/);
      assert.ok(!unauth.soft && unauth.renewsFor);
      quotaStatus = 403;
      quotaBodyText = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SUBSCRIPTION_REQUIRED' }] } });
      const denied = await ag.read();
      assert.match(denied.error, /access denied/i, 'plain 403 reports access denied, not session expiry');
      assert.ok(!denied.soft && denied.renewsFor);
      quotaBodyText = JSON.stringify({ error: { status: 'UNAUTHENTICATED', details: [{ reason: 'ACCESS_TOKEN_INVALID' }] } });
      assert.match((await ag.read()).error, /Session expired/, '403 with UNAUTHENTICATED status and ACCESS_TOKEN_INVALID reports session expiry');
      quotaBodyText = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'OTHER' }, { reason: 'ACCESS_TOKEN_EXPIRED' }] } });
      assert.match((await ag.read()).error, /Session expired/, '403 with token-expired reason in a later detail still reports session expiry');
      quotaBodyText = JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'x'.repeat(10_000), details: [{ reason: 'ACCESS_TOKEN_EXPIRED' }] } });
      assert.match((await ag.read()).error, /Session expired/, 'valid 403 JSON larger than 8 KiB still parses as session expired');
      // ReadableStream body that stalls after headers near the outer deadline: cancels reader, preserves HTTP 403, makes only 1 call.
      {
        const savedFetch403 = global.fetch;
        let calls403 = 0;
        let cancelled = false;
        let aborted = false;
        global.fetch = async (url, opts) => {
          if (url.endsWith(':loadCodeAssist')) return { ok: true, json: async () => ({}) };
          calls403++;
          opts.signal?.addEventListener('abort', () => (aborted = true));
          const body = new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode('{"error":'));
            },
            cancel() {
              cancelled = true;
            },
          });
          return { ok: false, status: 403, headers: new Headers(), body };
        };
        try {
          const stalledStream = await ag.read();
          assert.strictEqual(calls403, 1, 'stalled 403 body never triggers a retry');
          assert.match(stalledStream.error, /access denied/i, 'stalled 403 stream still reports hard access denied');
          assert.ok(!stalledStream.soft);
          assert.ok(cancelled && aborted, 'stalled 403 stream reader is cancelled and request aborted');
        } finally {
          global.fetch = savedFetch403;
        }
      }
      quotaBodyText = null;
      quotaStatus = 429;
      const limited = await ag.read();
      assert.deepStrictEqual([limited.soft, limited.retryAfter, !!limited.renewsFor], [true, 75, true]);
      quotaStatus = 200;

      // Expired token without refresh_token fails hard without hitting the network; with refresh_token it returns soft.
      sentAuth.length = 0;
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'c@example.com', token: { access_token: 'ag-tok-3', expiry: '2020-01-01T00:00:00Z' } }));
      const exp = await ag.read();
      assert.match(exp.error, /Session expired/);
      assert.ok(!exp.soft && exp.renewsFor && sentAuth.length === 0, 'expired token makes no request');
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'c@example.com', token: { access_token: 'ag-tok-3', refresh_token: 'ag-rt-3', expiry: '2020-01-01T00:00:00Z' } }));
      const expSoft = await ag.read();
      assert.ok(expSoft.soft && expSoft.authError && !expSoft.tokenHash && expSoft.renewsFor && sentAuth.length === 0, 'expired refreshable token is soft and makes no request');
      // 401 / auth-403 on a refreshable token returns soft (still carrying tokenHash for main.js sequencing); plain 403 stays hard.
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'c@example.com', token: { access_token: 'ag-tok-3b', refresh_token: 'ag-rt-3', expiry: new Date(clock + 3600_000).toISOString() } }));
      quotaStatus = 401;
      const unauthSoft = await ag.read();
      assert.ok(unauthSoft.soft && unauthSoft.authError && unauthSoft.tokenHash && unauthSoft.renewsFor, '401 on refreshable token is soft and carries tokenHash');
      quotaStatus = 403;
      quotaBodyText = JSON.stringify({ error: { status: 'UNAUTHENTICATED', details: [{ reason: 'ACCESS_TOKEN_EXPIRED' }] } });
      const auth403Soft = await ag.read();
      assert.ok(auth403Soft.soft && auth403Soft.authError && auth403Soft.tokenHash, 'auth-403 on refreshable token is soft and carries tokenHash');
      quotaBodyText = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SUBSCRIPTION_REQUIRED' }] } });
      const perm403Hard = await ag.read();
      assert.ok(!perm403Hard.soft && !perm403Hard.authError && perm403Hard.tokenHash && /access denied/i.test(perm403Hard.error), 'plain 403 on refreshable token stays hard');
      quotaBodyText = null;
      quotaStatus = 200;
      sentAuth.length = 0;

      // Missing or broken credentials mark signedOut cleanly without hitting the network.
      for (const body of ['{}', 'bad json', null]) {
        if (body === null) fs.rmSync(agAuthFile, { force: true });
        else fs.writeFileSync(agAuthFile, body);
        const r = await ag.read();
        assert.ok(r.signedOut && !r.soft && sentAuth.length === 0, 'missing or invalid cred marks signedOut without network');
      }

      // Windows Credential Manager error/absence/invalid paths: only confirmed absence (not_found) falls back to file.
      delete process.env.ANTIGRAVITY_AUTH_FILE;
      fs.mkdirSync(path.dirname(agCliFallback), { recursive: true });
      fs.writeFileSync(agCliFallback, JSON.stringify({ id_token_email: 'fallback@example.com', token: { access_token: 'fallback-tok', expiry: new Date(clock + 3600_000).toISOString() } }));

      // Helper timeout / Win32 failure: soft error, MUST NOT fall back to the stale file!
      sentAuth.length = 0;
      mod.setAntigravityCredReader(async () => ({ status: 'error', message: 'Antigravity credential lookup timed out' }));
      const timedOut = await ag.read();
      assert.ok(timedOut.soft && /timed out/.test(timedOut.error), 'Windows helper timeout is soft');
      assert.strictEqual(sentAuth.length, 0, 'timeout never falls back to another account in the CLI file');

      // Corrupted Windows cred: hard error, MUST NOT fall back to the stale file!
      mod.setAntigravityCredReader(async () => ({ status: 'invalid' }));
      const corrupt = await ag.read();
      assert.ok(!corrupt.soft && corrupt.signedOut && /unreadable/i.test(corrupt.error));
      assert.strictEqual(sentAuth.length, 0, 'corrupt Windows cred never falls back to the CLI file');

      // Confirmed absence (ERROR_NOT_FOUND): falls back to the CLI file.
      mod.setAntigravityCredReader(async () => ({ status: 'not_found' }));
      const fromFallback = await ag.read();
      assert.strictEqual(fromFallback.rows.length, 4, 'confirmed Windows absence falls back to CLI token file');
      assert.ok(sentAuth.some(([, a]) => a === 'Bearer fallback-tok'));

      // Confirmed absence with no CLI file: signedOut hard error.
      fs.rmSync(agCliFallback, { force: true });
      sentAuth.length = 0;
      const absent = await ag.read();
      assert.ok(absent.signedOut && /No Antigravity credentials/.test(absent.error) && sentAuth.length === 0);

      // Valid Windows cred wins over any CLI file.
      fs.writeFileSync(agCliFallback, JSON.stringify({ token: { access_token: 'fallback-tok' } }));
      mod.setAntigravityCredReader(async () => ({ status: 'ok', data: { id_token_email: 'win@example.com', token: { access_token: 'win-tok', expiry: new Date(clock + 3600_000).toISOString() } } }));
      await ag.read();
      assert.ok(sentAuth.some(([, a]) => a === 'Bearer win-tok'));

      // T3 Code provider store (~/.t3/userdata/providers/antigravity/*/antigravity-acp/antigravity-oauth-token):
      // beats an expired or older Windows cred, yields to a fresher Windows cred, ignores corrupt sibling dirs,
      // never bypasses Windows helper timeout/corruption, and yields to explicit ANTIGRAVITY_AUTH_FILE.
      const t3Root = path.join(codexHome, '.t3', 'userdata', 'providers', 'antigravity');
      const t3FileA = path.join(t3Root, 'inst-a', 'antigravity-acp', 'antigravity-oauth-token');
      const t3FileB = path.join(t3Root, 'inst-b', 'antigravity-acp', 'antigravity-oauth-token');
      const t3FileBad = path.join(t3Root, 'inst-bad', 'antigravity-acp', 'antigravity-oauth-token');
      for (const f of [t3FileA, t3FileB, t3FileBad]) fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(t3FileBad, '{broken json');
      fs.writeFileSync(t3FileA, JSON.stringify({ id_token_email: 'win@example.com', token: { access_token: 't3-expired', refresh_token: 'rt-1', expiry: new Date(clock - 10 * 60_000).toISOString() } }));
      fs.writeFileSync(t3FileB, JSON.stringify({ id_token_email: 'win@example.com', token: { access_token: 't3-fresh', refresh_token: 'rt-1', expiry: new Date(clock + 50 * 60_000).toISOString() } }));

      // Expired Windows cred + live T3 Code token -> picks live T3 token.
      sentAuth.length = 0;
      mod.setAntigravityCredReader(async () => ({ status: 'ok', data: { id_token_email: 'win@example.com', token: { access_token: 'win-expired', refresh_token: 'rt-1', expiry: new Date(clock - 40 * 60_000).toISOString() } } }));
      const fromT3OverExpiredWin = await ag.read();
      assert.strictEqual(fromT3OverExpiredWin.rows.length, 4, 'live T3 Code token supersedes expired Windows cred');
      assert.ok(sentAuth.some(([, a]) => a === 'Bearer t3-fresh'));

      // Live Windows cred older than live T3 Code token -> picks fresher T3 token.
      sentAuth.length = 0;
      mod.setAntigravityCredReader(async () => ({ status: 'ok', data: { id_token_email: 'win@example.com', token: { access_token: 'win-older', refresh_token: 'rt-1', expiry: new Date(clock + 10 * 60_000).toISOString() } } }));
      await ag.read();
      assert.ok(sentAuth.some(([, a]) => a === 'Bearer t3-fresh'), 'fresher live T3 Code token beats older live Windows cred');

      // Live Windows cred fresher than live T3 Code token -> Windows cred wins.
      sentAuth.length = 0;
      mod.setAntigravityCredReader(async () => ({ status: 'ok', data: { id_token_email: 'win@example.com', token: { access_token: 'win-newest', refresh_token: 'rt-1', expiry: new Date(clock + 60 * 60_000).toISOString() } } }));
      await ag.read();
      assert.ok(sentAuth.some(([, a]) => a === 'Bearer win-newest'), 'fresher live Windows cred beats older T3 Code token');

      // Confirmed Windows absence -> picks live T3 Code token even with expired + corrupt sibling T3 folders.
      sentAuth.length = 0;
      fs.rmSync(agCliFallback, { force: true });
      mod.setAntigravityCredReader(async () => ({ status: 'not_found' }));
      const fromT3Only = await ag.read();
      assert.strictEqual(fromT3Only.rows.length, 4, 'confirmed Windows absence uses live T3 Code token');
      assert.ok(sentAuth.some(([, a]) => a === 'Bearer t3-fresh'));

      // Windows helper timeout or corruption MUST NOT fall back to T3 Code token files.
      sentAuth.length = 0;
      mod.setAntigravityCredReader(async () => ({ status: 'error', message: 'Antigravity credential lookup timed out' }));
      assert.ok((await ag.read()).soft && sentAuth.length === 0, 'Windows timeout never falls back to T3 Code token');
      mod.setAntigravityCredReader(async () => ({ status: 'invalid' }));
      assert.ok((await ag.read()).signedOut && sentAuth.length === 0, 'corrupt Windows cred never falls back to T3 Code token');

      // Explicit ANTIGRAVITY_AUTH_FILE ignores T3 Code token files.
      sentAuth.length = 0;
      fs.writeFileSync(agAuthFile, JSON.stringify({ id_token_email: 'override@example.com', token: { access_token: 'override-tok', expiry: new Date(clock + 5 * 60_000).toISOString() } }));
      process.env.ANTIGRAVITY_AUTH_FILE = agAuthFile;
      await ag.read();
      assert.ok(sentAuth.some(([, a]) => a === 'Bearer override-tok') && !sentAuth.some(([, a]) => a === 'Bearer t3-fresh'), 'ANTIGRAVITY_AUTH_FILE overrides T3 Code token');
      delete process.env.ANTIGRAVITY_AUTH_FILE;
      fs.rmSync(path.join(codexHome, '.t3'), { recursive: true, force: true });
    } finally {
      Date.now = realNow;
      mod.setAntigravityCredReader(null);
      global.fetch = originalFetch;
      fs.rmSync(agCliFallback, { force: true });
      fs.rmSync(path.join(codexHome, '.t3'), { recursive: true, force: true });
      if (originalAgAuth === undefined) delete process.env.ANTIGRAVITY_AUTH_FILE;
      else process.env.ANTIGRAVITY_AUTH_FILE = originalAgAuth;
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
  .then(antigravityMainChecks)
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
// Integration checks for Antigravity in main.js with real PROVIDERS: startup cache hiding until credentials are
// verified (including phone /api/events), immediate clear on live account switch before the slow quota fetch
// settles, A -> B -> A per-account 429 gate persistence, access-token-only conservative gating, sign-out cache
// clearing, background tier folding, and /api/settings toggleProvider + older-APK upgrade protection.
async function antigravityMainChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-overlay-ag-main-'));
  const on = {};
  const beeps = [];
  let phoneHandler = null;
  const http = { createServer: (fn) => ((phoneHandler = fn), { on() { return this; }, listen() { return this; } }) };
  const electron = {
    app: { commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on: (e, fn) => (on[e] = fn), getPath: () => dir },
    ipcMain: { on() {}, handle() {} },
    globalShortcut: { unregisterAll() {} },
    Menu: { buildFromTemplate: (t) => t },
    screen: { getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }], getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    shell: { beep: () => beeps.push(1) },
    safeStorage: { encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
  };
  const providersMod = require('./providers');
  const agReal = providersMod.PROVIDERS.find((p) => p.id === 'antigravity');
  const origPeek = agReal.peekCred;
  let peekCalls = 0;
  let peekHook = null;
  const wrappedAg = { ...agReal, peekCred: (...a) => (peekCalls++, peekHook ? peekHook(() => origPeek(...a)) : origPeek(...a)) };
  const stubProviders = {
    ...providersMod,
    PROVIDERS: providersMod.PROVIDERS.map((p) => (p.id === 'antigravity' ? wrappedAg : { ...p, read: async () => ({ rows: [] }) })),
  };
  const loadInstance = () => {
    let handler = null;
    const instOn = {};
    const instSent = [];
    const instHttp = { createServer: (fn) => ((handler = fn), { on() { return this; }, listen() { return this; } }) };
    const instElectron = {
      ...electron,
      app: { ...electron.app, on: (e, fn) => (instOn[e] = fn) },
    };
    const m = { exports: {} };
    const s = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') + '\ntray = { setContextMenu() {} };\nmodule.exports = { readOne, loadState, snapshot, servePhone, last, gate, savedCache: () => cache, flushState, setWin: (w) => (win = w), credChecked, fetched };';
    new Function('require', 'module', '__dirname', s)((id) => (id === 'electron' ? instElectron : id === 'http' ? instHttp : id === './providers' ? stubProviders : require(id)), m, __dirname);
    m.exports.setWin({ isDestroyed: () => false, setBounds() {}, getBounds: () => ({ x: 0, y: 0, width: 300, height: 300 }), webContents: { send: (ch, v) => instSent.push([ch, v]) } });
    m.exports.servePhone();
    const askInst = (method, url, body) => new Promise((resolve) => {
      const req = { method, url, headers: { host: 'localhost', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, on() {}, async *[Symbol.asyncIterator]() { if (body !== undefined) yield body; } };
      let status = 200;
      let out = '';
      const res = { headersSent: false, writeHead(st) { status = st; this.headersSent = true; return this; }, write(c) { out += c; }, end(c) { out += c || ''; resolve({ status, body: out }); } };
      handler(req, res);
    });
    return { ...m.exports, on: instOn, sent: instSent, ask: askInst, handler };
  };
  const inst = loadInstance();
  const { readOne, loadState, snapshot, last, gate, savedCache, flushState, ask, sent, credChecked, fetched } = inst;
  Object.assign(on, inst.on);
  phoneHandler = inst.handler;
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const agMainAuth = path.join(dir, 'ag-main-auth.json');
  const savedAgEnv = process.env.ANTIGRAVITY_AUTH_FILE;
  const originalFetch = global.fetch;
  process.env.ANTIGRAVITY_AUTH_FILE = agMainAuth;
  let agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.17, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
  let agAssist = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } }) });
  let agQuotaCalls = 0;
  global.fetch = async (url) => (url.endsWith(':loadCodeAssist') ? agAssist() : (agQuotaCalls++, agQuota()));
  try {
    const writeAg = (email, tok, extra = {}) => fs.writeFileSync(agMainAuth, JSON.stringify({ id_token_email: email, token: { access_token: tok, expiry: new Date(Date.now() + 3600_000).toISOString(), ...extra } }));
    // Account A at 83%, slow tier folds in on next non-forced tick.
    writeAg('acct-a@example.com', 'tok-a');
    let holdTier;
    agAssist = () => new Promise((r) => (holdTier = () => r({ ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } }) })));
    await readOne(wrappedAg, true);
    assert.strictEqual(last.get('antigravity').rows[0].percent, 83);
    assert.strictEqual(last.get('antigravity').plan, '', 'quota landed before slow loadCodeAssist');
    holdTier();
    await new Promise((r) => setImmediate(r));
    await readOne(wrappedAg, false);
    assert.strictEqual(last.get('antigravity').plan, 'AI Ultra', 'background tier folds in on next tick');
    assert.strictEqual(agQuotaCalls, 1);

    // Trigger a desktop reset notice on Account A (83% -> 10%), then confirm switching to Account B clears it.
    agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
    await readOne(wrappedAg, true);
    assert.ok(sent.some(([ch, v]) => ch === 'reset' && v?.id === 'antigravity'), 'reset notice sent for Account A');
    sent.length = 0;

    // Live switch A -> B while B's quota request is slow: A's data and desktop reset notice clear IMMEDIATELY before B settles!
    writeAg('acct-b@example.com', 'tok-b');
    agAssist = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
    let releaseBQuota;
    agQuota = () => new Promise((r) => (releaseBQuota = () => r({ ok: false, status: 503, headers: new Headers() })));
    const readingB = readOne(wrappedAg, true);
    for (let i = 0; i < 50 && !releaseBQuota; i++) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(last.get('antigravity'), undefined, 'live switch to B clears A\'s 83% BEFORE B\'s quota settles');
    assert.strictEqual(snapshot().find((p) => p.id === 'antigravity').rows.length, 0);
    assert.ok(sent.some(([ch, v]) => ch === 'reset' && v === null), 'account switch clears the desktop reset notice');
    releaseBQuota();
    await readingB;
    assert.strictEqual(last.get('antigravity'), undefined);
    assert.strictEqual(savedCache().antigravity, undefined);

    // Account B's first good reading at 5% triggers no false reset beep.
    const beepsBefore = beeps.length;
    agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
    await readOne(wrappedAg, true);
    assert.strictEqual(last.get('antigravity').rows[0].percent, 5);
    assert.strictEqual(beeps.length, beepsBefore, 'no false reset beep on first reading of account B');

    // Mid-flight account switch (with manual refresh): A's held response must be superseded by B and discarded when it resolves late.
    let releaseAHeld;
    writeAg('acct-a@example.com', 'tok-a');
    agQuota = () => new Promise((r) => (releaseAHeld = () => r({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.11, resetTime: '2026-11-20T02:01:25Z' }] }] }) })));
    const inflightA = readOne(wrappedAg, true);
    for (let i = 0; i < 50 && !releaseAHeld; i++) await new Promise((r) => setTimeout(r, 5));
    writeAg('acct-b@example.com', 'tok-b');
    agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.88, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
    await readOne(wrappedAg, true);
    assert.strictEqual(last.get('antigravity').rows[0].percent, 12, 'manual refresh during A\'s slow fetch supersedes A and loads B');
    releaseAHeld();
    await inflightA;
    assert.strictEqual(last.get('antigravity').rows[0].percent, 12, 'A\'s late-resolving response is discarded and never overwrites B');
    assert.strictEqual(savedCache().antigravity.rows[0].percent, 12);

    // Mid-flight silent switch (without manual refresh): A's response resolves after switching to C and is discarded!
    let releaseASilent;
    writeAg('acct-a@example.com', 'tok-a');
    agQuota = () => new Promise((r) => (releaseASilent = () => r({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.2, resetTime: '2026-11-20T02:01:25Z' }] }] }) })));
    const silentA = readOne(wrappedAg, true);
    for (let i = 0; i < 50 && !releaseASilent; i++) await new Promise((r) => setTimeout(r, 5));
    writeAg('acct-c@example.com', 'tok-c');
    releaseASilent();
    await silentA;
    assert.strictEqual(last.get('antigravity'), undefined, 'silent mid-flight switch discards stale A response');

    // Race 1a: Account A's post-fetch peekCred completes LATE (still reporting A) after a newer refresh loaded Account B:
    // A's late response MUST NOT overwrite Account B!
    {
      writeAg('acct-a@example.com', 'tok-a');
      let holdPostPeek = true;
      let releasePostPeek = null;
      let peekStep = 0;
      peekHook = (orig) => {
        peekStep++;
        if (peekStep === 2 && holdPostPeek) {
          holdPostPeek = false;
          const snap = orig(); // snapshot acct-a BEFORE switching to acct-b
          return new Promise((r) => (releasePostPeek = () => r(snap)));
        }
        return orig();
      };
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.1, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      const reqA = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releasePostPeek; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(releasePostPeek, 'Account A paused at post-fetch peekCred');
      writeAg('acct-b@example.com', 'tok-b');
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.88, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await readOne(wrappedAg, true);
      assert.strictEqual(last.get('antigravity').rows[0].percent, 12, 'Account B loaded while A post-fetch check was pending');
      releasePostPeek();
      await reqA;
      peekHook = null;
      assert.strictEqual(last.get('antigravity').rows[0].percent, 12, 'A\'s delayed post-fetch peekCred never overwrites B');
    }

    // Race 1b: Delayed manual sign-out check started while A was in flight resolves AFTER A finishes and a newer refresh loaded B:
    // the stale sign-out check MUST NOT erase B!
    {
      writeAg('acct-a@example.com', 'tok-a');
      let releaseFetchA;
      agQuota = () => new Promise((r) => (releaseFetchA = () => r({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-20T02:01:25Z' }] }] }) })));
      const inflightA2 = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseFetchA; i++) await new Promise((r) => setTimeout(r, 5));
      let releaseDelayedSignout;
      peekHook = () => {
        peekHook = null;
        return new Promise((r) => (releaseDelayedSignout = () => r({ status: 'signed_out', error: 'No Antigravity credentials — open Antigravity to sign in.', signedOut: true })));
      };
      const staleSignout = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseDelayedSignout; i++) await new Promise((r) => setTimeout(r, 5));
      releaseFetchA();
      await inflightA2;
      writeAg('acct-b@example.com', 'tok-b');
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.88, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await readOne(wrappedAg, true);
      assert.strictEqual(last.get('antigravity').rows[0].percent, 12);
      releaseDelayedSignout();
      await staleSignout;
      assert.strictEqual(last.get('antigravity').rows[0].percent, 12, 'delayed manual sign-out check never erases newer Account B');
    }

    // Race 1c (Fix 1): Post-fetch peekCred fails (timeout) after Account A's quota arrives -> MUST NOT publish A's response!
    {
      writeAg('acct-post-err@example.com', 'tok-pe');
      let step = 0;
      peekHook = (orig) => (++step === 2 ? Promise.resolve({ status: 'error', error: 'timeout', soft: true }) : orig());
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.05, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await readOne(wrappedAg, true);
      peekHook = null;
      assert.strictEqual(last.get('antigravity'), undefined, 'failed post-fetch credential check never publishes unverified quota');
      assert.strictEqual(savedCache().antigravity, undefined);
    }

    // Race 1d (Fix 4): Stale signed_out peekCred discarded by generation check MUST NOT cancel the new account's pending loadCodeAssist!
    {
      writeAg('acct-a@example.com', 'tok-a');
      let releaseFetchA;
      agQuota = () => new Promise((r) => (releaseFetchA = () => r({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-20T02:01:25Z' }] }] }) })));
      const inflightOld = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseFetchA; i++) await new Promise((r) => setTimeout(r, 5));
      let releaseStaleSignout;
      peekHook = () => {
        peekHook = null;
        // Call the real peekCred on a missing file so we test that peekAntigravityCred itself has NO tier-clearing side effect!
        return new Promise((r) => (releaseStaleSignout = async () => {
          const backup = fs.readFileSync(agMainAuth);
          fs.rmSync(agMainAuth, { force: true });
          const res = await origPeek();
          fs.writeFileSync(agMainAuth, backup);
          r(res);
        }));
      };
      const staleOut = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseStaleSignout; i++) await new Promise((r) => setTimeout(r, 5));
      releaseFetchA();
      await inflightOld;
      // New account loads with a held loadCodeAssist.
      writeAg('acct-tier-keep@example.com', 'tok-tk');
      let releaseNewTier;
      agAssist = () => new Promise((r) => (releaseNewTier = () => r({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) })));
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await readOne(wrappedAg, true);
      assert.ok(releaseNewTier, 'new account loadCodeAssist started');
      // Now the stale sign-out peek resolves (after generation moved on) -> MUST NOT cancel new account's pending tier!
      await releaseStaleSignout();
      await staleOut;
      releaseNewTier();
      await new Promise((r) => setImmediate(r));
      await readOne(wrappedAg, false);
      assert.strictEqual(last.get('antigravity').plan, 'AI Pro', 'discarded stale sign-out check never cancels the new account\'s plan lookup');
      agAssist = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
    }

    // Race 1e (Fix 3): Token rotation on the SAME account during an in-flight 401 (both with and without manual refresh).
    {
      const savedFetchRot = global.fetch;
      let releaseOldTok;
      global.fetch = async (url, opts) => {
        if (url.endsWith(':loadCodeAssist')) return agAssist();
        agQuotaCalls++;
        if (opts?.headers?.Authorization === 'Bearer tok-rot-old') {
          if (releaseOldTok === false) await new Promise((r) => (releaseOldTok = r));
          return { ok: false, status: 401, headers: new Headers() };
        }
        return { ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: '2026-11-20T02:01:25Z' }] }] }) };
      };
      try {
        // Case A: manual refresh with rotated replacement token supersedes the in-flight old-token 401.
        writeAg('acct-rot@example.com', 'tok-rot-old');
        releaseOldTok = false;
        const oldInflight = readOne(wrappedAg, true);
        for (let i = 0; i < 50 && releaseOldTok === false; i++) await new Promise((r) => setTimeout(r, 5));
        writeAg('acct-rot@example.com', 'tok-rot-new');
        await readOne(wrappedAg, true);
        assert.strictEqual(last.get('antigravity').rows[0].percent, 25, 'manual refresh with rotated token supersedes old-token request');
        releaseOldTok();
        await oldInflight;
        assert.strictEqual(last.get('antigravity').rows[0].percent, 25, 'old token 401 never overwrites rotated token reading');

        // Case B: no manual refresh — token rotates on disk while old-token request returns 401; readFresh rechecks with new token!
        writeAg('acct-rot@example.com', 'tok-rot-old');
        releaseOldTok = false;
        const bgOld = readOne(wrappedAg, true);
        for (let i = 0; i < 50 && releaseOldTok === false; i++) await new Promise((r) => setTimeout(r, 5));
        writeAg('acct-rot@example.com', 'tok-rot-new');
        releaseOldTok();
        await bgOld;
        assert.strictEqual(last.get('antigravity').rows[0].percent, 25, 'background 401 after token rotation rechecks with current token instead of reporting Session expired');
      } finally {
        global.fetch = savedFetchRot;
      }
    }

    // Round 6 Fix 1: Re-enabling Antigravity after disabling and switching accounts hides A's rows immediately and verifies B without waiting 5m.
    {
      writeAg('acct-reenable-a@example.com', 'tok-ra');
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.17, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await readOne(wrappedAg, true);
      assert.strictEqual(last.get('antigravity').rows[0].percent, 83);
      await ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: false } }));
      writeAg('acct-reenable-b@example.com', 'tok-rb');
      let releaseReenableB;
      agQuota = () => new Promise((r) => (releaseReenableB = () => r({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.85, resetTime: '2026-11-20T02:01:25Z' }] }] }) })));
      sent.length = 0;
      const reenabled = JSON.parse((await ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: true } }))).body);
      assert.strictEqual(reenabled.providers.find((p) => p.id === 'antigravity').rows.length, 0, 're-enabling hides previous account rows from immediate phone payload');
      const desktopPush = sent.find(([ch, d]) => ch === 'data' && d.some((p) => p.id === 'antigravity'));
      assert.strictEqual(desktopPush[1].find((p) => p.id === 'antigravity').rows.length, 0, 'and from immediate desktop broadcast');
      assert.ok(desktopPush[1].every((p) => typeof p.color2 === 'string' && p.color2), "every provider, a hidden one too, carries its bar's second stop");
      for (let i = 0; i < 50 && !releaseReenableB; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(releaseReenableB, 're-enabling verifies credentials and fetches B immediately despite recent 5m fetch');
      releaseReenableB();
      await new Promise((r) => setTimeout(r, 20));
      assert.strictEqual(last.get('antigravity').rows[0].percent, 15, 'Account B usage lands after re-enable verification');
    }

    // Round 6 Fix 2: Earlier manual refresh holding old Account A credential MUST NOT undo a post-fetch confirmed sign-out.
    {
      writeAg('acct-so-race@example.com', 'tok-sor');
      let releaseQuota;
      agQuota = () => new Promise((r) => (releaseQuota = () => r({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.3, resetTime: '2026-11-20T02:01:25Z' }] }] }) })));
      const req1 = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseQuota; i++) await new Promise((r) => setTimeout(r, 5));
      const oldCredSnap = await origPeek();
      let releaseStaleManual;
      let hookOnce = true;
      peekHook = (orig) => {
        if (hookOnce) {
          hookOnce = false;
          return new Promise((r) => (releaseStaleManual = () => r(oldCredSnap)));
        }
        return orig();
      };
      const manualRace = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseStaleManual; i++) await new Promise((r) => setTimeout(r, 5));
      fs.rmSync(agMainAuth, { force: true });
      releaseQuota();
      await req1;
      assert.ok(last.get('antigravity').signedOut, 'post-fetch sign-out accepted');
      const callsAfterSignout = agQuotaCalls;
      releaseStaleManual();
      await manualRace;
      peekHook = null;
      assert.strictEqual(agQuotaCalls, callsAfterSignout, 'stale manual refresh does not send another quota request after post-fetch sign-out');
      assert.ok(last.get('antigravity').signedOut, 'sign-out state remains intact');
    }

    // Round 6 Fix 3 + Round 7 Fix 3: 429 Retry-After is recorded BEFORE post-fetch peekCred, so token rotation during
    // that lookup cannot bypass it, AND the replacement read clears `fetched` so polling resumes right at Retry-After (not 5m).
    {
      writeAg('acct-429-race@example.com', 'tok-429-1', { refresh_token: 'rt-429-race' });
      let releasePost429;
      let step = 0;
      peekHook = (orig) => {
        step++;
        if (step === 2) return new Promise((r) => (releasePost429 = () => r(orig())));
        return orig();
      };
      agQuota = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
      const first429 = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releasePost429; i++) await new Promise((r) => setTimeout(r, 5));
      assert.ok(releasePost429, 'paused at post-fetch peekCred after 429');
      const callsAt429 = agQuotaCalls;
      writeAg('acct-429-race@example.com', 'tok-429-2', { refresh_token: 'rt-429-race' });
      await readOne(wrappedAg, true);
      assert.strictEqual(agQuotaCalls, callsAt429, 'token rotation + manual refresh during post-fetch peekCred cannot bypass 429 Retry-After');
      assert.strictEqual(fetched.get('antigravity'), undefined, 'replacement read accepting 429 clears fetched so polling resumes when Retry-After lifts');
      // Round 7 Fix 2 (quota side): dropping id_token_email while rotating bearer with unchanged refresh_token still matches 429 Retry-After!
      fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'tok-429-3', refresh_token: 'rt-429-race', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
      await readOne(wrappedAg, true);
      assert.strictEqual(agQuotaCalls, callsAt429, 'dropping email while rotating bearer with same refresh_token still respects quota Retry-After');
      releasePost429();
      await first429;
      peekHook = null;
    }

    // Round 7 Fix 1: Stale manual refresh for Account A held while background refresh verifies and caches Account B
    // MUST NOT erase B's cache or send another quota request with A's credentials.
    {
      writeAg('acct-bg-a@example.com', 'tok-bga');
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.25, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await readOne(wrappedAg, true);
      const staleCredA = await origPeek();
      // Prepare background refresh after switching disk to B.
      writeAg('acct-bg-b@example.com', 'tok-bgb');
      fetched.delete('antigravity');
      let releaseBgPeek;
      let releaseManualPeek;
      let step = 0;
      peekHook = (orig) => {
        step++;
        if (step === 1) return new Promise((r) => (releaseBgPeek = () => r(orig())));
        if (step === 2) return new Promise((r) => (releaseManualPeek = () => r(staleCredA)));
        return orig();
      };
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.82, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      const bgRead = readOne(wrappedAg, false);
      for (let i = 0; i < 50 && !releaseBgPeek; i++) await new Promise((r) => setTimeout(r, 5));
      const staleManual = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseManualPeek; i++) await new Promise((r) => setTimeout(r, 5));
      releaseBgPeek();
      await bgRead;
      assert.strictEqual(last.get('antigravity').rows[0].percent, 18, 'background refresh verified and cached Account B');
      const callsAfterB = agQuotaCalls;
      releaseManualPeek();
      await staleManual;
      peekHook = null;
      assert.strictEqual(agQuotaCalls, callsAfterB, 'stale manual refresh for A does not send another quota request');
      assert.strictEqual(last.get('antigravity').rows[0].percent, 18, 'Account B stays live');
      assert.strictEqual(savedCache().antigravity.rows[0].percent, 18, 'Account B stays cached');
    }

    // Round 8 Fix 1: Delayed manual sign-out during a 401 token-rotation retry MUST NOT erase cache or discard the retry.
    {
      const savedFetchR8 = global.fetch;
      let releaseOld401;
      let releaseRetryOk;
      global.fetch = async (url, opts) => {
        if (url.endsWith(':loadCodeAssist')) return agAssist();
        agQuotaCalls++;
        if (opts?.headers?.Authorization === 'Bearer r8-old-tok') {
          await new Promise((r) => (releaseOld401 = r));
          return { ok: false, status: 401, headers: new Headers() };
        }
        await new Promise((r) => (releaseRetryOk = r));
        return { ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.67, resetTime: '2026-11-20T02:01:25Z' }] }] }) };
      };
      try {
        writeAg('acct-r8-retry@example.com', 'r8-old-tok');
        const reqRetry = readOne(wrappedAg, true);
        for (let i = 0; i < 50 && !releaseOld401; i++) await new Promise((r) => setTimeout(r, 5));
        let releaseDelayedOut;
        let hookOnce = true;
        peekHook = (orig) => {
          if (hookOnce) {
            hookOnce = false;
            return new Promise((r) => (releaseDelayedOut = () => r({ status: 'signed_out', error: 'No Antigravity credentials — open Antigravity to sign in.', signedOut: true })));
          }
          return orig();
        };
        const staleManualOut = readOne(wrappedAg, true);
        for (let i = 0; i < 50 && !releaseDelayedOut; i++) await new Promise((r) => setTimeout(r, 5));
        writeAg('acct-r8-retry@example.com', 'r8-new-tok');
        releaseOld401();
        for (let i = 0; i < 50 && !releaseRetryOk; i++) await new Promise((r) => setTimeout(r, 5));
        assert.ok(releaseRetryOk, 'token-rotation retry started with new token');
        releaseDelayedOut();
        await new Promise((r) => setTimeout(r, 10)); // let the stale sign-out check run while the retry is still in flight
        releaseRetryOk();
        await Promise.all([staleManualOut, reqRetry]);
        peekHook = null;
        assert.strictEqual(last.get('antigravity').rows[0].percent, 33, 'delayed manual sign-out did not discard the successful retry');
        assert.strictEqual(savedCache().antigravity.rows[0].percent, 33);
      } finally {
        global.fetch = savedFetchR8;
      }
    }

    // Round 8 Fix 2: Email-only 429 whose post-fetch check sees email + refresh_token persists the deadline under the refresh_token too.
    {
      writeAg('acct-r8-rt@example.com', 'r8-rt-t1');
      let release429;
      agQuota = () => new Promise((r) => (release429 = () => r({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) })));
      const req = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !release429; i++) await new Promise((r) => setTimeout(r, 5));
      writeAg('acct-r8-rt@example.com', 'r8-rt-t1', { refresh_token: 'r8-rt-secret' });
      release429();
      await req;
      const callsAfter429 = agQuotaCalls;
      // Drop email and rotate bearer while keeping refresh_token: MUST stay blocked inside Retry-After!
      fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'r8-rt-t2', refresh_token: 'r8-rt-secret', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
      await readOne(wrappedAg, true);
      assert.strictEqual(agQuotaCalls, callsAfter429, 'newly verified refresh_token from post-fetch check retains the 429 cooldown');
    }

    // Round 8 Fix 3: A superseded request returning a late 120s 429 after its replacement succeeded for the same account
    // arms `gate` and clears `fetched` so automatic polling resumes at 120s instead of waiting 5 minutes.
    {
      const savedFetchLate = global.fetch;
      let releaseLate429;
      global.fetch = async (url, opts) => {
        if (url.endsWith(':loadCodeAssist')) return agAssist();
        agQuotaCalls++;
        if (opts?.headers?.Authorization === 'Bearer late429-t1') {
          await new Promise((r) => (releaseLate429 = r));
          return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
        }
        return { ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.6, resetTime: '2026-11-20T02:01:25Z' }] }] }) };
      };
      try {
        writeAg('acct-late429@example.com', 'late429-t1');
        const req1 = readOne(wrappedAg, true);
        for (let i = 0; i < 50 && !releaseLate429; i++) await new Promise((r) => setTimeout(r, 5));
        writeAg('acct-late429@example.com', 'late429-t2');
        await readOne(wrappedAg, true);
        assert.strictEqual(last.get('antigravity').rows[0].percent, 40, 'replacement succeeded for same account');
        assert.ok(fetched.get('antigravity') > 0 && !gate.has('antigravity'));
        releaseLate429();
        await req1;
        assert.ok(gate.get('antigravity') > Date.now() + 100_000, 'late 429 for active account arms gate');
        assert.strictEqual(fetched.get('antigravity'), undefined, 'late 429 clears fetched so polling resumes when Retry-After lifts');
      } finally {
        global.fetch = savedFetchLate;
      }
    }

    // Round 9 Fix 1: Newer manual sign-out check finishing AFTER an in-flight quota read's post-fetch check bumps
    // generation MUST recheck current credentials and clear quota + cache instead of dropping the sign-out.
    {
      writeAg('acct-r9-so@example.com', 'r9-so-tok');
      const signedInSnap = await origPeek();
      let releasePostPeek;
      let releaseManualPeek;
      let step = 0;
      peekHook = (orig) => {
        step++;
        if (step === 2) return new Promise((r) => (releasePostPeek = () => r(signedInSnap)));
        if (step === 3) return new Promise((r) => (releaseManualPeek = () => r(orig())));
        return orig();
      };
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.2, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      const reqInflight = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releasePostPeek; i++) await new Promise((r) => setTimeout(r, 5));
      // User signs out and clicks manual refresh while post-fetch peek (holding signed-in snap) is pending.
      fs.rmSync(agMainAuth, { force: true });
      const manualSignout = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseManualPeek; i++) await new Promise((r) => setTimeout(r, 5));
      // Post-fetch check finishes FIRST, advancing generation and publishing A's 80%.
      releasePostPeek();
      await reqInflight;
      assert.strictEqual(last.get('antigravity').rows[0].percent, 80);
      // Manual refresh finishes SECOND (crossing the generation bump): rechecks disk and clears quota + cache!
      releaseManualPeek();
      await manualSignout;
      peekHook = null;
      assert.ok(last.get('antigravity').signedOut, 'manual refresh crossing generation bump rechecks and applies sign-out');
      assert.strictEqual(savedCache().antigravity, undefined, 'and clears the disk cache');
    }

    // Round 9 Fix 2a & 2b: Late 429 matches active credential's verified aliases (even when email was added or removed)
    // and persists cooldown across all active aliases + arms `gate` and clears `fetched`.
    {
      const savedFetchR9 = global.fetch;
      let releaseLate1;
      let releaseLate2;
      global.fetch = async (url, opts) => {
        if (url.endsWith(':loadCodeAssist')) return agAssist();
        agQuotaCalls++;
        if (opts?.headers?.Authorization === 'Bearer r9-a-t1') {
          await new Promise((r) => (releaseLate1 = r));
          return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
        }
        if (opts?.headers?.Authorization === 'Bearer r9-b-t1') {
          await new Promise((r) => (releaseLate2 = r));
          return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
        }
        return { ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.55, resetTime: '2026-11-20T02:01:25Z' }] }] }) };
      };
      try {
        // 2a: Email-only Request 1 superseded by email + refresh_token Request 2 -> Request 1 returns late 429 ->
        // email disappears & bearer rotates -> manual refresh stays blocked inside 120s cooldown!
        writeAg('acct-r9-a@example.com', 'r9-a-t1');
        const reqA1 = readOne(wrappedAg, true);
        for (let i = 0; i < 50 && !releaseLate1; i++) await new Promise((r) => setTimeout(r, 5));
        writeAg('acct-r9-a@example.com', 'r9-a-t2', { refresh_token: 'r9-a-rt' });
        await readOne(wrappedAg, true);
        releaseLate1();
        await reqA1;
        const callsAfterLateA = agQuotaCalls;
        fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'r9-a-t3', refresh_token: 'r9-a-rt', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
        await readOne(wrappedAg, true);
        assert.strictEqual(agQuotaCalls, callsAfterLateA, 'late 429 persisted onto active credential\'s refresh_token alias');

        // 2b: Email + refresh_token Request 1 superseded by refresh_token-only Request 2 (different primary account key!) ->
        // Request 1 returns late 429 -> arms gate and clears fetched so polling wakes at 120s, not 5m!
        writeAg('acct-r9-b@example.com', 'r9-b-t1', { refresh_token: 'r9-b-rt' });
        const reqB1 = readOne(wrappedAg, true);
        for (let i = 0; i < 50 && !releaseLate2; i++) await new Promise((r) => setTimeout(r, 5));
        fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'r9-b-t2', refresh_token: 'r9-b-rt', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
        await readOne(wrappedAg, true);
        assert.ok(fetched.get('antigravity') > 0 && !gate.has('antigravity'));
        releaseLate2();
        await reqB1;
        assert.ok(gate.get('antigravity') > Date.now() + 100_000, 'late 429 sharing refresh_token alias arms active gate despite different primary account key');
        assert.strictEqual(fetched.get('antigravity'), undefined, 'and clears fetched so polling resumes when Retry-After lifts');
      } finally {
        global.fetch = savedFetchR9;
      }
    }

    // Round 10 Fix 1: On a fresh start (empty last/cache), holding A's first quota request while switching to B must
    // NOT let A's late 429 leak onto B's aliases or block B's refreshes.
    {
      const savedFetchF1 = global.fetch;
      let releaseA429;
      let freshCalls = 0;
      global.fetch = async (url, opts) => {
        if (url.endsWith(':loadCodeAssist')) return agAssist();
        freshCalls++;
        if (opts?.headers?.Authorization === 'Bearer f1-tok-a') {
          await new Promise((r) => (releaseA429 = r));
          return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
        }
        return { ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-11-20T02:01:25Z' }] }] }) };
      };
      try {
        const freshInst = loadInstance();
        writeAg('f1-a@example.com', 'f1-tok-a');
        const reqA = freshInst.readOne(wrappedAg, true);
        for (let i = 0; i < 50 && !releaseA429; i++) await new Promise((r) => setTimeout(r, 5));
        writeAg('f1-b@example.com', 'f1-tok-b');
        await freshInst.readOne(wrappedAg, true);
        assert.strictEqual(freshInst.last.get('antigravity').rows[0].percent, 30);
        releaseA429();
        await reqA;
        const callsBeforeB = freshCalls;
        await freshInst.readOne(wrappedAg, true);
        assert.strictEqual(freshCalls, callsBeforeB + 1, 'Account A\'s late 429 on a fresh start never blocks unrelated Account B');
        freshInst.on['will-quit']();
      } finally {
        global.fetch = savedFetchF1;
      }
    }

    // Round 10 Fix 2: Late 429 from email-only Request 1 still matches after two updates (email+rt -> rt-only+new bearer).
    {
      const savedFetchF2 = global.fetch;
      let releaseEmailOnly;
      global.fetch = async (url, opts) => {
        if (url.endsWith(':loadCodeAssist')) return agAssist();
        agQuotaCalls++;
        if (opts?.headers?.Authorization === 'Bearer f2-t1') {
          await new Promise((r) => (releaseEmailOnly = r));
          return { ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) };
        }
        return { ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-20T02:01:25Z' }] }] }) };
      };
      try {
        writeAg('f2-chain@example.com', 'f2-t1');
        const req1 = readOne(wrappedAg, true);
        for (let i = 0; i < 50 && !releaseEmailOnly; i++) await new Promise((r) => setTimeout(r, 5));
        writeAg('f2-chain@example.com', 'f2-t2', { refresh_token: 'f2-rt' });
        await readOne(wrappedAg, true);
        fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'f2-t3', refresh_token: 'f2-rt', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
        await readOne(wrappedAg, true);
        releaseEmailOnly();
        await req1;
        const callsAfterChain = agQuotaCalls;
        fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'f2-t4', refresh_token: 'f2-rt', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
        await readOne(wrappedAg, true);
        assert.strictEqual(agQuotaCalls, callsAfterChain, 'alias continuity preserves email key across email+rt -> rt-only transitions');
      } finally {
        global.fetch = savedFetchF2;
      }
    }

    // Round 10 Fix 3: Disabling Antigravity while a manual refresh lookup is pending stops the retry loop cleanly.
    {
      writeAg('f3-dis@example.com', 'f3-tok');
      let releaseQuota;
      agQuota = () => new Promise((r) => (releaseQuota = () => r({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-20T02:01:25Z' }] }] }) })));
      const inflightDis = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseQuota; i++) await new Promise((r) => setTimeout(r, 5));
      let releaseManualLookup;
      peekHook = (orig) => {
        peekHook = null;
        return new Promise((r) => (releaseManualLookup = () => r(orig())));
      };
      const pendingManual = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseManualLookup; i++) await new Promise((r) => setTimeout(r, 5));
      await ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: false } }));
      const peeksAfterDisable = peekCalls;
      const callsAfterDisable = agQuotaCalls;
      releaseManualLookup();
      releaseQuota();
      await Promise.all([pendingManual, inflightDis]);
      assert.strictEqual(peekCalls, peeksAfterDisable, 'disabled provider does not re-read credentials in manual retry loop');
      assert.strictEqual(agQuotaCalls, callsAfterDisable, 'disabled provider does not send a new quota request');
      // Re-enable Antigravity for subsequent tests.
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: true } }));
      await new Promise((r) => setTimeout(r, 20));
    }

    // Round 10 Fix 4: Manual refresh overlapping a background tier-only fold MUST still execute its quota fetch.
    {
      writeAg('f4-tier@example.com', 'f4-tok');
      let releaseTier;
      agAssist = () => new Promise((r) => (releaseTier = () => r({ ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } }) })));
      let quotaPct = 0.55; // 45% used initially
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: quotaPct, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await readOne(wrappedAg, true);
      assert.strictEqual(last.get('antigravity').rows[0].percent, 45);
      assert.strictEqual(last.get('antigravity').plan, '');
      releaseTier();
      await new Promise((r) => setImmediate(r));
      // Now start background tick (tier-only fold) and overlap it with a manual refresh expecting fresh 60% quota!
      quotaPct = 0.4; // 60% used
      let releaseBgPeek;
      let releaseManualPeek;
      let step = 0;
      peekHook = (orig) => {
        step++;
        if (step === 1) return new Promise((r) => (releaseBgPeek = () => r(orig())));
        if (step === 2) return new Promise((r) => (releaseManualPeek = () => r(orig())));
        return orig();
      };
      const callsBeforeOverlap = agQuotaCalls;
      const bgTierFold = readOne(wrappedAg, false);
      for (let i = 0; i < 50 && !releaseBgPeek; i++) await new Promise((r) => setTimeout(r, 5));
      const manualRefresh = readOne(wrappedAg, true);
      for (let i = 0; i < 50 && !releaseManualPeek; i++) await new Promise((r) => setTimeout(r, 5));
      releaseBgPeek();
      await bgTierFold;
      assert.strictEqual(last.get('antigravity').plan, 'AI Ultra', 'background check folded tier without fetching quota');
      assert.strictEqual(agQuotaCalls, callsBeforeOverlap);
      releaseManualPeek();
      await manualRefresh;
      peekHook = null;
      assert.strictEqual(agQuotaCalls, callsBeforeOverlap + 1, 'manual refresh overlapping tier-only fold still fetches fresh quota');
      assert.strictEqual(last.get('antigravity').rows[0].percent, 60);
      agAssist = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
    }

    // Round 11: each check runs on a fresh main.js with credentials nothing else uses, so neither a shared `__weak__`
    // deadline nor another check's account can make it pass or fail by accident.
    {
      const savedFetchR11 = global.fetch;
      const sentBearers = []; // the bearer of every quota request, in order
      const holds = new Map(); // 'Bearer x' -> { answer, release }: that bearer's next quota request waits for release()
      const quotaOk = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      const quota429 = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
      global.fetch = async (url, opts) => {
        if (url.endsWith(':loadCodeAssist')) return agAssist();
        const auth = opts?.headers?.Authorization;
        sentBearers.push(auth);
        const h = holds.get(auth);
        if (!h) return quotaOk();
        holds.delete(auth);
        await new Promise((r) => (h.release = r));
        return h.answer();
      };
      const holdOnce = (bearer, answer) => {
        const h = { answer, release: null };
        holds.set(`Bearer ${bearer}`, h);
        return h;
      };
      const until = async (ready) => {
        for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
        assert.ok(ready(), 'the step it waits for happened');
      };
      const writeBare = (token) => fs.writeFileSync(agMainAuth, JSON.stringify({ token: { expiry: new Date(Date.now() + 3600_000).toISOString(), ...token } }));
      try {
        // Fix 1: an old bearer's success after rotation marks the OLD bearer as having fetched, so a manual refresh
        // that overlapped it still asks with the replacement bearer.
        {
          const inst = loadInstance();
          writeAg('r11-one@example.com', 'r11-one-t1');
          const old = holdOnce('r11-one-t1', quotaOk);
          const bg = inst.readOne(wrappedAg, true);
          await until(() => old.release);
          writeAg('r11-one@example.com', 'r11-one-t2');
          let releasePeek = null;
          peekHook = (orig) => {
            peekHook = null;
            return new Promise((r) => (releasePeek = () => r(orig())));
          };
          const manual = inst.readOne(wrappedAg, true);
          await until(() => releasePeek);
          old.release();
          await bg;
          releasePeek();
          await manual;
          assert.strictEqual(sentBearers.at(-1), 'Bearer r11-one-t2', 'the overlapping manual refresh fetched with the replacement bearer');
          inst.on['will-quit']();
        }

        // Fix 2 (join): a refresh token first seen by a manual refresh that joins the in-flight request is covered by
        // that request's 429, after the email goes and the bearer rotates.
        {
          const inst = loadInstance();
          writeAg('r11-join@example.com', 'r11-join-t1');
          const h = holdOnce('r11-join-t1', quota429);
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r11-join@example.com', 'r11-join-t1', { refresh_token: 'r11-join-rt' });
          const peeks = peekCalls;
          const sentBeforeJoin = sentBearers.length;
          const joined = inst.readOne(wrappedAg, true);
          await until(() => peekCalls > peeks);
          await new Promise((r) => setTimeout(r, 10));
          assert.strictEqual(sentBearers.length, sentBeforeJoin, 'same email and bearer joins the request in flight');
          writeBare({ access_token: 'r11-join-t2', refresh_token: 'r11-join-rt' });
          h.release();
          await Promise.all([first, joined]);
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the joined refresh token stays under the 429');
          assert.ok(inst.gate.get('antigravity') > Date.now() + 100_000, 'and the wait shows');
          inst.on['will-quit']();
        }

        // Fix 2 (post-fetch): a 429 whose post-fetch check finds an email added to the same bearer covers that email
        // once the refresh token goes and the bearer rotates.
        {
          const inst = loadInstance();
          writeBare({ access_token: 'r11-mail-t1', refresh_token: 'r11-mail-rt' });
          const h = holdOnce('r11-mail-t1', quota429);
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r11-mail@example.com', 'r11-mail-t1', { refresh_token: 'r11-mail-rt' });
          h.release();
          await first;
          writeAg('r11-mail@example.com', 'r11-mail-t2');
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the email seen beside the 429\'s bearer stays under it');
          inst.on['will-quit']();
        }

        // Fix 3: two bare bearers share only `__weak__`, which proves no account. Once B's email is verified, A's late
        // 429 must not hold B back.
        {
          const inst = loadInstance();
          writeBare({ access_token: 'r11-weak-a1' });
          const h = holdOnce('r11-weak-a1', quota429);
          const reqA = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeBare({ access_token: 'r11-weak-b1' });
          await inst.readOne(wrappedAg, true);
          writeAg('r11-weak-b@example.com', 'r11-weak-b1');
          await inst.readOne(wrappedAg, true);
          h.release();
          await reqA;
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 1, 'A\'s late 429 does not hold back B once B\'s email is verified');
          assert.strictEqual(sentBearers.at(-1), 'Bearer r11-weak-b1');
          assert.ok(!(inst.gate.get('antigravity') > Date.now()), 'and B shows no wait');
          inst.on['will-quit']();
        }

        // Links outlive a switch: A's email-only 429 lands after A gained a refresh token and the PC moved to B. It
        // holds A back when A returns with only that refresh token and a new bearer, and never holds B.
        {
          const inst = loadInstance();
          writeAg('r11-chain-a@example.com', 'r11-chain-a1');
          const h = holdOnce('r11-chain-a1', quota429);
          const reqA = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r11-chain-a@example.com', 'r11-chain-a2', { refresh_token: 'r11-chain-rt' });
          await inst.readOne(wrappedAg, true);
          writeAg('r11-chain-b@example.com', 'r11-chain-b1');
          await inst.readOne(wrappedAg, true);
          h.release();
          await reqA;
          let sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 1, 'A\'s late 429 does not hold B back');
          writeBare({ access_token: 'r11-chain-a3', refresh_token: 'r11-chain-rt' });
          sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'A\'s 429 still holds A back after a switch away and back');
          inst.on['will-quit']();
        }

        // A wait shown for A, armed by a superseded request's late 429, lifts once the read still in flight finds the
        // PC on B, which nothing holds back.
        {
          const inst = loadInstance();
          writeAg('r11-lift-a@example.com', 'r11-lift-a1');
          const h1 = holdOnce('r11-lift-a1', quota429);
          const req1 = inst.readOne(wrappedAg, true);
          await until(() => h1.release);
          writeAg('r11-lift-a@example.com', 'r11-lift-a2');
          const h2 = holdOnce('r11-lift-a2', quotaOk);
          const req2 = inst.readOne(wrappedAg, true);
          await until(() => h2.release);
          h1.release();
          await req1;
          assert.ok(inst.gate.get('antigravity') > Date.now() + 100_000, 'the late 429 holds A back');
          writeAg('r11-lift-b@example.com', 'r11-lift-b1');
          h2.release();
          await req2;
          assert.ok(!(inst.gate.get('antigravity') > Date.now()), 'B shows no wait of A\'s');
          inst.on['will-quit']();
        }

        // `__weak__` links no two named accounts. A showing a bare bearer it is known by stays held, and so does a bare
        // bearer nothing names (it may be A's next), but C showing a bare bearer it is known by is still C.
        {
          const inst = loadInstance();
          writeAg('r11-bare-a@example.com', 'r11-bare-a1');
          const h = holdOnce('r11-bare-a1', quota429);
          const reqA = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          h.release();
          await reqA;
          const sent = sentBearers.length;
          writeBare({ access_token: 'r11-bare-a1' });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'A showing its bare bearer stays held');
          writeBare({ access_token: 'r11-bare-a2' });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'and so does a bare bearer nothing names');
          writeAg('r11-bare-c@example.com', 'r11-bare-c1');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 1, 'C reads');
          writeBare({ access_token: 'r11-bare-c1' });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 2, 'C showing its bare bearer is not held by A');
          writeAg('r11-bare-c@example.com', 'r11-bare-c1');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 3, 'nor once its email is back');
          inst.on['will-quit']();
        }

        // A 429 shows the longest wait its account is under: a superseded request's 600 s outlasts the newer one's 120 s.
        {
          const inst = loadInstance();
          writeAg('r11-long@example.com', 'r11-long-t1');
          const h1 = holdOnce('r11-long-t1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
          const req1 = inst.readOne(wrappedAg, true);
          await until(() => h1.release);
          writeAg('r11-long@example.com', 'r11-long-t2');
          const h2 = holdOnce('r11-long-t2', quota429);
          const req2 = inst.readOne(wrappedAg, true);
          await until(() => h2.release);
          h1.release();
          await req1;
          h2.release();
          await req2;
          assert.ok(inst.gate.get('antigravity') > Date.now() + 500_000, 'the newer 120 s answer does not hide the 600 s wait');
          inst.on['will-quit']();
        }

        // A request still in flight when Antigravity is switched off records its 429 but shows no wait.
        {
          const inst = loadInstance();
          writeAg('r11-off@example.com', 'r11-off-t1');
          const h = holdOnce('r11-off-t1', quota429);
          const req = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          await inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: false } }));
          h.release();
          await req;
          assert.ok(!(inst.gate.get('antigravity') > Date.now()), 'a switched-off provider arms no wait');
          await inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: true } }));
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'but the 429 still holds the account back once it is on again');
          inst.flushState();
          inst.on['will-quit']();
        }
      } finally {
        peekHook = null;
        global.fetch = savedFetchR11;
      }
    }

    // Round 12: fresh main.js instances with credentials nothing else uses, on a state.json holding no deadlines but
    // these checks' own. A restart saves, quits, forgets what a real restart forgets (links, tier deadlines), and loads.
    {
      const savedFetchR12 = global.fetch;
      const statePathR12 = path.join(dir, 'state.json');
      flushState();
      const stateBefore = fs.readFileSync(statePathR12, 'utf8');
      const { accountGates: _g, tierGates: _t, ...clean } = JSON.parse(stateBefore);
      fs.writeFileSync(statePathR12, JSON.stringify(clean));
      providersMod.clearAntigravityTierGates();
      const sentBearers = []; // every quota request's bearer
      const tierBearers = []; // every loadCodeAssist request's bearer
      const quotaAt = (frac) => () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: frac, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      const quota429 = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
      let quotaAnswer = quotaAt(0.5);
      let tierAnswer = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
      global.fetch = async (url, opts) => {
        const auth = opts?.headers?.Authorization;
        if (url.endsWith(':loadCodeAssist')) return (tierBearers.push(auth), tierAnswer(auth));
        sentBearers.push(auth);
        return quotaAnswer(auth);
      };
      const writeBare = (token) => fs.writeFileSync(agMainAuth, JSON.stringify({ token: { expiry: new Date(Date.now() + 3600_000).toISOString(), ...token } }));
      const restart = (inst) => {
        inst.flushState();
        inst.on['will-quit']();
        providersMod.clearAntigravityAliases();
        providersMod.clearAntigravityTierGates();
        wrappedAg.onSignedOut(); // nor any loadCodeAssist answer
        const next = loadInstance();
        next.loadState();
        return next;
      };
      try {
        // Fix 1 (quota): A's 429, left on `__weak__` by A's bare bearer, holds a bare bearer nothing names, but not once
        // that bearer is named as B, before a restart or after one. A stays held throughout.
        {
          let inst = loadInstance();
          quotaAnswer = (auth) => (auth === 'Bearer r12-q-a1' ? quota429() : quotaAt(0.5)());
          writeAg('r12-q-a@example.com', 'r12-q-a1');
          await inst.readOne(wrappedAg, true);
          assert.ok(inst.gate.get('antigravity') > Date.now() + 100_000, 'A is held');
          const sent = sentBearers.length;
          writeBare({ access_token: 'r12-q-a1' });
          await inst.readOne(wrappedAg, true);
          writeBare({ access_token: 'r12-q-b1' });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'A\'s bare bearer, then a bare bearer nothing names, wait under A\'s 429');
          writeAg('r12-q-b@example.com', 'r12-q-b1');
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual(sentBearers.slice(sent), ['Bearer r12-q-b1'], 'named as B, the bearer is not held by A\'s wait');
          assert.ok(!(inst.gate.get('antigravity') > Date.now()), 'and B shows no wait');
          inst = restart(inst);
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual(sentBearers.slice(sent), ['Bearer r12-q-b1', 'Bearer r12-q-b1'], 'nor after a restart, which knows whose the wait is');
          assert.ok(!(inst.gate.get('antigravity') > Date.now()), 'and B still shows no wait');
          writeAg('r12-q-a@example.com', 'r12-q-a2');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 2, 'A is still held after the restart');
          inst.on['will-quit']();
        }

        // Round 4 Fix 2 still holds across a restart: a bare bearer nothing names draws a 429; its bare rotation, then
        // that rotation with an email, wait it out.
        {
          let inst = loadInstance();
          quotaAnswer = quota429;
          writeBare({ access_token: 'r12-w1' });
          await inst.readOne(wrappedAg, true);
          quotaAnswer = quotaAt(0.5);
          const sent = sentBearers.length;
          writeBare({ access_token: 'r12-w2' });
          await inst.readOne(wrappedAg, true);
          inst = restart(inst);
          writeAg('r12-w@example.com', 'r12-w2');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'an unnamed bearer\'s 429 holds its rotation once named, after a restart too');
          inst.on['will-quit']();
          // The `__weak__` wait outlives these checks, so the state.json they found comes back below.
        }

        // Fix 2: dropping the email while the bearer rotates, with the refresh token kept, is the same account: the
        // reading stays on both screens and in the saved cache under the account's new name, and a later drop is a reset.
        {
          let inst = loadInstance();
          quotaAnswer = quotaAt(0.6);
          writeAg('r12-drop@example.com', 'r12-drop-t1', { refresh_token: 'r12-drop-rt' });
          await inst.readOne(wrappedAg, true);
          const first = inst.last.get('antigravity');
          assert.strictEqual(first.rows[0].percent, 40);
          quotaAnswer = quota429;
          await inst.readOne(wrappedAg, true);
          assert.ok(inst.gate.get('antigravity') > Date.now() + 100_000, 'the account is held');
          writeBare({ access_token: 'r12-drop-t2', refresh_token: 'r12-drop-rt' });
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the cooldown holds');
          const kept = inst.last.get('antigravity');
          assert.strictEqual(kept?.rows?.[0]?.percent, 40, 'the same account\'s reading stays');
          assert.strictEqual(inst.snapshot().find((p) => p.id === 'antigravity').rows[0]?.percent, 40, 'on screen');
          assert.strictEqual(inst.savedCache().antigravity?.rows?.[0]?.percent, 40, 'and in the saved cache');
          assert.ok(kept.renewsFor && kept.renewsFor !== first.renewsFor, 'under the account\'s new name');
          inst.flushState();
          assert.deepStrictEqual([saved().signedIn.antigravity, saved().cache.antigravity.renewsFor], [kept.renewsFor, kept.renewsFor], 'which is the one signed in, as saved');
          // After a restart the saved reading still has the keys it was read under: the email back on a new bearer is
          // still this account, held, with its reading on screen.
          inst = restart(inst);
          writeAg('r12-drop@example.com', 'r12-drop-t3');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the cooldown holds after a restart');
          assert.strictEqual(inst.snapshot().find((p) => p.id === 'antigravity').rows[0]?.percent, 40, 'and the reading stays on screen');
          const realNow = Date.now;
          Date.now = () => realNow() + 121_000; // past the cooldown
          try {
            quotaAnswer = quotaAt(0.9);
            const beepsBefore = beeps.length;
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(inst.last.get('antigravity').rows[0].percent, 10);
            assert.strictEqual(beeps.length, beepsBefore + 1, 'a drop on the same account still reads as a reset');
          } finally {
            Date.now = realNow;
          }
          inst.on['will-quit']();
        }

        // Fix 3: loadCodeAssist's Retry-After survives a restart, with quota still read and the bearer rotated. A refresh
        // token the account showed only to a credential check before the restart is held too.
        {
          let inst = loadInstance();
          quotaAnswer = quotaAt(0.5);
          tierAnswer = (auth) => (auth === 'Bearer r12-tier-t1' ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) } : { ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
          writeAg('r12-tier@example.com', 'r12-tier-t1');
          await inst.readOne(wrappedAg, true);
          await new Promise((r) => setImmediate(r));
          const mine = () => tierBearers.filter((b) => b.includes('r12-tier'));
          assert.deepStrictEqual(mine(), ['Bearer r12-tier-t1']);
          writeAg('r12-tier@example.com', 'r12-tier-t1', { refresh_token: 'r12-tier-rt' });
          await wrappedAg.peekCred();
          inst = restart(inst);
          writeAg('r12-tier@example.com', 'r12-tier-t2');
          await inst.readOne(wrappedAg, true);
          await new Promise((r) => setImmediate(r));
          assert.strictEqual(sentBearers.at(-1), 'Bearer r12-tier-t2', 'quota is read after the restart');
          assert.deepStrictEqual(mine(), ['Bearer r12-tier-t1'], 'a fresh process keeps loadCodeAssist\'s Retry-After');
          writeBare({ access_token: 'r12-tier-t3', refresh_token: 'r12-tier-rt' });
          await inst.readOne(wrappedAg, true);
          await new Promise((r) => setImmediate(r));
          assert.strictEqual(sentBearers.at(-1), 'Bearer r12-tier-t3');
          assert.deepStrictEqual(mine(), ['Bearer r12-tier-t1'], 'including under the refresh token the check saw');
          inst.on['will-quit']();
        }
      } finally {
        global.fetch = savedFetchR12;
        fs.writeFileSync(statePathR12, stateBefore);
      }
    }

    // Round 13: fresh main.js instances with credentials nothing else uses, on a state.json holding no deadlines but
    // these checks' own. loadCodeAssist's deadlines on hand come back afterwards, so the `__weak__` one left here doesn't.
    {
      const savedFetchR13 = global.fetch;
      const statePathR13 = path.join(dir, 'state.json');
      flushState();
      const stateBefore = fs.readFileSync(statePathR13, 'utf8');
      const { accountGates: _g, tierGates: _t, ...clean } = JSON.parse(stateBefore);
      fs.writeFileSync(statePathR13, JSON.stringify(clean));
      const tierBefore = wrappedAg.tierGates();
      providersMod.clearAntigravityTierGates();
      const sentBearers = []; // every quota request's bearer
      const tierBearers = []; // every loadCodeAssist request's bearer
      const holds = new Map(); // 'Bearer x' -> { answer, release }: that bearer's next quota request waits for release()
      const quotaAt = (frac) => () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: frac, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      const quota429 = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
      const proTier = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
      let quotaAnswer = quotaAt(0.5);
      let tierAnswer = proTier;
      global.fetch = async (url, opts) => {
        const auth = opts?.headers?.Authorization;
        if (url.endsWith(':loadCodeAssist')) return (tierBearers.push(auth), tierAnswer(auth));
        sentBearers.push(auth);
        const h = holds.get(auth);
        if (!h) return quotaAnswer(auth);
        holds.delete(auth);
        await new Promise((r) => (h.release = r));
        return h.answer();
      };
      const holdOnce = (bearer, answer) => {
        const h = { answer, release: null };
        holds.set(`Bearer ${bearer}`, h);
        return h;
      };
      const until = async (ready) => {
        for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
        assert.ok(ready(), 'the step it waits for happened');
      };
      const settle = () => new Promise((r) => setTimeout(r, 10));
      // The next credential check reads the file now and lands when released.
      const holdNextPeek = () => {
        const h = { release: null };
        peekHook = (orig) => {
          peekHook = null;
          const snap = orig();
          return new Promise((r) => (h.release = () => r(snap)));
        };
        return h;
      };
      const writeBare = (token) => fs.writeFileSync(agMainAuth, JSON.stringify({ token: { expiry: new Date(Date.now() + 3600_000).toISOString(), ...token } }));
      const keyOf = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
      const shown = (inst) => inst.snapshot().find((p) => p.id === 'antigravity');
      const pushed = (inst) => inst.sent.filter(([ch]) => ch === 'data').at(-1)?.[1].find((p) => p.id === 'antigravity');
      const phoneShows = (inst) => {
        let first = '';
        let close = null;
        inst.handler({ method: 'GET', url: '/api/events', headers: { host: 'localhost' }, on: (_, fn) => (close = fn) }, { writeHead() { return this; }, write(c) { if (!first) first = c; }, end() {} });
        close?.();
        return JSON.parse(first.slice(6)).providers.find((p) => p.id === 'antigravity');
      };
      const restart = (inst) => {
        inst.flushState();
        inst.on['will-quit']();
        providersMod.clearAntigravityAliases();
        providersMod.clearAntigravityTierGates();
        wrappedAg.onSignedOut(); // nor any loadCodeAssist answer
        const next = loadInstance();
        next.loadState();
        return next;
      };
      try {
        // Fix 1: with A's request in flight, a refresh whose credential check saw B is held there; back on A, a newer
        // refresh confirms A and joins A's request. The older check, landing last, asks nothing for B, leaves A's saved
        // reading, and A's request still lands.
        {
          const inst = loadInstance();
          quotaAnswer = quotaAt(0.7);
          writeAg('r13-join-a@example.com', 'r13-join-a1');
          await inst.readOne(wrappedAg, true);
          const h = holdOnce('r13-join-a1', quotaAt(0.6));
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r13-join-b@example.com', 'r13-join-b1');
          const sawB = holdNextPeek();
          const stale = inst.readOne(wrappedAg, true);
          await until(() => sawB.release);
          writeAg('r13-join-a@example.com', 'r13-join-a1');
          const sent = sentBearers.length;
          const joined = inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(sentBearers.length, sent, 'the newer check joins A\'s request in flight');
          sawB.release();
          await settle();
          assert.strictEqual(sentBearers.length, sent, 'the older check that saw B asks nothing for B');
          assert.strictEqual(inst.savedCache().antigravity?.rows?.[0]?.percent, 30, 'and leaves A\'s saved reading');
          h.release();
          await Promise.all([first, stale, joined]);
          assert.strictEqual(inst.last.get('antigravity').rows[0].percent, 40, 'A\'s request in flight still lands');
          assert.strictEqual(inst.savedCache().antigravity.rows[0].percent, 40);
          inst.on['will-quit']();
        }

        // Fix 1, after the fetch: A's own check after its answer is held having seen B; back on A, a refresh joins A's
        // request. The held check, landing last, looks again rather than drop A's answer and A's saved reading.
        {
          const inst = loadInstance();
          quotaAnswer = quotaAt(0.7);
          writeAg('r13-post-a@example.com', 'r13-post-a1');
          await inst.readOne(wrappedAg, true);
          const h = holdOnce('r13-post-a1', quotaAt(0.6));
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r13-post-b@example.com', 'r13-post-b1');
          const sawB = holdNextPeek();
          h.release();
          await until(() => sawB.release);
          writeAg('r13-post-a@example.com', 'r13-post-a1');
          const sent = sentBearers.length;
          const joined = inst.readOne(wrappedAg, true);
          await settle();
          sawB.release();
          await Promise.all([first, joined]);
          assert.strictEqual(sentBearers.length, sent, 'nothing is asked for B');
          assert.strictEqual(inst.last.get('antigravity')?.rows?.[0]?.percent, 40, 'A\'s answer lands');
          assert.strictEqual(inst.savedCache().antigravity?.rows?.[0]?.percent, 40, 'and is saved');
          inst.on['will-quit']();
        }

        // Fix 2: a refresh token a credential check learns, with the email unchanged, joins the saved reading's keys.
        // After a restart, the email gone and the bearer rotated, the account's reading stays, held by its wait.
        {
          let inst = loadInstance();
          quotaAnswer = quotaAt(0.7);
          writeAg('r13-learn@example.com', 'r13-learn-t1');
          await inst.readOne(wrappedAg, true);
          quotaAnswer = quota429;
          await inst.readOne(wrappedAg, true);
          writeAg('r13-learn@example.com', 'r13-learn-t1', { refresh_token: 'r13-learn-rt' });
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'only a credential check: the wait holds the read');
          inst.flushState();
          assert.ok(saved().cache.antigravity.gateKeys.includes(keyOf('r13-learn-rt')), 'the refresh token is saved with the reading');
          inst = restart(inst);
          writeBare({ access_token: 'r13-learn-t2', refresh_token: 'r13-learn-rt' });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the wait holds after the restart');
          assert.strictEqual(shown(inst).rows[0]?.percent, 30, 'and the account\'s reading stays on screen');
          assert.strictEqual(inst.savedCache().antigravity?.rows?.[0]?.percent, 30, 'and saved');
          inst.on['will-quit']();
        }

        // Fix 2: a reading whose credential no longer carries the refresh token keeps the one it was proven by before.
        {
          let inst = loadInstance();
          quotaAnswer = quotaAt(0.8);
          writeAg('r13-over@example.com', 'r13-over-t1', { refresh_token: 'r13-over-rt' });
          await inst.readOne(wrappedAg, true);
          writeAg('r13-over@example.com', 'r13-over-t2');
          quotaAnswer = quotaAt(0.75);
          await inst.readOne(wrappedAg, true);
          inst.flushState();
          assert.ok(saved().cache.antigravity.gateKeys.includes(keyOf('r13-over-rt')), 'the refresh token stays with the newer reading');
          inst = restart(inst);
          writeBare({ access_token: 'r13-over-t3', refresh_token: 'r13-over-rt' });
          quotaAnswer = () => ({ ok: false, status: 503, headers: new Headers() });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(shown(inst).rows[0]?.percent, 25, 'after a restart the same account\'s reading stays through a failed read');
          inst.on['will-quit']();
        }

        // Fix 3 (loadCodeAssist): A's wait, left on `__weak__` by A's bare bearer, doesn't hold B's exact bearer after a
        // restart: B's saved reading says whose it is. Before Fix 3 (quota), so no quota wait sits on `__weak__` yet.
        {
          let inst = loadInstance();
          quotaAnswer = quotaAt(0.5);
          tierAnswer = (auth) => (auth === 'Bearer r13-ta-1' ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) } : proTier());
          writeAg('r13-ta@example.com', 'r13-ta-1');
          await inst.readOne(wrappedAg, true);
          await settle();
          writeBare({ access_token: 'r13-ta-1' });
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(tierBearers.filter((b) => b.includes('r13-ta')), ['Bearer r13-ta-1'], 'A\'s bare bearer waits out A\'s loadCodeAssist 429');
          writeAg('r13-tb@example.com', 'r13-tb-1');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(tierBearers.filter((b) => b.includes('r13-tb')), ['Bearer r13-tb-1']);
          inst = restart(inst);
          writeBare({ access_token: 'r13-tb-1' });
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(sentBearers.at(-1), 'Bearer r13-tb-1', 'quota is read after the restart');
          assert.deepStrictEqual(tierBearers.filter((b) => b.includes('r13-tb')), ['Bearer r13-tb-1', 'Bearer r13-tb-1'], 'and loadCodeAssist, which A\'s wait doesn\'t hold');
          tierAnswer = proTier;
          inst.on['will-quit']();
        }

        // Fix 3 (quota): the same with A's quota 429.
        {
          let inst = loadInstance();
          quotaAnswer = (auth) => (auth === 'Bearer r13-qa-1' ? quota429() : quotaAt(0.6)());
          writeAg('r13-qa@example.com', 'r13-qa-1');
          await inst.readOne(wrappedAg, true);
          assert.ok(inst.gate.get('antigravity') > Date.now() + 100_000, 'A is held');
          const sent = sentBearers.length;
          writeBare({ access_token: 'r13-qa-1' });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'A\'s bare bearer waits it out');
          writeAg('r13-qb@example.com', 'r13-qb-1');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(shown(inst).rows[0].percent, 40);
          inst = restart(inst);
          writeBare({ access_token: 'r13-qb-1' });
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual(sentBearers.slice(sent), ['Bearer r13-qb-1', 'Bearer r13-qb-1'], 'B\'s exact bearer is not held by A\'s wait after a restart');
          assert.ok(!(inst.gate.get('antigravity') > Date.now()), 'and B shows no wait');
          writeAg('r13-qa@example.com', 'r13-qa-2');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 2, 'A is still held');
          inst.on['will-quit']();
        }

        // Fix 4: a token that expires during a cooldown shows the sign-in note; a valid replacement for the same account
        // brings back its last numbers, on the desktop and the phone, with the wait and no request.
        {
          const inst = loadInstance();
          quotaAnswer = quotaAt(0.7);
          writeAg('r13-exp@example.com', 'r13-exp-t1');
          await inst.readOne(wrappedAg, true);
          quotaAnswer = quota429;
          await inst.readOne(wrappedAg, true);
          writeAg('r13-exp@example.com', 'r13-exp-t1', { expiry: '2020-01-01T00:00:00Z' });
          await inst.readOne(wrappedAg, true);
          assert.match(shown(inst).error, /Session expired/);
          writeAg('r13-exp@example.com', 'r13-exp-t2');
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the wait still holds the read');
          for (const [where, s] of [['snapshot', shown(inst)], ['desktop', pushed(inst)], ['phone', phoneShows(inst)]]) {
            assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0, s.expired], [undefined, 30, true, undefined], `${where}: the numbers and the wait, no sign-in note`);
          }
          inst.on['will-quit']();
        }

        // Fix 4 with nothing saved: the section waits instead of asking for a sign-in.
        {
          const inst = loadInstance();
          quotaAnswer = quota429;
          writeAg('r13-exp0@example.com', 'r13-exp0-t1');
          await inst.readOne(wrappedAg, true);
          writeAg('r13-exp0@example.com', 'r13-exp0-t1', { expiry: '2020-01-01T00:00:00Z' });
          await inst.readOne(wrappedAg, true);
          assert.match(shown(inst).error, /Session expired/);
          writeAg('r13-exp0@example.com', 'r13-exp0-t2');
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the wait still holds the read');
          for (const [where, s] of [['snapshot', shown(inst)], ['desktop', pushed(inst)], ['phone', phoneShows(inst)]]) {
            assert.deepStrictEqual([s.error, s.rows.length, s.waitMs > 0], [undefined, 0, true], `${where}: waiting, no sign-in note`);
          }
          inst.on['will-quit']();
        }

        // Fix 4 under the account's other name: the replacement drops the email and keeps the refresh token.
        {
          const inst = loadInstance();
          quotaAnswer = quotaAt(0.7);
          writeAg('r13-ren@example.com', 'r13-ren-t1', { refresh_token: 'r13-ren-rt' });
          await inst.readOne(wrappedAg, true);
          quotaAnswer = quota429;
          await inst.readOne(wrappedAg, true);
          writeAg('r13-ren@example.com', 'r13-ren-t1', { expiry: '2020-01-01T00:00:00Z' });
          await inst.readOne(wrappedAg, true);
          assert.match(shown(inst).error, /Session expired/);
          writeBare({ access_token: 'r13-ren-t2', refresh_token: 'r13-ren-rt' });
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the wait still holds the read');
          const s = shown(inst);
          assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 30, true], 'the numbers and the wait under the account\'s other name');
          inst.on['will-quit']();
        }

        // Fix 4 with no wait, the replacement's read failing softly: the numbers, not the note.
        {
          const inst = loadInstance();
          quotaAnswer = quotaAt(0.7);
          writeAg('r13-soft@example.com', 'r13-soft-t1');
          await inst.readOne(wrappedAg, true);
          writeAg('r13-soft@example.com', 'r13-soft-t1', { expiry: '2020-01-01T00:00:00Z' });
          await inst.readOne(wrappedAg, true);
          assert.match(shown(inst).error, /Session expired/);
          writeAg('r13-soft@example.com', 'r13-soft-t2');
          quotaAnswer = () => ({ ok: false, status: 503, headers: new Headers() });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.at(-1), 'Bearer r13-soft-t2');
          assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent], [undefined, 30], 'a failed read after a valid replacement keeps the numbers');
          inst.on['will-quit']();
        }
      } finally {
        peekHook = null;
        global.fetch = savedFetchR13;
        fs.writeFileSync(statePathR13, stateBefore);
        providersMod.clearAntigravityTierGates();
        wrappedAg.restoreTierGates(tierBefore);
      }
    }

    // Round 14: fresh main.js instances with credentials nothing else uses, on a state.json holding no deadlines but
    // these checks' own. A restart saves, quits, forgets the links and tier deadlines in memory, and loads state.json.
    {
      const savedFetchR14 = global.fetch;
      const statePathR14 = path.join(dir, 'state.json');
      flushState();
      const stateBefore = fs.readFileSync(statePathR14, 'utf8');
      const { accountGates: _g, tierGates: _t, cache: _c, signedIn: _s, ...clean } = JSON.parse(stateBefore);
      fs.writeFileSync(statePathR14, JSON.stringify(clean));
      const tierBefore = wrappedAg.tierGates();
      providersMod.clearAntigravityTierGates();
      const sentBearers = [];
      const tierBearers = [];
      const holds = new Map(); // 'Bearer x' -> { answer, release }: that bearer's next quota request waits for release()
      const quotaAt = (frac) => () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: frac, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      const quota429 = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
      const down = () => ({ ok: false, status: 503, headers: new Headers() });
      const tier429 = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) });
      const proTier = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
      let quotaAnswer = quotaAt(0.5);
      let tierAnswer = proTier;
      global.fetch = async (url, opts) => {
        const auth = opts?.headers?.Authorization;
        if (url.endsWith(':loadCodeAssist')) return (tierBearers.push(auth), tierAnswer(auth));
        sentBearers.push(auth);
        const h = holds.get(auth);
        if (!h) return quotaAnswer(auth);
        holds.delete(auth);
        await new Promise((r) => (h.release = r));
        return h.answer();
      };
      const holdOnce = (bearer, answer) => {
        const h = { answer, release: null };
        holds.set(`Bearer ${bearer}`, h);
        return h;
      };
      const until = async (ready) => {
        for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
        assert.ok(ready(), 'the step it waits for happened');
      };
      const settle = () => new Promise((r) => setTimeout(r, 10));
      const writeBare = (token) => fs.writeFileSync(agMainAuth, JSON.stringify({ token: { expiry: new Date(Date.now() + 3600_000).toISOString(), ...token } }));
      const keyOf = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
      const shown = (inst) => inst.snapshot().find((p) => p.id === 'antigravity');
      const expiredAt = { expiry: '2020-01-01T00:00:00Z' };
      // Each check starts on its own: no deadline another left (a `__weak__` one holds every bare bearer) in memory or on disk.
      const fresh = () => {
        providersMod.clearAntigravityTierGates();
        fs.writeFileSync(statePathR14, JSON.stringify(clean));
        return loadInstance();
      };
      const restart = (inst) => {
        inst.flushState();
        inst.on['will-quit']();
        providersMod.clearAntigravityAliases();
        providersMod.clearAntigravityTierGates();
        wrappedAg.onSignedOut(); // nor any loadCodeAssist answer
        const next = loadInstance();
        next.loadState();
        return next;
      };
      try {
        // Fix 1 (manual refresh): a refresh that finds the request's own bearer expired shows the expiry at once instead
        // of joining that request, and the request's answer, landing later, is neither shown nor saved.
        {
          const inst = fresh();
          quotaAnswer = quotaAt(0.7);
          writeAg('r14-join@example.com', 'r14-join-t1');
          await inst.readOne(wrappedAg, true);
          const h = holdOnce('r14-join-t1', quotaAt(0.2));
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r14-join@example.com', 'r14-join-t1', expiredAt);
          const sent = sentBearers.length;
          const manual = inst.readOne(wrappedAg, true); // unfixed, it joins the held request and waits on it
          await until(() => /Session expired/.test(shown(inst).error || '')); // the refresh's own check, before the answer
          h.release();
          await Promise.all([first, manual]);
          assert.strictEqual(sentBearers.length, sent, 'the expired bearer asks nothing');
          assert.match(shown(inst).error, /Session expired/, 'the held answer does not replace the expiry');
          assert.strictEqual(inst.savedCache().antigravity.rows[0].percent, 30, 'nor is it saved');
          writeAg('r14-join@example.com', 'r14-join-t2');
          quotaAnswer = down;
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent], [undefined, 30], 'a valid replacement brings back the last numbers, not the held answer');
          inst.on['will-quit']();
        }

        // Fix 1 (manual refresh, a 429): the superseded request's 429 lands after the expiry shows. The note stays without a
        // wait, as for any expiry, and the wait is kept for the account's valid replacement.
        {
          const inst = fresh();
          quotaAnswer = quotaAt(0.7);
          writeAg('r14-join429@example.com', 'r14-join429-t1');
          await inst.readOne(wrappedAg, true);
          const h = holdOnce('r14-join429-t1', quota429);
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r14-join429@example.com', 'r14-join429-t1', expiredAt);
          const manual = inst.readOne(wrappedAg, true);
          await until(() => /Session expired/.test(shown(inst).error || '')); // the refresh's own check, before the answer
          h.release();
          await Promise.all([first, manual]);
          assert.match(shown(inst).error || '', /Session expired/);
          assert.strictEqual(shown(inst).waitMs, 0, 'the late 429 puts no wait on the sign-in note');
          writeAg('r14-join429@example.com', 'r14-join429-t2');
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the late 429 holds the replacement');
          assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, shown(inst).waitMs > 0], [undefined, 30, true]);
          inst.on['will-quit']();
        }

        // Fix 1 (after the fetch): the bearer expires while its request is out; the answer is neither shown nor saved.
        {
          const inst = fresh();
          quotaAnswer = quotaAt(0.7);
          writeAg('r14-post@example.com', 'r14-post-t1');
          await inst.readOne(wrappedAg, true);
          const h = holdOnce('r14-post-t1', quotaAt(0.2));
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r14-post@example.com', 'r14-post-t1', expiredAt);
          h.release();
          await first;
          assert.match(shown(inst).error || '', /Session expired/, 'the expiry shows, not the answer');
          assert.strictEqual(inst.savedCache().antigravity.rows[0].percent, 30, 'and the answer is not saved');
          inst.flushState();
          assert.strictEqual(saved().cache.antigravity.rows[0].percent, 30, 'on disk either');
          inst.on['will-quit']();
        }

        // Fix 1 (after the fetch, a 429): the answer's wait is still kept, and holds the account's valid replacement.
        {
          const inst = fresh();
          quotaAnswer = quotaAt(0.7);
          writeAg('r14-post429@example.com', 'r14-post429-t1');
          await inst.readOne(wrappedAg, true);
          const h = holdOnce('r14-post429-t1', quota429);
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r14-post429@example.com', 'r14-post429-t1', expiredAt);
          h.release();
          await first;
          assert.match(shown(inst).error || '', /Session expired/);
          assert.strictEqual(shown(inst).waitMs, 0, 'the expiry shows without a wait, as before a request');
          writeAg('r14-post429@example.com', 'r14-post429-t2');
          const sent = sentBearers.length;
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'the 429 the expired bearer drew holds the replacement');
          assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, shown(inst).waitMs > 0], [undefined, 30, true]);
          inst.on['will-quit']();
        }

        // Fix 1 (after the fetch, another account): the credential moved to another account whose token has expired.
        {
          const inst = fresh();
          quotaAnswer = quotaAt(0.7);
          writeAg('r14-swa@example.com', 'r14-swa-t1');
          await inst.readOne(wrappedAg, true);
          const h = holdOnce('r14-swa-t1', quotaAt(0.2));
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r14-swb@example.com', 'r14-swb-t1', expiredAt);
          h.release();
          await first;
          assert.match(shown(inst).error || '', /Session expired/, 'the other account\'s expiry shows');
          assert.deepStrictEqual([shown(inst).rows.length, inst.savedCache().antigravity], [0, undefined], 'with neither account\'s numbers');
          inst.on['will-quit']();
        }

        // Fix 2 (quota): A's 429 is left on `__weak__` by A's bare bearer. B, verified by email, gets a 503: no reading
        // and no wait of its own. After a restart B's bare bearer is still B's, from the saved links, so A's wait doesn't hold it.
        {
          let inst = fresh();
          quotaAnswer = (auth) => (auth === 'Bearer r14-l-a1' ? quota429() : auth?.includes('r14-l-b') ? down() : quotaAt(0.5)());
          writeAg('r14-l-a@example.com', 'r14-l-a1');
          await inst.readOne(wrappedAg, true);
          writeBare({ access_token: 'r14-l-a1' });
          await inst.readOne(wrappedAg, true);
          const sent = sentBearers.length;
          writeAg('r14-l-b@example.com', 'r14-l-b1');
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual(sentBearers.slice(sent), ['Bearer r14-l-b1']);
          inst.flushState();
          const links = saved().accountLinks?.antigravity;
          assert.ok(links?.some((g) => g.includes(keyOf('r14-l-b@example.com')) && g.includes(`tok:${keyOf('r14-l-b1')}`)), 'B\'s link is saved');
          const linksJson = JSON.stringify(saved().accountLinks);
          assert.ok(!/r14-l-|@example\.com/.test(linksJson), 'as hashes, never a token or an email');
          assert.ok(links.flat().every((k) => /^(?:tok:)?[0-9a-f]{12}$/.test(k)));
          assert.strictEqual(saved().cache?.antigravity, undefined, 'B has no saved reading');
          inst = restart(inst);
          writeBare({ access_token: 'r14-l-b1' });
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual(sentBearers.slice(sent), ['Bearer r14-l-b1', 'Bearer r14-l-b1'], 'B\'s bare bearer is not held by A\'s wait after a restart');
          assert.ok(!(inst.gate.get('antigravity') > Date.now()), 'and B shows no wait');
          writeAg('r14-l-a@example.com', 'r14-l-a2');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 2, 'A is still held');
          inst.on['will-quit']();
        }

        // Fix 2 (loadCodeAssist): the same with A's loadCodeAssist 429. B's quota fails and its own lookup succeeds, so
        // B leaves no reading and no wait to say whose its bearer is.
        {
          let inst = fresh();
          quotaAnswer = (auth) => (auth?.includes('r14-lt-b') ? down() : quotaAt(0.5)());
          tierAnswer = (auth) => (auth === 'Bearer r14-lt-a1' ? tier429() : proTier());
          const mine = (who) => tierBearers.filter((b) => b.includes(`r14-lt-${who}`));
          writeAg('r14-lt-a@example.com', 'r14-lt-a1');
          await inst.readOne(wrappedAg, true);
          await settle();
          writeBare({ access_token: 'r14-lt-a1' });
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine('a'), ['Bearer r14-lt-a1'], 'A\'s bare bearer waits out A\'s loadCodeAssist 429');
          writeAg('r14-lt-b@example.com', 'r14-lt-b1');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine('b'), ['Bearer r14-lt-b1']);
          inst = restart(inst);
          writeBare({ access_token: 'r14-lt-b1' });
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine('b'), ['Bearer r14-lt-b1', 'Bearer r14-lt-b1'], 'B\'s bare bearer is not held by A\'s wait after a restart');
          tierAnswer = proTier;
          inst.on['will-quit']();
        }

        // Fix 3 (quota): A's bare bearer draws a 429 that B's bare bearer then waits under. Once A's email comes with the
        // exact bearer that drew it, the wait is A's: B, verified under its own email, is released, and stays released
        // after a restart, bare or named. A stays held.
        {
          let inst = fresh();
          quotaAnswer = (auth) => (auth === 'Bearer r14-o-a1' ? quota429() : auth?.includes('r14-o-b') ? down() : quotaAt(0.5)());
          writeBare({ access_token: 'r14-o-a1' });
          await inst.readOne(wrappedAg, true);
          const sent = sentBearers.length;
          writeBare({ access_token: 'r14-o-b1' });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'B\'s bare bearer waits: it may be A\'s rotation');
          writeAg('r14-o-a@example.com', 'r14-o-a1');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'A, named, is held by its own wait');
          writeAg('r14-o-b@example.com', 'r14-o-b1');
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual(sentBearers.slice(sent), ['Bearer r14-o-b1'], 'B, verified, is released');
          inst.flushState();
          assert.ok(saved().accountGates.antigravity.some((g) => [`tok:${keyOf('r14-o-a1')}`, keyOf('r14-o-a@example.com')].every((k) => g.origin.includes(k))), "the wait is saved as A's: the bearer that drew it, and A's email");
          assert.ok(!(inst.gate.get('antigravity') > Date.now()), 'and shows no wait');
          inst = restart(inst);
          await inst.readOne(wrappedAg, true);
          writeBare({ access_token: 'r14-o-b1' });
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual(sentBearers.slice(sent), Array(3).fill('Bearer r14-o-b1'), 'and after a restart, named or bare');
          writeAg('r14-o-a@example.com', 'r14-o-a2');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent + 3, 'A is still held');
          inst.on['will-quit']();
        }

        // Fix 3 (loadCodeAssist): the same with A's bare bearer's loadCodeAssist 429.
        {
          let inst = fresh();
          quotaAnswer = (auth) => (auth?.includes('r14-ot-b') ? down() : quotaAt(0.5)());
          tierAnswer = (auth) => (auth === 'Bearer r14-ot-a1' ? tier429() : proTier());
          const mine = (who) => tierBearers.filter((b) => b.includes(`r14-ot-${who}`));
          writeBare({ access_token: 'r14-ot-a1' });
          await inst.readOne(wrappedAg, true);
          await settle();
          writeBare({ access_token: 'r14-ot-b1' });
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine('b'), [], 'B\'s bare bearer waits: it may be A\'s rotation');
          writeAg('r14-ot-a@example.com', 'r14-ot-a1');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine('a'), ['Bearer r14-ot-a1'], 'A, named, is held by its own wait');
          writeAg('r14-ot-b@example.com', 'r14-ot-b1');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine('b'), ['Bearer r14-ot-b1'], 'B, verified, is released');
          inst = restart(inst);
          writeBare({ access_token: 'r14-ot-b1' });
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine('b'), ['Bearer r14-ot-b1', 'Bearer r14-ot-b1'], 'and after a restart');
          writeAg('r14-ot-a@example.com', 'r14-ot-a2');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine('a'), ['Bearer r14-ot-a1'], 'A is still held');
          tierAnswer = proTier;
          inst.on['will-quit']();
        }

        // Round 4 Fix 2 still holds on both endpoints, across a restart: a bare bearer nothing ever names draws the 429s;
        // its bare rotation, then that rotation with an email and a refresh token, wait them out.
        {
          let inst = fresh();
          quotaAnswer = quota429;
          writeBare({ access_token: 'r14-w1' });
          await inst.readOne(wrappedAg, true);
          quotaAnswer = quotaAt(0.5);
          const sent = sentBearers.length;
          writeBare({ access_token: 'r14-w2' });
          await inst.readOne(wrappedAg, true);
          writeAg('r14-w@example.com', 'r14-w2', { refresh_token: 'r14-w-rt' });
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'quota: the unnamed bearer\'s wait holds its rotation once named');
          inst = restart(inst);
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(sentBearers.length, sent, 'after a restart too');
          inst.on['will-quit']();
        }
        {
          let inst = fresh();
          quotaAnswer = quotaAt(0.5);
          tierAnswer = (auth) => (auth === 'Bearer r14-tw1' ? tier429() : proTier());
          const mine = () => tierBearers.filter((b) => b.includes('r14-tw2'));
          writeBare({ access_token: 'r14-tw1' });
          await inst.readOne(wrappedAg, true);
          await settle();
          writeBare({ access_token: 'r14-tw2' });
          await inst.readOne(wrappedAg, true);
          await settle();
          writeAg('r14-tw@example.com', 'r14-tw2', { refresh_token: 'r14-tw-rt' });
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(sentBearers.at(-1), 'Bearer r14-tw2', 'quota is read');
          assert.deepStrictEqual(mine(), [], 'loadCodeAssist: the unnamed bearer\'s wait holds its rotation once named');
          inst = restart(inst);
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual(mine(), [], 'after a restart too');
          tierAnswer = proTier;
          inst.on['will-quit']();
        }
      } finally {
        global.fetch = savedFetchR14;
        fs.writeFileSync(statePathR14, stateBefore);
        providersMod.clearAntigravityTierGates();
        wrappedAg.restoreTierGates(tierBefore);
      }
    }

    // Round 15: fresh main.js instances with credentials nothing else uses, on a state.json holding none of the waits
    // the checks above left, as in Round 14. Fix 3 runs on a fake clock, put back after each check.
    {
      const savedFetchR15 = global.fetch;
      const clockWas = Date.now;
      const statePathR15 = path.join(dir, 'state.json');
      flushState();
      const stateBefore = fs.readFileSync(statePathR15, 'utf8');
      const { accountGates: _g, tierGates: _t, cache: _c, signedIn: _s, ...clean } = JSON.parse(stateBefore);
      const tierBefore = wrappedAg.tierGates();
      const sentBearers = [];
      const tierBearers = [];
      const holds = new Map(); // 'Bearer x' or 'tier Bearer x' -> { answer, release }: that bearer's next request waits for release()
      const quotaAt = (frac) => () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: frac, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      const quota429 = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
      const tier429 = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) });
      const rejected = () => ({ ok: false, status: 401, headers: new Headers() });
      const proTier = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
      const ultraTier = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } }) });
      let quotaAnswer = quotaAt(0.5);
      let tierAnswer = proTier;
      global.fetch = async (url, opts) => {
        const auth = opts?.headers?.Authorization;
        const tier = url.endsWith(':loadCodeAssist');
        (tier ? tierBearers : sentBearers).push(auth);
        const key = `${tier ? 'tier ' : ''}${auth}`;
        const h = holds.get(key);
        if (!h) return tier ? tierAnswer(auth) : quotaAnswer(auth);
        holds.delete(key);
        await new Promise((r) => (h.release = r));
        return h.answer();
      };
      const holdOnce = (bearer, answer, tier = false) => {
        const h = { answer, release: null };
        holds.set(`${tier ? 'tier ' : ''}Bearer ${bearer}`, h);
        return h;
      };
      const until = async (ready) => {
        for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
        assert.ok(ready(), 'the step it waits for happened');
      };
      const settle = () => new Promise((r) => setTimeout(r, 10));
      const writeBare = (token) => fs.writeFileSync(agMainAuth, JSON.stringify({ token: { expiry: new Date(Date.now() + 3600_000).toISOString(), ...token } }));
      const keyOf = (s) => require('crypto').createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
      const shown = (inst) => inst.snapshot().find((p) => p.id === 'antigravity');
      const asked = (list, bearer) => list.filter((b) => b === `Bearer ${bearer}`).length;
      const expiredAt = { expiry: '2020-01-01T00:00:00Z' };
      const fresh = () => {
        providersMod.clearAntigravityTierGates();
        fs.writeFileSync(statePathR15, JSON.stringify(clean));
        return loadInstance();
      };
      try {
        // Fix 1 (loadCodeAssist): A's lookup goes out under A's email. A check sees A's bearer bare while it is out, and
        // once its 429 lands the bearer rotates, still bare. The wait holds the rotation, as it would had the bare bearer
        // shown after the 429, and stays A's: the rotation named as B is released, a later one named as A is held.
        {
          const inst = fresh();
          const h = holdOnce('r15-t-1', tier429, true);
          writeAg('r15-t-a@example.com', 'r15-t-1');
          await inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeBare({ access_token: 'r15-t-1' });
          await inst.readOne(wrappedAg, true); // the check that sees it bare
          h.release();
          await settle();
          writeBare({ access_token: 'r15-t-2' });
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, 'r15-t-2'), 0, "A's bare rotation waits out A's loadCodeAssist 429");
          writeAg('r15-t-b@example.com', 'r15-t-2');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, 'r15-t-2'), 1, 'named as another account, it is released');
          writeBare({ access_token: 'r15-t-3' });
          await inst.readOne(wrappedAg, true);
          writeAg('r15-t-a@example.com', 'r15-t-3');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, 'r15-t-3'), 0, 'named as A, it is held');
          assert.strictEqual(asked(tierBearers, 'r15-t-1'), 1);
          inst.on['will-quit']();
        }

        // Fix 1 (quota): the same with A's quota request. A refresh sees A's bearer bare while the request is out (and joins
        // it), and the bearer rotates, still bare, before the 429's own credential check.
        {
          const inst = fresh();
          writeAg('r15-q-a@example.com', 'r15-q-1');
          const h = holdOnce('r15-q-1', quota429);
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeBare({ access_token: 'r15-q-1' });
          const manual = inst.readOne(wrappedAg, true);
          await settle();
          writeBare({ access_token: 'r15-q-2' });
          h.release();
          await Promise.all([first, manual]);
          assert.ok(shown(inst).waitMs > 0, "A's wait shows for the rotation");
          inst.flushState();
          assert.ok(saved().accountGates.antigravity.some((g) => g.keys.includes('__weak__') && g.origin.includes(keyOf('r15-q-a@example.com')) && !g.origin.includes('__weak__')), "saved on `__weak__`, and as A's");
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(asked(sentBearers, 'r15-q-2'), 0, "A's bare rotation waits out A's 429");
          writeAg('r15-q-b@example.com', 'r15-q-2');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(asked(sentBearers, 'r15-q-2'), 1, 'named as another account, it is released');
          writeBare({ access_token: 'r15-q-3' });
          await inst.readOne(wrappedAg, true);
          writeAg('r15-q-a@example.com', 'r15-q-3');
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(asked(sentBearers, 'r15-q-3'), 0, 'named as A, it is held');
          assert.strictEqual(asked(sentBearers, 'r15-q-1'), 1, "A's bearer was asked once: the refresh that saw it bare joined");
          inst.on['will-quit']();
        }

        // Fix 2 (manual refresh): the email goes while the request is out, the bearer kept. A refresh joins the request
        // rather than send the bearer again, and the answer shows and is saved under the account's new name. Then the
        // email comes back with a refresh token while the next request is out: the same, and the new link is saved.
        {
          const inst = fresh();
          writeAg('r15-j@example.com', 'r15-j-1');
          let h = holdOnce('r15-j-1', quotaAt(0.2));
          let first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeBare({ access_token: 'r15-j-1' });
          let manual = inst.readOne(wrappedAg, true);
          await settle();
          h.release();
          await Promise.all([first, manual]);
          assert.strictEqual(asked(sentBearers, 'r15-j-1'), 1, 'one request for the bearer');
          assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent], [undefined, 80], 'its answer shows');
          assert.strictEqual(inst.last.get('antigravity').renewsFor, keyOf('r15-j-1'), 'under the name the credential has now');
          assert.strictEqual(inst.savedCache().antigravity.rows[0].percent, 80, 'and is saved');
          h = holdOnce('r15-j-1', quotaAt(0.4));
          first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeAg('r15-j@example.com', 'r15-j-1', { refresh_token: 'r15-j-rt' });
          manual = inst.readOne(wrappedAg, true);
          await settle();
          h.release();
          await Promise.all([first, manual]);
          assert.strictEqual(asked(sentBearers, 'r15-j-1'), 2, 'one request each time');
          assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, inst.last.get('antigravity').renewsFor], [undefined, 60, keyOf('r15-j@example.com')]);
          inst.flushState();
          assert.ok(saved().accountLinks.antigravity.some((g) => [keyOf('r15-j@example.com'), keyOf('r15-j-rt'), `tok:${keyOf('r15-j-1')}`].every((k) => g.includes(k))), 'the refresh token the joining check saw is linked and saved');
          inst.on['will-quit']();
        }

        // Fix 2 (no refresh): the email goes while the request is out. The answer's own check sees the same account under
        // another name: it shows the answer and saves it, with every key the account was read under.
        {
          const inst = fresh();
          writeAg('r15-p@example.com', 'r15-p-1');
          const h = holdOnce('r15-p-1', quotaAt(0.2));
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeBare({ access_token: 'r15-p-1' });
          h.release();
          await first;
          assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent], [undefined, 80], 'the answer shows, not dropped as another account\'s');
          const kept = inst.savedCache().antigravity;
          assert.strictEqual(kept.renewsFor, keyOf('r15-p-1'), 'saved under the name the credential has now');
          assert.ok([keyOf('r15-p@example.com'), `tok:${keyOf('r15-p-1')}`].every((k) => kept.gateKeys.includes(k)) && !kept.gateKeys.includes('__weak__'), 'with the account\'s keys');
          inst.on['will-quit']();
        }

        // Fix 2 (a rejected bearer): the bearer is replaced and the email goes while the request is out, the refresh
        // token kept. The rejection is retried once with the replacement, as for a bearer rotated under one name.
        {
          const inst = fresh();
          writeAg('r15-r@example.com', 'r15-r-1', { refresh_token: 'r15-r-rt' });
          const h = holdOnce('r15-r-1', rejected);
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          writeBare({ access_token: 'r15-r-2', refresh_token: 'r15-r-rt' });
          quotaAnswer = quotaAt(0.3);
          h.release();
          await first;
          quotaAnswer = quotaAt(0.5);
          assert.deepStrictEqual([asked(sentBearers, 'r15-r-1'), asked(sentBearers, 'r15-r-2')], [1, 1], 'retried with the replacement');
          assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, inst.last.get('antigravity').renewsFor], [undefined, 70, keyOf('r15-r-rt')]);
          inst.on['will-quit']();
        }

        // Fix 3: a 120s wait, the token found expired inside it (at 60s, and off the 60s cadence at 100s), a valid
        // replacement installed before it lifts. The sign-in note shows no wait, and a tick still inside the wait doesn't
        // look; the first tick after the deadline finds the replacement, brings back the numbers and reads.
        for (const seenAt of [60_000, 100_000]) {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const tag = `r15-x${seenAt / 1000}`;
            writeAg(`${tag}@example.com`, `${tag}-1`);
            quotaAnswer = quotaAt(0.6);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = quota429;
            clock += wrappedAg.everyMs;
            await inst.readOne(wrappedAg, false);
            const t0 = clock;
            assert.strictEqual(inst.gate.get('antigravity'), t0 + 120_000, 'the 429 holds it 120s');
            quotaAnswer = quotaAt(0.5);
            clock = t0 + seenAt;
            writeAg(`${tag}@example.com`, `${tag}-1`, expiredAt);
            await inst.readOne(wrappedAg, false);
            assert.match(shown(inst).error || '', /Session expired/, `${seenAt / 1000}s: the expiry shows`);
            assert.strictEqual(shown(inst).waitMs, 0, 'with no wait beside it');
            clock = t0 + 110_000;
            writeAg(`${tag}@example.com`, `${tag}-2`);
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([/Session expired/.test(shown(inst).error || ''), asked(sentBearers, `${tag}-2`)], [true, 0], 'a tick inside the wait does not look yet');
            clock = t0 + 121_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, asked(sentBearers, `${tag}-2`)], [undefined, 50, 1], 'the first tick after the deadline finds the replacement and reads');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Fix 3 (a failed look): the credential lookup fails on that first tick after the deadline. It is tried again once
        // the lookup's own 60s retry wait is over, not a whole cadence later.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r15-xf@example.com', 'r15-xf-1');
            await inst.readOne(wrappedAg, true);
            quotaAnswer = quota429;
            clock += wrappedAg.everyMs;
            await inst.readOne(wrappedAg, false);
            const t0 = clock;
            quotaAnswer = quotaAt(0.5);
            clock = t0 + 60_000;
            writeAg('r15-xf@example.com', 'r15-xf-1', expiredAt);
            await inst.readOne(wrappedAg, false);
            writeAg('r15-xf@example.com', 'r15-xf-2');
            clock = t0 + 121_000;
            peekHook = () => ((peekHook = null), Promise.resolve({ status: 'error', error: 'Antigravity credential lookup timed out', soft: true }));
            await inst.readOne(wrappedAg, false);
            assert.ok(!peekHook, 'the lookup was tried, and failed');
            assert.match(shown(inst).error || '', /Session expired/);
            clock = t0 + 150_000;
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(asked(sentBearers, 'r15-xf-2'), 0, 'not again inside its retry wait');
            clock = t0 + 182_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, asked(sentBearers, 'r15-xf-2')], [undefined, 50, 1], 'found once that wait is over');
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
          }
        }

        // Fix 3 (no wait): an expired token on an account under no wait is looked at again on the cadence, not every tick.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r15-n@example.com', 'r15-n-1', expiredAt);
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/);
            const peeks = peekCalls;
            const checkedAt = clock;
            while (clock + 15_000 < checkedAt + wrappedAg.everyMs) {
              clock += 15_000;
              await inst.readOne(wrappedAg, false);
            }
            assert.strictEqual(peekCalls, peeks, 'no credential check on the 15s ticks');
            clock += 15_000;
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(peekCalls, peeks + 1, 'one at the cadence');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
          }
        }

        // Round 16 Fix 1: a 150s wait, the token found expired at 60s, the credential lookup failing at 120s inside the
        // wait, a valid replacement installed meanwhile. The failed lookup is tried again as the wait lifts, not 60s on.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r16-c@example.com', 'r16-c-1');
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '150' }) });
            clock += wrappedAg.everyMs;
            await inst.readOne(wrappedAg, false);
            const t0 = clock;
            assert.strictEqual(inst.gate.get('antigravity'), t0 + 150_000, 'the 429 holds it 150s');
            quotaAnswer = quotaAt(0.5);
            clock = t0 + 60_000;
            writeAg('r16-c@example.com', 'r16-c-1', expiredAt);
            await inst.readOne(wrappedAg, false);
            assert.match(shown(inst).error || '', /Session expired/);
            clock = t0 + 120_000;
            writeAg('r16-c@example.com', 'r16-c-2');
            peekHook = () => ((peekHook = null), Promise.resolve({ status: 'error', error: 'Antigravity credential lookup timed out', soft: true }));
            await inst.readOne(wrappedAg, false);
            assert.ok(!peekHook, 'the lookup inside the wait was tried, and failed');
            clock = t0 + 140_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([/Session expired/.test(shown(inst).error || ''), asked(sentBearers, 'r16-c-2')], [true, 0], 'not again inside the wait');
            clock = t0 + 151_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, asked(sentBearers, 'r16-c-2')], [undefined, 50, 1], 'the first tick after the wait finds the replacement and reads');
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 16 Fix 2: A's 429 lands before any reading of A's. Antigravity is switched off, B signs in, and it is
        // switched back on. No snapshot shows A's wait for B: not the first B's check releases, nor any while B's request is out.
        {
          const inst = fresh();
          writeAg('r16-ea@example.com', 'r16-ea-1');
          quotaAnswer = quota429;
          await inst.readOne(wrappedAg, true);
          quotaAnswer = quotaAt(0.5);
          assert.ok(shown(inst).waitMs > 0 && !shown(inst).rows.length, "A's wait shows, with no reading");
          await inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: false } }));
          await settle();
          writeAg('r16-eb@example.com', 'r16-eb-1');
          const h = holdOnce('r16-eb-1', quotaAt(0.3));
          const from = inst.sent.length;
          await inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: true } }));
          await until(() => h.release);
          const waits = inst.sent.slice(from).filter(([ch]) => ch === 'data').map(([, v]) => v.find((q) => q.id === 'antigravity')?.waitMs);
          assert.ok(waits.length > 1 && waits.every((w) => w === 0), `B shows no wait while its request is out: ${waits}`);
          h.release();
          await settle();
          assert.deepStrictEqual([shown(inst).waitMs, shown(inst).rows[0]?.percent], [0, 70]);
          inst.on['will-quit']();
        }

        // Round 16 Fix 3: the plan is the account's under every name it has shown. A, read as AI Pro, drops its email (the
        // bearer and refresh token kept): no new lookup. Six hours on, still without it, the lookup says AI Ultra; the email
        // comes back and it stays AI Ultra, with no lookup of its own. A new bearer still looks again, and another account
        // shows none of A's plan.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const plan = async () => {
              await settle();
              await inst.readOne(wrappedAg, false); // folds a lookup that landed after the quota answer
              return shown(inst).plan;
            };
            const withEmail = (tok) => writeAg('r16-t@example.com', tok, { refresh_token: 'r16-t-rt' });
            const without = () => writeBare({ access_token: 'r16-t-1', refresh_token: 'r16-t-rt' });
            withEmail('r16-t-1');
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([await plan(), asked(tierBearers, 'r16-t-1')], ['AI Pro', 1]);
            clock += 60_000;
            without();
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([await plan(), asked(tierBearers, 'r16-t-1')], ['AI Pro', 1], 'the email gone: the same account, no lookup');
            tierAnswer = ultraTier;
            clock += 6 * 3600_000;
            without();
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([await plan(), asked(tierBearers, 'r16-t-1')], ['AI Ultra', 2], 'six hours on, looked up again');
            clock += 60_000;
            withEmail('r16-t-1');
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([await plan(), asked(tierBearers, 'r16-t-1')], ['AI Ultra', 2], 'the email back: still AI Ultra, no lookup of its own');
            tierAnswer = proTier;
            withEmail('r16-t-2');
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([await plan(), asked(tierBearers, 'r16-t-2')], ['AI Pro', 1], 'a new bearer looks again');
            const h = holdOnce('r16-u-1', ultraTier, true);
            writeAg('r16-u@example.com', 'r16-u-1', { refresh_token: 'r16-u-rt' });
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([shown(inst).plan, wrappedAg.cachedPlan(keyOf('r16-u@example.com'))], ['', ''], "another account shows none of A's plan");
            h.release();
            assert.deepStrictEqual([await plan(), wrappedAg.cachedPlan(keyOf('r16-t@example.com'))], ['AI Ultra', 'AI Pro'], 'and its own lookup leaves A\'s alone');
            // The same with no refresh token: the bare bearer's lookup goes under its hash, linked to the email as `tok:`.
            writeAg('r16-w@example.com', 'r16-w-1');
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([await plan(), asked(tierBearers, 'r16-w-1')], ['AI Pro', 1]);
            tierAnswer = ultraTier;
            clock += 6 * 3600_000;
            writeBare({ access_token: 'r16-w-1' });
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([await plan(), asked(tierBearers, 'r16-w-1')], ['AI Ultra', 2], 'the bare bearer, six hours on');
            writeAg('r16-w@example.com', 'r16-w-1');
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([await plan(), asked(tierBearers, 'r16-w-1')], ['AI Ultra', 2], 'the email back: still AI Ultra, no lookup of its own');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            tierAnswer = proTier;
          }
        }

        // Round 17 Fix 1 (quota): A's request is out under its old bearer when the bearer rotates, and the new bearer's
        // request goes out beside it. The old one's 429 lands, then the new one meets a transport error: its one retry
        // waits out the 429 like any other request. With no wait on hand, a transport error is still retried once.
        const offline = () => {
          throw new TypeError('fetch failed');
        };
        const pastRetry = () => new Promise((r) => setTimeout(r, 400)); // fetchJson retries 250ms after a transport error
        {
          const inst = fresh();
          writeAg('r17-q@example.com', 'r17-q-1');
          const h0 = holdOnce('r17-q-1', offline);
          const first = inst.readOne(wrappedAg, true);
          await until(() => h0.release);
          h0.release();
          await first;
          assert.deepStrictEqual([asked(sentBearers, 'r17-q-1'), shown(inst).rows[0]?.percent], [2, 50], 'with no wait on hand, a transport error is retried once');
          const h1 = holdOnce('r17-q-1', quota429);
          const old = inst.readOne(wrappedAg, true);
          await until(() => h1.release);
          writeAg('r17-q@example.com', 'r17-q-2');
          const h2 = holdOnce('r17-q-2', offline);
          const rotated = inst.readOne(wrappedAg, true);
          await until(() => h2.release);
          h1.release();
          await old;
          h2.release();
          await rotated;
          assert.deepStrictEqual([asked(sentBearers, 'r17-q-2'), inst.gate.get('antigravity') > Date.now()], [1, true], "the new bearer's retry waits out the old one's 429");
          inst.on['will-quit']();
        }

        // Round 17 Fix 1 (loadCodeAssist): two bare bearers, either possibly the other's rotation, each with a lookup out.
        // The second meets a transport error, and the first's 429 lands while its retry waits: the retry waits out the 429.
        // A named account's lookup with no wait on hand is still retried once.
        {
          const inst = fresh();
          const h0 = holdOnce('r17-tc-1', offline, true);
          writeAg('r17-tc@example.com', 'r17-tc-1');
          await inst.readOne(wrappedAg, true);
          await until(() => h0.release);
          h0.release();
          await pastRetry();
          assert.strictEqual(asked(tierBearers, 'r17-tc-1'), 2, 'with no wait on hand, a transport error is retried once');
          const h1 = holdOnce('r17-t-1', tier429, true);
          writeBare({ access_token: 'r17-t-1' });
          await inst.readOne(wrappedAg, true);
          await until(() => h1.release);
          const h2 = holdOnce('r17-t-2', offline, true);
          writeBare({ access_token: 'r17-t-2' });
          await inst.readOne(wrappedAg, true);
          await until(() => h2.release);
          h2.release();
          await settle();
          h1.release();
          await pastRetry();
          assert.strictEqual(asked(tierBearers, 'r17-t-2'), 1, "the second lookup's retry waits out the first one's 429");
          inst.on['will-quit']();
        }

        // Round 17 Fix 2: a 90s wait, and the credential lookup after its request failing: the wait is armed on screen
        // right away (Round 47 Fix 3), and when the lookup fails again at 60s, the next comes as the wait lifts at 90s.
        {
          let clock = clockWas();
          Date.now = () => clock;
          const lookupFailed = () => Promise.resolve({ status: 'error', error: 'Antigravity credential lookup timed out', soft: true });
          try {
            const inst = fresh();
            writeAg('r17-c@example.com', 'r17-c-1');
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) });
            clock += wrappedAg.everyMs;
            let step = 0;
            peekHook = (orig) => (++step === 2 ? lookupFailed() : orig());
            await inst.readOne(wrappedAg, false);
            const t0 = clock;
            assert.deepStrictEqual([step, inst.gate.get('antigravity')], [2, t0 + 90_000], 'the lookup after the 429 failed, and the 90s wait is armed immediately');
            quotaAnswer = quotaAt(0.2);
            clock = t0 + 60_000;
            peekHook = () => ((peekHook = null), lookupFailed());
            await inst.readOne(wrappedAg, false);
            assert.ok(!peekHook, 'the lookup at 60s was tried, and failed');
            const peeks = peekCalls;
            clock = t0 + 75_000;
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(peekCalls, peeks, 'not again inside the wait');
            const sent = asked(sentBearers, 'r17-c-1');
            clock = t0 + 90_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).rows[0]?.percent, asked(sentBearers, 'r17-c-1')], [80, sent + 1], 'the tick as the wait lifts finds the credential and reads');
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 18 Fix 1: quota and loadCodeAssist both meet a transport error, and the sign-out is confirmed while their
        // retries wait out the 250ms pause. Neither retry goes out: the removed bearer is sent once to each, and the
        // cancelled lookup leaves no wait behind.
        {
          const inst = fresh();
          const hq = holdOnce('r18-s-1', offline);
          const ht = holdOnce('r18-s-1', offline, true);
          writeAg('r18-s@example.com', 'r18-s-1');
          const first = inst.readOne(wrappedAg, true);
          await until(() => hq.release && ht.release);
          hq.release();
          ht.release();
          await settle(); // both are in the pause now
          fs.rmSync(agMainAuth, { force: true });
          await inst.readOne(wrappedAg, true);
          assert.ok(inst.last.get('antigravity')?.signedOut, 'the sign-out is confirmed inside the pause');
          await first;
          await pastRetry();
          assert.deepStrictEqual([asked(sentBearers, 'r18-s-1'), asked(tierBearers, 'r18-s-1')], [1, 1], 'neither retry sends the removed bearer');
          assert.deepStrictEqual(wrappedAg.tierGates(), [], 'the cancelled lookup arms no wait');
          inst.on['will-quit']();
        }
        // The same for quota when another account signs in, or Antigravity is switched off, inside the pause.
        for (const [tag, move] of [
          ['w', (inst) => (writeAg('r18-w2@example.com', 'r18-w-2'), inst.readOne(wrappedAg, true))],
          ['d', (inst) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: false } }))],
        ]) {
          const inst = fresh();
          const h = holdOnce(`r18-${tag}-1`, offline);
          writeAg(`r18-${tag}@example.com`, `r18-${tag}-1`);
          const first = inst.readOne(wrappedAg, true);
          await until(() => h.release);
          h.release();
          await settle();
          await move(inst);
          await first;
          assert.strictEqual(asked(sentBearers, `r18-${tag}-1`), 1, `${tag === 'w' ? 'a switch' : 'switching it off'} cancels the retry`);
          inst.on['will-quit']();
        }

        // Round 18 Fix 2: A's request is out when its bearer rotates, and the check after the replacement's request fails,
        // so the next look is due at 60s. A's old request then draws a 429 at 10s with Retry-After 20: polling resumes as
        // that wait lifts at 30s, not at 60s.
        {
          let clock = clockWas();
          Date.now = () => clock;
          const lookupFailed = () => Promise.resolve({ status: 'error', error: 'Antigravity credential lookup timed out', soft: true });
          try {
            const inst = fresh();
            writeAg('r18-c@example.com', 'r18-c-1');
            await inst.readOne(wrappedAg, true);
            const h = holdOnce('r18-c-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '20' }) }));
            const old = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            writeAg('r18-c@example.com', 'r18-c-2');
            let step = 0;
            peekHook = (orig) => (++step === 2 ? lookupFailed() : orig());
            await inst.readOne(wrappedAg, true);
            peekHook = null;
            const t0 = clock;
            assert.deepStrictEqual([step, asked(sentBearers, 'r18-c-2')], [2, 1], "the replacement's request went out and the check after it failed");
            clock = t0 + 10_000;
            h.release();
            await old;
            assert.strictEqual(inst.gate.get('antigravity'), t0 + 30_000, "the old request's 429 holds the provider until 30s");
            const peeks = peekCalls;
            clock = t0 + 25_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([peekCalls, asked(sentBearers, 'r18-c-2')], [peeks, 1], 'nothing is asked inside the wait');
            quotaAnswer = quotaAt(0.2);
            clock = t0 + 30_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([peekCalls > peeks, asked(sentBearers, 'r18-c-2'), shown(inst).rows[0]?.percent], [true, 2, 80], 'the tick as the wait lifts looks and reads');
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 19 Fix 1: A's lookup meets a transport error, and inside its 250ms pause the bearer rotates (the same
        // account), another account signs in, or Antigravity is switched off. The retry is called off: A's bearer is sent
        // once and the cancelled lookup holds no wait. After the rotation the replacement's lookup goes at the next read.
        for (const [tag, move, what] of [
          ['r', (inst) => (writeAg('r19-r@example.com', 'r19-r-2'), inst.readOne(wrappedAg, true)), 'a rotation'],
          ['w', (inst) => (writeAg('r19-w2@example.com', 'r19-w-2'), inst.readOne(wrappedAg, true)), 'a switch'],
          ['d', (inst) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: false } })), 'switching it off'],
        ]) {
          const inst = fresh();
          const ht = holdOnce(`r19-${tag}-1`, offline, true);
          writeAg(`r19-${tag}@example.com`, `r19-${tag}-1`);
          await inst.readOne(wrappedAg, true);
          await until(() => ht.release);
          // Had the retry gone, the superseded bearer would draw a 401 and hold the account's lookups for five minutes.
          tierAnswer = (auth) => (auth === `Bearer r19-${tag}-1` ? rejected() : proTier());
          ht.release();
          await settle(); // the lookup is in its pause
          await move(inst);
          await pastRetry();
          assert.deepStrictEqual([asked(tierBearers, `r19-${tag}-1`), wrappedAg.tierGates()], [1, []], `${what} cancels the lookup's retry, which holds no wait`);
          if (tag === 'r') {
            await inst.readOne(wrappedAg, true);
            await settle();
            await inst.readOne(wrappedAg, false); // folds the lookup that landed
            assert.deepStrictEqual([asked(tierBearers, 'r19-r-2'), shown(inst).plan], [1, 'AI Pro'], "the replacement's lookup goes at once");
          }
          tierAnswer = proTier;
          inst.on['will-quit']();
        }

        // Round 19 Fix 2: quota and loadCodeAssist both meet a transport error, and the bearer's stored expiry passes while
        // their retries wait out the 250ms pause. Neither retry sends the expired bearer, the cancelled lookup holds no
        // wait, and the read ends on the sign-in note.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const hq = holdOnce('r19-e-1', offline);
            const ht = holdOnce('r19-e-1', offline, true);
            writeAg('r19-e@example.com', 'r19-e-1');
            const first = inst.readOne(wrappedAg, true);
            await until(() => hq.release && ht.release);
            hq.release();
            ht.release();
            await settle(); // both are in the pause now
            clock += 3600_001; // past writeAg's expiry
            await first;
            await pastRetry();
            assert.deepStrictEqual([asked(sentBearers, 'r19-e-1'), asked(tierBearers, 'r19-e-1')], [1, 1], 'neither retry sends the expired bearer');
            assert.deepStrictEqual(wrappedAg.tierGates(), [], 'the cancelled lookup arms no wait');
            assert.ok(inst.last.get('antigravity')?.expired, 'the read ends on the sign-in note');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
          }
        }

        // Round 20 Fix 1: A's lookup is out when its bearer rotates (the same account). The replacement's quota read lands
        // and its lookup waits on the one out, which then draws a 401. The refusal holds only the bearer refused: the
        // replacement's lookup goes at the next read and its plan lands.
        {
          const inst = fresh();
          const ht = holdOnce('r20-a-1', rejected, true);
          writeAg('r20-a@example.com', 'r20-a-1');
          await inst.readOne(wrappedAg, true);
          await until(() => ht.release);
          writeAg('r20-a@example.com', 'r20-a-2');
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual([asked(sentBearers, 'r20-a-2'), asked(tierBearers, 'r20-a-2'), shown(inst).rows[0]?.percent], [1, 0, 50], "the replacement's quota read lands, its lookup waits on the one out");
          ht.release();
          await settle();
          assert.deepStrictEqual(wrappedAg.tierGates(), [], "the old bearer's 401 holds nothing its account shares");
          await inst.readOne(wrappedAg, true);
          await settle();
          await inst.readOne(wrappedAg, false); // folds the lookup that landed
          assert.deepStrictEqual([asked(tierBearers, 'r20-a-2'), shown(inst).plan], [1, 'AI Pro'], "the replacement's lookup goes at once");
          inst.on['will-quit']();
        }
        // The refused bearer, still on disk, isn't sent again inside five minutes; its replacement is, at once. A 401 that
        // names a Retry-After still holds the account for it.
        {
          const inst = fresh();
          tierAnswer = (auth) => (auth === 'Bearer r20-b-1' ? rejected() : proTier());
          writeAg('r20-b@example.com', 'r20-b-1');
          await inst.readOne(wrappedAg, true);
          await settle();
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, 'r20-b-1'), 1, 'the refused bearer waits five minutes');
          writeAg('r20-b@example.com', 'r20-b-2');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, 'r20-b-2'), 1, 'its replacement asks at once');
          tierAnswer = (auth) => (auth === 'Bearer r20-b-3' ? { ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) } : proTier());
          writeAg('r20-b@example.com', 'r20-b-3');
          await inst.readOne(wrappedAg, true);
          await settle();
          writeAg('r20-b@example.com', 'r20-b-4');
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.deepStrictEqual([asked(tierBearers, 'r20-b-3'), asked(tierBearers, 'r20-b-4')], [1, 0], "a 401's Retry-After holds the account's next bearer");
          tierAnswer = proTier;
          inst.on['will-quit']();
        }
        // The lookup's one retry goes out before the rotation and meets a transport error after it: the replaced bearer's
        // failure holds nothing, and the replacement's lookup goes at the next read.
        {
          const inst = fresh();
          const h1 = holdOnce('r20-c-1', offline, true);
          writeAg('r20-c@example.com', 'r20-c-1');
          await inst.readOne(wrappedAg, true);
          await until(() => h1.release);
          const h2 = holdOnce('r20-c-1', offline, true);
          h1.release();
          await until(() => h2.release); // the retry is out
          writeAg('r20-c@example.com', 'r20-c-2');
          await inst.readOne(wrappedAg, true);
          h2.release();
          await settle();
          assert.deepStrictEqual([asked(tierBearers, 'r20-c-1'), wrappedAg.tierGates()], [2, []], "the replaced bearer's transport error holds nothing");
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, 'r20-c-2'), 1, "the replacement's lookup goes at once");
          inst.on['will-quit']();
        }

        // Round 20 Fix 2: A's lookup meets a transport error, and inside its 250ms pause Antigravity is switched off and on
        // again, B signed in meanwhile and the check after the switch-on still out. The retry stays called off: A's bearer
        // is sent once, and the cancelled lookup holds no wait.
        {
          const inst = fresh();
          const ht = holdOnce('r20-d-1', offline, true);
          writeAg('r20-d@example.com', 'r20-d-1');
          await inst.readOne(wrappedAg, true);
          await until(() => ht.release);
          ht.release();
          await settle(); // the lookup is in its pause
          const toggle = (on) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: on } }));
          await toggle(false);
          writeAg('r20-d2@example.com', 'r20-d-2');
          const checks = [];
          peekHook = (orig) => new Promise((r) => checks.push(() => r(orig())));
          try {
            await toggle(true);
            const read = inst.readOne(wrappedAg, true);
            await until(() => checks.length);
            await pastRetry();
            assert.deepStrictEqual([asked(tierBearers, 'r20-d-1'), wrappedAg.tierGates()], [1, []], 'switching it off and on again cancels the retry');
            peekHook = null;
            checks.forEach((go) => go());
            await read;
          } finally {
            peekHook = null;
          }
          inst.on['will-quit']();
        }

        // Round 21 Fix 2: A's lookup meets a transport error and its one retry goes out. Antigravity is switched off, its
        // bearer replaced (the same account) and Antigravity switched on again; the old retry fails while the check after
        // the switch-on is still out. Once switched off, a transport error, an HTTP error with no Retry-After and an empty
        // answer hold nothing: the replacement's lookup goes when the check lands. The API's own Retry-After still holds.
        for (const [tag, answer, kept] of [
          ['a', offline, false],
          ['b', () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '90' }) }), true],
          ['c', () => ({ ok: false, status: 503, headers: new Headers() }), false],
          ['d', () => ({ ok: true, json: async () => ({}) }), false],
        ]) {
          const inst = fresh();
          const h1 = holdOnce(`r21-${tag}-1`, offline, true);
          writeAg(`r21-${tag}@example.com`, `r21-${tag}-1`);
          await inst.readOne(wrappedAg, true);
          await until(() => h1.release);
          const h2 = holdOnce(`r21-${tag}-1`, answer, true);
          h1.release();
          await until(() => h2.release); // the retry is out
          const toggle = (on) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: on } }));
          await toggle(false);
          writeAg(`r21-${tag}@example.com`, `r21-${tag}-2`);
          const checks = [];
          peekHook = (orig) => new Promise((r) => checks.push(() => r(orig())));
          try {
            await toggle(true);
            const read = inst.readOne(wrappedAg, true);
            await until(() => checks.length);
            h2.release();
            await settle();
            assert.strictEqual(wrappedAg.tierGates().length, kept ? 1 : 0, kept ? "the old retry's Retry-After holds the account" : "the old retry's transport error holds nothing");
            peekHook = null;
            checks.forEach((go) => go());
            await read;
            await settle();
            assert.strictEqual(asked(tierBearers, `r21-${tag}-2`), kept ? 0 : 1, kept ? "the replacement's lookup waits out the Retry-After" : "the replacement's lookup goes at once");
          } finally {
            peekHook = null;
          }
          inst.on['will-quit']();
        }

        // Round 22 Fix 1: Disabling Antigravity while its first quota read is in flight clears `fetched` so re-enabling
        // with the same credentials fetches immediately instead of staying blank for 5 minutes, while still honoring any 429.
        for (const [tag, answer, expectCalls] of [
          ['ok', quotaAt(0.25), 2],
          ['429', quota429, 1],
        ]) {
          const inst = fresh();
          const h = holdOnce(`r22-q-${tag}`, answer, false);
          writeAg(`r22-q-${tag}@example.com`, `r22-q-${tag}`);
          const first = inst.readOne(wrappedAg, false);
          await until(() => h.release);
          const toggle = (on) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: on } }));
          await toggle(false);
          h.release();
          await first;
          assert.strictEqual(inst.last.get('antigravity'), undefined, 'disabled abandoned read did not publish');
          await toggle(true);
          await until(() => asked(sentBearers, `r22-q-${tag}`) === expectCalls && (tag === '429' ? inst.gate.get('antigravity') > Date.now() : inst.last.get('antigravity')?.rows?.[0]?.percent === 50));
          assert.strictEqual(asked(sentBearers, `r22-q-${tag}`), expectCalls, tag === '429' ? 'recorded 429 is still honored on re-enable' : 're-enable fetches quota immediately instead of waiting 5m');
          inst.on['will-quit']();
        }

        // Round 22 Fix 2: A pre-disable loadCodeAssist 401/auth-403 must NOT set a local 5-minute `tierRejected`
        // cooldown on the same bearer after re-enable, while any server-directed Retry-After is still retained.
        for (const [tag, status, headers, kept] of [
          ['401', 401, {}, false],
          ['403', 403, {}, false],
          ['401ra', 401, { 'retry-after': '90' }, true],
        ]) {
          const inst = fresh();
          const body = status === 403 ? JSON.stringify({ error: { status: 'UNAUTHENTICATED', details: [{ reason: 'ACCESS_TOKEN_EXPIRED' }] } }) : '';
          const h = holdOnce(`r22-t-${tag}`, () => ({ ok: false, status, headers: new Headers(headers), text: async () => body }), true);
          writeAg(`r22-t-${tag}@example.com`, `r22-t-${tag}`);
          await inst.readOne(wrappedAg, true);
          await until(() => h.release);
          const toggle = (on) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: on } }));
          await toggle(false);
          h.release();
          await settle();
          await toggle(true);
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, `r22-t-${tag}`), kept ? 1 : 2, kept ? 'server Retry-After on pre-disable 401 still holds' : 'pre-disable auth failure does not start a local 5m rejection cooldown');
          inst.on['will-quit']();
        }

        // Round 23 Fix 1: A failed first quota read (HTTP 503) for account A leaves `fetched` set and no rows.
        // Disabling Antigravity, switching to account B, and re-enabling must fetch B immediately (not wait 5m for A's
        // polling interval), while still honoring any active Retry-After recorded for B.
        for (const [tag, gateB] of [['fresh', false], ['gated', true]]) {
          const inst = fresh();
          const toggle = (on) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: on } }));
          if (gateB) {
            writeAg(`r23-b-${tag}@example.com`, `r23-b-${tag}-1`);
            const hb = holdOnce(`r23-b-${tag}-1`, quota429, false);
            const firstB = inst.readOne(wrappedAg, true);
            await until(() => hb.release);
            hb.release();
            await firstB;
            assert.ok(inst.gate.get('antigravity') > Date.now(), 'B has an active 429 cooldown');
            await toggle(false);
            writeAg(`r23-a-${tag}@example.com`, `r23-a-${tag}-1`);
            const ha0 = holdOnce(`r23-a-${tag}-1`, () => ({ ok: false, status: 503, headers: new Headers() }), false);
            await toggle(true);
            await until(() => ha0.release);
            ha0.release();
            await settle();
          } else {
            writeAg(`r23-a-${tag}@example.com`, `r23-a-${tag}-1`);
            const ha = holdOnce(`r23-a-${tag}-1`, () => ({ ok: false, status: 503, headers: new Headers() }), false);
            const firstA = inst.readOne(wrappedAg, false);
            await until(() => ha.release);
            ha.release();
            await firstA;
          }
          assert.strictEqual(inst.last.get('antigravity'), undefined, 'A 503 left no quota rows');
          await toggle(false);
          writeAg(`r23-b-${tag}@example.com`, `r23-b-${tag}-1`);
          await toggle(true);
          if (gateB) {
            await settle();
            assert.strictEqual(asked(sentBearers, `r23-b-${tag}-1`), 1, 'B still honors its own active Retry-After on re-enable');
            assert.ok(inst.gate.get('antigravity') > Date.now(), 'B cooldown stays armed');
          } else {
            await until(() => asked(sentBearers, `r23-b-${tag}-1`) === 1 && inst.last.get('antigravity')?.rows?.[0]?.percent === 50);
            assert.strictEqual(asked(sentBearers, `r23-b-${tag}-1`), 1, 'B fetches quota immediately instead of waiting out A\'s 5m interval');
          }
          inst.on['will-quit']();
        }

        // Round 23 Fix 2: A pre-sign-out loadCodeAssist request that settles after sign-out with a plain HTTP 403 or
        // 503 (no Retry-After) must NOT block the new session's tier lookup, while a server Retry-After still holds.
        for (const [tag, status, headers, kept] of [
          ['403', 403, {}, false],
          ['503', 503, {}, false],
          ['403ra', 403, { 'retry-after': '90' }, true],
        ]) {
          const inst = fresh();
          const h = holdOnce(`r23-t-${tag}-1`, () => ({ ok: false, status, headers: new Headers(headers), text: async () => '' }), true);
          writeAg(`r23-t-${tag}@example.com`, `r23-t-${tag}-1`);
          await inst.readOne(wrappedAg, true);
          await until(() => h.release);
          fs.rmSync(agMainAuth, { force: true });
          await inst.readOne(wrappedAg, true);
          assert.ok(inst.last.get('antigravity')?.signedOut, 'sign-out confirmed while loadCodeAssist was in flight');
          h.release();
          await settle();
          writeAg(`r23-t-${tag}@example.com`, `r23-t-${tag}-2`);
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, `r23-t-${tag}-2`), kept ? 0 : 1, kept ? 'server Retry-After from pre-sign-out 403 still holds' : 'pre-sign-out plain 403/503 does not block the fresh session tier lookup');
          inst.on['will-quit']();
        }

        // Round 24 Fix 1: a quota answer that isn't a 429 but names Retry-After: 600 (a 503, or a 403 that shows) holds
        // every request for the whole 600s: a refresh by hand straight after, and the polling past five minutes. A 503
        // keeps the rows on hand, or with none the section waits for its first; a 403's note shows, with no wait beside it.
        for (const [tag, status, rowsFirst] of [['503', 503, true], ['503-first', 503, false], ['403', 403, true]]) {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const bearer = `r24-q-${tag}`;
            writeAg(`${bearer}@example.com`, bearer);
            if (rowsFirst) {
              await inst.readOne(wrappedAg, true);
              clock += wrappedAg.everyMs;
            }
            quotaAnswer = () => ({ ok: false, status, headers: new Headers({ 'retry-after': '600' }), text: async () => '' });
            await inst.readOne(wrappedAg, false);
            const t0 = clock;
            const sent = asked(sentBearers, bearer);
            quotaAnswer = quotaAt(0.2);
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(asked(sentBearers, bearer), sent, `a refresh by hand waits out the ${status}'s Retry-After`);
            for (const at of [60_000, 5 * 60_000, 5 * 60_000 + 1000, 599_000]) {
              clock = t0 + at;
              await inst.readOne(wrappedAg, false);
            }
            assert.strictEqual(asked(sentBearers, bearer), sent, 'and so does polling, past five minutes');
            const s = shown(inst);
            assert.deepStrictEqual(
              [s.rows[0]?.percent, s.waitMs > 0, /access denied/i.test(s.error || ''), s.retryAfter],
              status === 403 ? [undefined, false, true, undefined] : [rowsFirst ? 50 : undefined, true, false, undefined],
              'the rows on hand stay (a 503) or its note shows (a 403), and the wait itself never goes out'
            );
            clock = t0 + 600_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).rows[0]?.percent, shown(inst).error, asked(sentBearers, bearer)], [80, undefined, sent + 1], 'the tick as the wait lifts reads');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 24 Fix 2: a lookup's failure that names no Retry-After (a plain 403 or 503, or a 200 with no plan) holds
        // back only the bearer that drew it, in memory: never its account's next bearer, nor a sign-in after a sign-out.
        // The API's own Retry-After still holds the account.
        const plain403 = () => ({ ok: false, status: 403, headers: new Headers(), text: async () => '' });
        const plain503 = () => ({ ok: false, status: 503, headers: new Headers() });
        const noPlan = () => ({ ok: true, json: async () => ({}) });
        const waits = [['403', plain403, false], ['503', plain503, false], ['empty', noPlan, false], ['503ra', () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '600' }) }), true]];
        // (a) A's lookup is out when the bearer rotates (the same account); B's read waits on it. A's answer lands, and B's
        // lookup goes at the next refresh.
        for (const [tag, answer, kept] of waits) {
          const inst = fresh();
          const ht = holdOnce(`r24-a-${tag}-1`, answer, true);
          writeAg(`r24-a-${tag}@example.com`, `r24-a-${tag}-1`);
          await inst.readOne(wrappedAg, true);
          await until(() => ht.release);
          writeAg(`r24-a-${tag}@example.com`, `r24-a-${tag}-2`);
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(asked(tierBearers, `r24-a-${tag}-2`), 0, "B's lookup waits on A's");
          ht.release();
          await settle();
          await inst.readOne(wrappedAg, true);
          await settle();
          assert.strictEqual(asked(tierBearers, `r24-a-${tag}-2`), kept ? 0 : 1, kept ? "A's Retry-After holds B" : `A's plain ${tag} answer does not hold B`);
          inst.on['will-quit']();
        }
        // (b) The answer lands before the sign-out, then the same account signs back in, with a new bearer or the same one.
        for (const [tag, answer, kept] of [...waits, ['403ra', () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => '' }), true]]) {
          for (const same of [false, true]) {
            const inst = fresh();
            const tag2 = `${tag}${same ? '-same' : ''}`;
            const first = `r24-b-${tag2}-1`;
            tierAnswer = (auth) => (auth === `Bearer ${first}` ? answer() : proTier());
            writeAg(`r24-b-${tag2}@example.com`, first);
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.strictEqual(asked(tierBearers, first), 1, 'the lookup was asked, and landed before the sign-out');
            fs.rmSync(agMainAuth, { force: true });
            await inst.readOne(wrappedAg, true);
            assert.ok(inst.last.get('antigravity')?.signedOut, 'signed out');
            tierAnswer = proTier;
            const next = same ? first : `r24-b-${tag2}-2`;
            writeAg(`r24-b-${tag2}@example.com`, next);
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.strictEqual(asked(tierBearers, next), (same ? 1 : 0) + (kept ? 0 : 1), kept ? 'the Retry-After from before the sign-out still holds' : `a plain ${tag} from before the sign-out does not hold the sign-in`);
            inst.on['will-quit']();
          }
        }
        tierAnswer = proTier;
        // (c) The same bearer, not rotated: its failure still keeps it off loadCodeAssist, a minute after a 503 and five
        // after a 403 or no plan, and the wait is never the account's (tierGates, saved to state.json).
        for (const [tag, answer] of waits.slice(0, 3)) {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const bearer = `r24-c-${tag}`;
            tierAnswer = (auth) => (auth === `Bearer ${bearer}` ? answer() : proTier());
            writeAg(`${bearer}@example.com`, bearer);
            await inst.readOne(wrappedAg, true);
            await settle();
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.deepStrictEqual([asked(tierBearers, bearer), wrappedAg.tierGates()], [1, []], `a plain ${tag} keeps the same bearer off loadCodeAssist, and holds nothing the account shares`);
            clock += 61_000;
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.strictEqual(asked(tierBearers, bearer), tag === '503' ? 2 : 1, tag === '503' ? 'a 503 holds it a minute' : `a ${tag} holds it longer`);
            clock += 4 * 60_000;
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.strictEqual(asked(tierBearers, bearer), tag === '503' ? 3 : 2, 'five minutes on, it asks again');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            tierAnswer = proTier;
          }
        }

        // Round 25 Fix 1 (quota): Retry-After: 0 is a delay of none, so a refresh by hand goes at once, and after a 429 so
        // does the next tick. A value that gives no delay (absent, junk, negative, Infinity, too long to be a number) holds
        // nothing, except that a 429 then waits its 60s fallback.
        for (const [tag, status, header, held] of [
          ['429-zero', 429, '0', 0],
          ['429-none', 429, null, 60_000],
          ['429-junk', 429, 'abc', 60_000],
          ['429-negative', 429, '-5', 60_000],
          ['429-past-date', 429, 'Wed, 21 Oct 2015 07:28:00 GMT', 0],
          ['503-zero', 503, '0', 0],
          ['503-inf', 503, 'Infinity', 0],
          ['503-huge', 503, '9'.repeat(400), 0],
        ]) {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const bearer = `r25-q-${tag}`;
            const failure = () => ({ ok: false, status, headers: new Headers(header === null ? {} : { 'retry-after': header }) });
            writeAg(`${bearer}@example.com`, bearer);
            quotaAnswer = failure;
            await inst.readOne(wrappedAg, true);
            quotaAnswer = quotaAt(0.2);
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(asked(sentBearers, bearer), held ? 1 : 2, held ? `${tag}: a refresh by hand waits out the 60s fallback` : `${tag}: a refresh by hand goes at once`);
            if (held) {
              clock += held - 1000;
              await inst.readOne(wrappedAg, false);
              assert.strictEqual(asked(sentBearers, bearer), 1, `${tag}: and so does polling`);
              clock += 1000;
              await inst.readOne(wrappedAg, false);
            }
            assert.deepStrictEqual([asked(sentBearers, bearer), shown(inst).rows[0]?.percent, shown(inst).waitMs], [2, 80, 0], `${tag}: read once the delay is over`);
            if (tag === '429-zero') {
              quotaAnswer = failure;
              await inst.readOne(wrappedAg, true);
              quotaAnswer = quotaAt(0.3);
              clock += 15_000;
              await inst.readOne(wrappedAg, false);
              assert.deepStrictEqual([asked(sentBearers, bearer), shown(inst).rows[0]?.percent], [4, 70], 'after a 429 with Retry-After: 0 the next tick reads, not one five minutes on');
            }
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 25 Fix 1 (loadCodeAssist): Retry-After: 0 holds neither the account nor the bearer, a 429's or a 503's,
        // unless the bearer itself was refused. One that gives no delay is no wait of the API's: a 503 holds the bearer its
        // minute, and a 429 the account its 60s fallback.
        for (const [tag, status, header, account, bearer] of [
          ['503-zero', 503, '0', 0, 0],
          ['429-zero', 429, '0', 0, 0],
          ['401-zero', 401, '0', 0, 5 * 60_000],
          ['503-inf', 503, 'Infinity', 0, 60_000],
          ['503-307-digits', 503, '9'.repeat(307), 0, 60_000],
          ['429-none', 429, null, 60_000, 0],
        ]) {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const b = `r25-t-${tag}`;
            let failed = false;
            tierAnswer = (auth) => (auth === `Bearer ${b}` && !failed ? ((failed = true), { ok: false, status, headers: new Headers(header === null ? {} : { 'retry-after': header }) }) : proTier());
            writeAg(`${b}@example.com`, b);
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.deepStrictEqual([asked(tierBearers, b), wrappedAg.tierGates().length], [1, account ? 1 : 0], `${tag}: ${account ? 'the account waits' : 'no wait for the account'}`);
            const wait = Math.max(account, bearer);
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.strictEqual(asked(tierBearers, b), wait ? 1 : 2, wait ? `${tag}: the next refresh's lookup waits` : `${tag}: the next refresh's lookup goes`);
            if (wait) {
              clock += wait;
              await inst.readOne(wrappedAg, true);
              await settle();
              assert.strictEqual(asked(tierBearers, b), 2, `${tag}: and goes once the wait is over`);
            }
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            tierAnswer = proTier;
          }
        }

        // Round 25 Fix 2: with Gemini 5h chosen, an ID-less Gemini 5h bucket at 5% beside Other 5h at 95% puts 5% on the
        // chip and the bubble (snapshot's ringPercent), as the panel lists it.
        {
          const inst = fresh();
          writeAg('r25-ring@example.com', 'r25-ring');
          await inst.ask('POST', '/api/settings', JSON.stringify({ choices: { antigravity: 'gemini-5h' } }));
          quotaAnswer = () => ({ ok: true, json: async () => ({ groups: [
            { displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.95 }] },
            { displayName: 'Other Models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.05 }] },
          ] }) });
          try {
            await inst.readOne(wrappedAg, true);
            const s = shown(inst);
            assert.deepStrictEqual([s.ringPercent, s.rows.map((r) => [r.label, r.percent, 'bucketId' in r])], [5, [['Gemini 5h', 5, false], ['Other 5h', 95, false]]], 'the chosen Gemini 5h shows 5%, not Other 5h\'s 95%');
          } finally {
            quotaAnswer = quotaAt(0.5);
          }
          inst.on['will-quit']();
        }

        // Round 25 Fix 4: signed out, the scheduled credential lookup fails five minutes on, and a valid credential is
        // installed. The lookup is tried again as its 60s retry wait ends, sign-in note and all, not five minutes later.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            fs.rmSync(agMainAuth, { force: true });
            await inst.readOne(wrappedAg, true);
            assert.ok(inst.last.get('antigravity')?.signedOut, 'signed out');
            clock += wrappedAg.everyMs;
            peekHook = () => ((peekHook = null), Promise.resolve({ status: 'error', error: 'Antigravity credential lookup timed out', soft: true }));
            await inst.readOne(wrappedAg, false);
            assert.ok(!peekHook, 'the scheduled lookup ran, and failed');
            const t0 = clock;
            writeAg('r25-c@example.com', 'r25-c-1');
            clock = t0 + 30_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([asked(sentBearers, 'r25-c-1'), !!inst.last.get('antigravity')?.signedOut], [0, true], 'not again inside its retry wait');
            clock = t0 + 60_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([asked(sentBearers, 'r25-c-1'), shown(inst).error, shown(inst).rows[0]?.percent], [1, undefined, 50], 'found as the retry wait ends');
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
          }
        }

        // Round 26 Fix 1 (quota): in New York at 12:00Z, a 503's asctime date two minutes on holds the account two minutes,
        // not five hours, and a 429's impossible 31 Nov waits its 60s fallback, not eleven days.
        for (const [tag, status, header, held] of [['asctime', 503, 'Fri Nov 20 12:02:00 2026', 120_000], ['31-nov', 429, 'Fri, 31 Nov 2026 12:01:00 GMT', 60_000]]) {
          let clock = Date.parse('2026-11-20T12:00:00Z');
          Date.now = () => clock;
          const tzWas = process.env.TZ;
          process.env.TZ = 'America/New_York';
          try {
            const inst = fresh();
            const bearer = `r26-date-${tag}`;
            writeAg(`${bearer}@example.com`, bearer);
            quotaAnswer = () => ({ ok: false, status, headers: new Headers({ 'retry-after': header }) });
            await inst.readOne(wrappedAg, true);
            quotaAnswer = quotaAt(0.2);
            clock += held - 1000;
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(asked(sentBearers, bearer), 1, `${tag}: held a second before the wait ends`);
            clock += 1000;
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([asked(sentBearers, bearer), shown(inst).rows[0]?.percent], [2, 80], `${tag}: read as it ends`);
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
            if (tzWas === undefined) delete process.env.TZ;
            else process.env.TZ = tzWas;
          }
        }

        // Round 26 Fix 2: the time a read acts on is taken once its credential check lands. (a) A 429's 60s wait, a refresh
        // by hand at 59s, its check landing at 61s: the quota request goes. (b) A first check that takes 9s: the request
        // went at 9s, so the next scheduled one waits until 309s, never 291s after it.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r26-a@example.com', 'r26-a');
            quotaAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '60' }) });
            await inst.readOne(wrappedAg, true);
            const t0 = clock;
            quotaAnswer = quotaAt(0.2);
            clock = t0 + 59_000;
            peekHook = (go) => ((peekHook = null), (clock = t0 + 61_000), go());
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([asked(sentBearers, 'r26-a'), shown(inst).rows[0]?.percent, shown(inst).waitMs], [2, 80, 0], 'a refresh whose check lands after the wait reads');
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r26-b@example.com', 'r26-b');
            const t0 = clock;
            peekHook = (go) => ((peekHook = null), (clock += 9_000), go());
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(asked(sentBearers, 'r26-b'), 1, 'the first scheduled read went');
            clock = t0 + wrappedAg.everyMs;
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(asked(sentBearers, 'r26-b'), 1, 'not 291s after the request went');
            clock = t0 + 9_000 + wrappedAg.everyMs;
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(asked(sentBearers, 'r26-b'), 2, 'five minutes after it went');
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
          }
        }

        // Round 26 Fix 3: a 401's sign-in note stays through a 503 with Retry-After on the next refresh by hand: only a 429
        // ends an earlier error.
        {
          const inst = fresh();
          writeAg('r26-c@example.com', 'r26-c');
          quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
          try {
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/, 'the 401 shows its sign-in note');
            quotaAnswer = () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '60' }) });
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([/Session expired/.test(shown(inst).error || ''), asked(sentBearers, 'r26-c')], [true, 2], 'the 503 leaves the sign-in note');
          } finally {
            quotaAnswer = quotaAt(0.5);
          }
          inst.on['will-quit']();
        }

        // Round 27 Fix 1: a stored expiry that is neither a date nor a number is none. An object whose toString is null
        // throws nothing, and null is no 1970 expiry: the credential reads unexpired, and quota is asked and shows.
        for (const [tag, expiry] of [['object', { toString: null }], ['null', null]]) {
          const inst = fresh();
          const bearer = `r27-e-${tag}`;
          writeAg(`${bearer}@example.com`, bearer, { expiry });
          const cred = await wrappedAg.peekCred();
          assert.deepStrictEqual([cred.status, cred.expired], ['ok', false], `${tag}: the credential reads, unexpired`);
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual([asked(sentBearers, bearer), shown(inst).rows[0]?.percent, shown(inst).error], [1, 50, undefined], `${tag}: quota is asked and shows`);
          inst.on['will-quit']();
        }

        // Round 27 Fix 2 (quota): a 403 whose headers name Retry-After: 600 holds the account as they land, while its body
        // is still open: a refresh by hand under the account's rotated bearer sends nothing. The wait is recorded once.
        {
          const inst = fresh();
          let releaseBody = null;
          quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: () => new Promise((r) => (releaseBody = r)) });
          try {
            writeAg('r27-q@example.com', 'r27-q-1');
            const first = inst.readOne(wrappedAg, true);
            await until(() => releaseBody);
            quotaAnswer = quotaAt(0.2);
            writeAg('r27-q@example.com', 'r27-q-2');
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(asked(sentBearers, 'r27-q-2'), 0, "the rotated bearer's refresh waits while the 403's body is open");
            releaseBody('');
            await first;
            await inst.readOne(wrappedAg, true);
            inst.flushState();
            assert.deepStrictEqual([asked(sentBearers, 'r27-q-2'), JSON.parse(fs.readFileSync(statePathR15, 'utf8')).accountGates?.antigravity?.length], [0, 1], 'and once it lands, under one record');
          } finally {
            quotaAnswer = quotaAt(0.5);
          }
          inst.on['will-quit']();
        }
        // Round 27 Fix 2 (loadCodeAssist): the same for a lookup's 403. Its wait is the account's as the headers land, so a
        // sign-out and a sign-in under a new bearer while the body is open sends no lookup, and it is recorded once.
        {
          const inst = fresh();
          let releaseBody = null;
          tierAnswer = (auth) => (auth === 'Bearer r27-t-1' ? { ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: () => new Promise((r) => (releaseBody = r)) } : proTier());
          try {
            writeAg('r27-t@example.com', 'r27-t-1');
            await inst.readOne(wrappedAg, true);
            await until(() => releaseBody);
            assert.strictEqual(wrappedAg.tierGates().length, 1, 'the wait is recorded while the body is open');
            fs.rmSync(agMainAuth, { force: true });
            await inst.readOne(wrappedAg, true);
            assert.ok(shown(inst).signedOut || /sign in/i.test(shown(inst).error || ''), 'signed out meanwhile');
            writeAg('r27-t@example.com', 'r27-t-2');
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.strictEqual(asked(tierBearers, 'r27-t-2'), 0, "the new bearer's lookup waits out the 403's Retry-After");
            releaseBody('');
            await settle();
            assert.strictEqual(wrappedAg.tierGates().length, 1, 'and once it lands, under one record');
          } finally {
            tierAnswer = proTier;
          }
          inst.on['will-quit']();
        }

        // Round 27 Fix 3: at 2026-11-20 12:00Z, a 429's "Sunday, 21-Nov-76 12:00:00 GMT" is 1976 (2076's is 50 years and a
        // day ahead), a date gone: no wait, so a refresh by hand goes at once.
        {
          let clock = Date.parse('2026-11-20T12:00:00Z');
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r27-d@example.com', 'r27-d');
            quotaAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': 'Sunday, 21-Nov-76 12:00:00 GMT' }) });
            await inst.readOne(wrappedAg, true);
            quotaAnswer = quotaAt(0.2);
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([asked(sentBearers, 'r27-d'), shown(inst).rows[0]?.percent, shown(inst).waitMs], [2, 80, 0], 'a refresh by hand reads at once');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 27 Fix 4: two buckets share bucketId "shared", a 5h at 90% and a weekly at 10%. The answer then holds only the
        // 5h, unchanged, then only the weekly, unchanged: nothing beeps and no reset shows. No screen gets a row's window.
        {
          const inst = fresh();
          const answer = (...buckets) => () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets }] }) });
          const fiveH = { bucketId: 'shared', window: '5h', remainingFraction: 0.1 };
          const weekly = { bucketId: 'shared', window: 'weekly', remainingFraction: 0.9 };
          try {
            writeAg('r27-w@example.com', 'r27-w');
            const beepsWere = beeps.length;
            for (const a of [answer(fiveH, weekly), answer(fiveH), answer(weekly)]) {
              quotaAnswer = a;
              await inst.readOne(wrappedAg, true);
            }
            const notices = inst.sent.filter(([ch, v]) => ch === 'reset' && v);
            assert.deepStrictEqual([asked(sentBearers, 'r27-w'), beeps.length - beepsWere, notices.length], [3, 0, 0], 'no beep and no reset notice');
            const internal = (r) => ['win', 'key', 'bucketId', 'ambiguous'].filter((k) => k in r);
            assert.deepStrictEqual([shown(inst).rows.map((r) => r.percent), shown(inst).rows.flatMap(internal)], [[10], []], 'the weekly row shows, without the fields only main compares by');
            quotaAnswer = answer({ ...weekly, remainingFraction: 0.95 });
            await inst.readOne(wrappedAg, true);
            const notice = inst.sent.filter(([ch, v]) => ch === 'reset' && v).at(-1)?.[1];
            assert.deepStrictEqual(notice?.rows.map((r) => [r.percent, ...internal(r)]), [[5]], 'a real drop on the weekly bucket resets, and its notice carries none of them either');
          } finally {
            quotaAnswer = quotaAt(0.5);
          }
          inst.on['will-quit']();
        }

        // Round 28 Fix 1: different groups sharing one bucketId and 5h window taking turns alone must neither beep nor
        // show a reset notice.
        {
          const inst = fresh();
          const gem = { displayName: 'Gemini', buckets: [{ bucketId: 'shared', window: '5h', remainingFraction: 0.1 }] };
          const oth = { displayName: 'Other', buckets: [{ bucketId: 'shared', window: '5h', remainingFraction: 0.9 }] };
          const answer = (...groups) => () => ({ ok: true, json: async () => ({ groups }) });
          try {
            writeAg('r28-g@example.com', 'r28-g');
            const beepsWere = beeps.length;
            for (const a of [answer(gem, oth), answer(gem), answer(oth)]) {
              quotaAnswer = a;
              await inst.readOne(wrappedAg, true);
            }
            const notices = inst.sent.filter(([ch, v]) => ch === 'reset' && v);
            assert.deepStrictEqual([asked(sentBearers, 'r28-g'), beeps.length - beepsWere, notices.length], [3, 0, 0], 'different groups taking turns under one bucketId + 5h window trigger no beep or reset notice');
          } finally {
            quotaAnswer = quotaAt(0.5);
          }
          inst.on['will-quit']();
        }

        // Round 28 Fix 2: a bearer whose stored expiry equals Date.now() is already expired: neither quota nor tier
        // requests go out, and the overlay reports session expired instead of publishing quota.
        {
          const exactNow = Date.parse('2026-11-20T12:00:00.000Z');
          Date.now = () => exactNow;
          try {
            const inst = fresh();
            writeAg('r28-exp@example.com', 'r28-exp', { expiry: new Date(exactNow).toISOString() });
            await inst.readOne(wrappedAg, true);
            await settle();
            assert.deepStrictEqual([asked(sentBearers, 'r28-exp'), asked(tierBearers, 'r28-exp')], [0, 0], 'neither quota nor tier sends a bearer at its exact expiry millisecond');
            assert.match(shown(inst).error || '', /Session expired/i, 'overlay reports session expired at the exact expiry deadline');
            // Direct readAntigravity with preCred also refuses at the exact expiry boundary.
            const direct = await providersMod.PROVIDERS.find((p) => p.id === 'antigravity').read({
              status: 'ok',
              account: 'r28-exp@example.com',
              gateKey: 'r28-exp@example.com',
              gateKeys: ['r28-exp@example.com'],
              tokenHash: 'h-r28-exp',
              accessToken: 'r28-exp-direct',
              expiry: exactNow,
              expired: true,
            });
            assert.strictEqual(direct.authError, true, 'readAntigravity refuses a bearer at expiry === Date.now()');
            assert.deepStrictEqual([asked(sentBearers, 'r28-exp-direct'), asked(tierBearers, 'r28-exp-direct')], [0, 0], 'direct read sends no requests at expiry === Date.now()');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
          }
        }

        // Round 29 Fix 3: a quota HTTP 503 with Retry-After: 0 must clear the 5-minute polling floor so the very next
        // 15-second scheduled tick fetches quota immediately rather than waiting five minutes.
        {
          let clock = Date.parse('2026-11-20T12:00:00.000Z');
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r29-503z@example.com', 'r29-503z');
            quotaAnswer = () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '0' }) });
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(asked(sentBearers, 'r29-503z'), 1, 'first quota request hit 503 Retry-After: 0');
            assert.strictEqual(shown(inst).waitMs, 0, 'Retry-After: 0 shows no wait');
            quotaAnswer = quotaAt(0.3);
            clock += 15_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([asked(sentBearers, 'r29-503z'), shown(inst).rows[0]?.percent], [2, 70], 'next 15s tick fetches quota immediately instead of waiting 5m');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 30 Fix 2: disabling Antigravity, rolling back to the previous 6-provider build and toggling another
        // provider (which rewrites `enabled` and `known` to 6 IDs), then reinstalling the upgraded build must NOT
        // silently re-enable Antigravity, while a first-time upgrade from the old build still starts it on.
        {
          const inst1 = fresh();
          await inst1.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: false } }));
          inst1.flushState();
          inst1.on['will-quit']();
          const saved = JSON.parse(fs.readFileSync(statePathR15, 'utf8'));
          assert.ok(saved.disabled?.includes('antigravity'), 'disabling Antigravity records it in disabled');
          // Simulate the previous 6-provider build toggling `ram` off: merges enabled + 6-provider known into state.json.
          const oldKnown = ['claude', 'codex', 'opencode-go', 'xai', 'cpu', 'ram'];
          const afterRollback = { ...saved, enabled: ['claude', 'codex', 'opencode-go', 'xai', 'cpu'], known: oldKnown };
          fs.writeFileSync(statePathR15, JSON.stringify(afterRollback));
          const inst2 = loadInstance();
          inst2.loadState();
          const ids2 = inst2.snapshot().map((p) => p.id);
          assert.ok(!ids2.includes('antigravity'), 'reinstalling after rollback keeps Antigravity disabled');
          assert.ok(!ids2.includes('ram'), 'provider disabled in the older build also stays disabled');
          inst2.on['will-quit']();
          // Re-enabling a previously-disabled provider in the older build still enables it on upgrade.
          fs.writeFileSync(statePathR15, JSON.stringify({ ...afterRollback, enabled: [...afterRollback.enabled, 'ram'], disabled: ['antigravity', 'ram'] }));
          const inst3 = loadInstance();
          inst3.loadState();
          const ids3 = inst3.snapshot().map((p) => p.id);
          assert.ok(!ids3.includes('antigravity') && ids3.includes('ram'), 'provider re-enabled in the older build turns back on while Antigravity stays off');
          inst3.on['will-quit']();
          // First-time upgrade from the older 6-provider build (no `disabled` field) still starts Antigravity on.
          fs.writeFileSync(statePathR15, JSON.stringify({ enabled: oldKnown, known: oldKnown }));
          const inst4 = loadInstance();
          inst4.loadState();
          assert.ok(inst4.snapshot().some((p) => p.id === 'antigravity'), 'first-time upgrade from the older build starts Antigravity enabled');
          inst4.on['will-quit']();
          // Round 31 Fix 4: rolling back from a newer build with an unknown provider ("future") in enabled + known,
          // toggling RAM in this build, and saving must preserve "future" in BOTH enabled and known (and not disabled).
          const allKnown = ['claude', 'codex', 'opencode-go', 'xai', 'antigravity', 'cpu', 'ram', 'future'];
          fs.writeFileSync(statePathR15, JSON.stringify({ enabled: allKnown, known: allKnown }));
          const inst5 = loadInstance();
          inst5.loadState();
          await inst5.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'ram', enabled: false } }));
          inst5.flushState();
          inst5.on['will-quit']();
          const afterFuture = JSON.parse(fs.readFileSync(statePathR15, 'utf8'));
          assert.ok(afterFuture.enabled.includes('future') && afterFuture.known.includes('future') && !afterFuture.disabled?.includes('future'), 'toggling RAM preserves unknown newer-build provider in enabled and known');
          assert.ok(!afterFuture.enabled.includes('ram') && afterFuture.disabled?.includes('ram'), 'RAM itself is recorded disabled');
        }

        // Round 31 Fix 3 (main.js): after a valid 95% reading, an HTTP 200 `{ groups: [{ buckets: [[]] }] }` response
        // must NOT overwrite the saved cache or display a 0% "Usage" row.
        {
          const inst = fresh();
          writeAg('r31-arr@example.com', 'r31-arr');
          quotaAnswer = quotaAt(0.05);
          await inst.readOne(wrappedAg, true);
          inst.flushState();
          assert.strictEqual(shown(inst).rows[0]?.percent, 95, 'initial 95% reading published');
          quotaAnswer = () => ({ ok: true, json: async () => ({ groups: [{ buckets: [[]] }] }) });
          await inst.readOne(wrappedAg, true);
          inst.flushState();
          const savedCache = JSON.parse(fs.readFileSync(statePathR15, 'utf8')).cache?.antigravity;
          assert.strictEqual(savedCache?.rows?.[0]?.percent, 95, 'saved cache keeps 95% instead of being overwritten with 0% Usage');
          assert.strictEqual(shown(inst).rows.length, 0, 'malformed array bucket produces no 0% Usage row');
          assert.strictEqual(shown(inst).error, 'No usage windows reported.', 'malformed array bucket surfaces no-windows error instead of 0%');
          quotaAnswer = quotaAt(0.5);
          inst.on['will-quit']();
        }

        // Round 32: what the desktop was last sent, and what a phone on /api/events last heard.
        const desk = (inst) => inst.sent.filter(([ch]) => ch === 'data').map(([, d]) => d.find((p) => p.id === 'antigravity')).pop();
        const phoneSees = (inst) => {
          const got = [];
          let close;
          inst.handler({ method: 'GET', url: '/api/events', headers: { host: 'localhost' }, on: (_, fn) => (close = fn) }, { writeHead() { return this; }, write(c) { got.push(c); }, end() {} });
          return { raw: () => got[got.length - 1], last: () => JSON.parse(got[got.length - 1].slice(6)).providers.find((p) => p.id === 'antigravity'), close: () => close() };
        };
        const refused600 = () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) });

        // Round 32 Fix 1: an 85% reading, then a 401 with Retry-After 600. A refresh with the same refused bearer keeps the
        // sign-in note; a valid replacement for the same account brings back the 85% under the wait, asks nothing, and both
        // screens get it. The refused bearer's hash never reaches a screen.
        {
          const inst = fresh();
          const phone = phoneSees(inst);
          writeAg('r32-rot@example.com', 'r32-rot-1');
          quotaAnswer = quotaAt(0.15);
          await inst.readOne(wrappedAg, true);
          assert.strictEqual(shown(inst).rows[0]?.percent, 85, 'the 85% reading');
          quotaAnswer = refused600;
          await inst.readOne(wrappedAg, true);
          const until = inst.gate.get('antigravity');
          assert.ok(until > Date.now() + 590_000, 'the 401 holds it 600s');
          const hash = inst.last.get('antigravity')?.tokenHash;
          assert.ok(hash, 'the note names the refused bearer, for main');
          assert.deepStrictEqual([/Session expired/.test(shown(inst).error || ''), shown(inst).rows.length, shown(inst).tokenHash], [true, 0, undefined], 'the sign-in note shows, without the hash');
          assert.ok(!JSON.stringify(desk(inst)).includes(hash) && !phone.raw().includes(hash), 'neither screen gets the hash');
          await inst.readOne(wrappedAg, true);
          assert.deepStrictEqual([/Session expired/.test(shown(inst).error || ''), asked(sentBearers, 'r32-rot-1')], [true, 2], 'the same refused bearer keeps the note, and asks nothing more');
          writeAg('r32-rot@example.com', 'r32-rot-2');
          quotaAnswer = quotaAt(0.5);
          await inst.readOne(wrappedAg, true);
          for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
            assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0, s.tokenHash], [undefined, 85, true, undefined], `${where}: the replacement brings back 85% under the wait`);
          }
          assert.deepStrictEqual([asked(sentBearers, 'r32-rot-2'), inst.gate.get('antigravity')], [0, until], 'and asks nothing while the 600s holds');
          phone.close();
          inst.on['will-quit']();
        }

        // Round 32 Fix 1 (nothing on hand): the 401 comes before any reading. The scheduled look 60s on finds the
        // replacement: the note goes and the section waits out the 600s, then reads.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r32-nc@example.com', 'r32-nc-1');
            quotaAnswer = refused600;
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([/Session expired/.test(shown(inst).error || ''), inst.savedCache().antigravity], [true, undefined], 'the sign-in note, with no reading on hand');
            writeAg('r32-nc@example.com', 'r32-nc-2');
            quotaAnswer = quotaAt(0.5);
            clock += 30_000;
            await inst.readOne(wrappedAg, false);
            assert.match(shown(inst).error || '', /Session expired/, 'not looked at again inside the 60s');
            clock += 31_000;
            await inst.readOne(wrappedAg, false);
            const s = shown(inst);
            assert.deepStrictEqual([s.error, s.rows.length, s.waitMs > 0, asked(sentBearers, 'r32-nc-2')], [undefined, 0, true, 0], 'the look at 60s drops the note and waits');
            clock += 600_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).rows[0]?.percent, asked(sentBearers, 'r32-nc-2')], [50, 1], 'and reads as the wait lifts');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 32 Fix 2: nothing on hand and a credential helper that fails at every look. The first failure stays quiet
        // (a hiccup); the retry 60s on fails too, and both screens say why instead of waiting forever. The looks keep their
        // 60s cadence, the first that answers reads and clears the error, and a reading on screen outlasts failures.
        // The helper's own message (here a PowerShell command line) never reaches a screen: one fixed line does.
        const lookupBroken = () => Promise.resolve({ status: 'error', error: 'Command failed: powershell.exe -NoProfile -Command [Console]::OutputEncoding...', soft: true });
        const failing = 'Antigravity credential lookup failing — retrying every minute.';
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r32-ce@example.com', 'r32-ce-1');
            peekHook = lookupBroken;
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([shown(inst).error, shown(inst).rows.length], [undefined, 0], 'one failed look stays quiet');
            const peeks = peekCalls;
            clock += 30_000;
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(peekCalls, peeks, 'not again inside its retry wait');
            clock += 30_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows.length, s.waitMs], [failing, 0, 0], `${where}: the second failure says why`);
            }
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([peekCalls, shown(inst).error], [peeks + 2, failing], 'still looked at every 60s');
            peekHook = null;
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 50], `${where}: the first look that answers reads, and the error goes`);
            }
            peekHook = lookupBroken;
            const peeks2 = peekCalls;
            await inst.readOne(wrappedAg, true);
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([peekCalls - peeks2, shown(inst).error, shown(inst).rows[0]?.percent], [2, undefined, 50], 'a verified reading stays through two failed looks');
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
          }
        }

        // Round 32 Fix 2 (in a row): a look that answers between two failures ends the count, though its read fails too
        // and leaves nothing on screen: the failure after it is a first again, and quiet.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r32-cr@example.com', 'r32-cr-1');
            peekHook = lookupBroken;
            await inst.readOne(wrappedAg, true);
            peekHook = null;
            quotaAnswer = () => ({ ok: false, status: 503, headers: new Headers() });
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).error, shown(inst).rows.length, asked(sentBearers, 'r32-cr-1') > 0], [undefined, 0, true], 'the look answered, and its read failed quietly');
            peekHook = lookupBroken;
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst).error, undefined, 'the next failure is a first again');
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 32 Fix 2 (startup cache): the saved reading waits for its account to be confirmed. Two failed looks show
        // the error, never the saved rows or plan, and leave the saved cache alone; the first look that answers shows it.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const first = fresh();
            writeAg('r32-cu@example.com', 'r32-cu-1');
            quotaAnswer = quotaAt(0.3);
            await first.readOne(wrappedAg, true);
            first.flushState();
            first.on['will-quit']();
            const inst = loadInstance();
            inst.loadState();
            const phone = phoneSees(inst);
            peekHook = lookupBroken;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).rows.length, shown(inst).error, shown(inst).plan], [0, undefined, undefined], 'one failed look: hidden and quiet');
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows.length, s.plan, s.ringPercent], [failing, 0, undefined, 0], `${where}: two failed looks say why, and show nothing saved`);
            }
            assert.strictEqual(inst.savedCache().antigravity?.rows[0]?.percent, 70, 'the saved reading is kept');
            peekHook = null;
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, phone.last().rows[0]?.percent], [undefined, 70, 70], 'the first look that answers shows it on both screens');
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 33 Fix 1: restarting during a 401 Retry-After cooldown with the SAME rejected token keeps showing
        // "Session expired" on both desktop and phone instead of releasing the cached 85%; installing a replacement
        // token then brings back 85% while still honoring the cooldown.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst1 = fresh();
            writeAg('r33-401@example.com', 'r33-401-1');
            quotaAnswer = quotaAt(0.15);
            await inst1.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst1).rows[0]?.percent, 85, 'initial 85% cached');
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) });
            await inst1.readOne(wrappedAg, true);
            assert.match(shown(inst1).error || '', /Session expired/i, '401 shows sign-in note');
            inst1.flushState();
            inst1.on['will-quit']();
            // Restart without changing the rejected credential:
            const inst2 = loadInstance();
            inst2.loadState();
            const phone = phoneSees(inst2);
            await inst2.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst2)], ['desktop', desk(inst2)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length, `${where}: restart during 401 cooldown keeps sign-in note for the same rejected token`);
            }
            assert.strictEqual(asked(sentBearers, 'r33-401-1'), 2, 'cooldown still prevents a new quota request');
            // Rotate to a valid replacement token: 85% returns while cooldown still holds.
            writeAg('r33-401@example.com', 'r33-401-2');
            await inst2.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst2)], ['desktop', desk(inst2)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: replacement token restores cached 85% while honoring cooldown`);
            }
            assert.strictEqual(asked(sentBearers, 'r33-401-2'), 0, 'replacement token still respects the 600s cooldown');
            phone.close();
            inst2.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 33 Fix 2: when lookup recovers after two failures with no cache, desktop IPC and phone SSE clear
        // "credential lookup failing" immediately while the quota request is still in flight.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r33-rec@example.com', 'r33-rec-1');
            peekHook = lookupBroken;
            await inst.readOne(wrappedAg, false);
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([desk(inst).error, phone.last().error], [failing, failing], 'both screens show lookup failing after two failures');
            peekHook = null;
            const h = holdOnce('r33-rec-1', quotaAt(0.25));
            clock += 60_000;
            const pending = inst.readOne(wrappedAg, false);
            await until(() => h.release);
            // Quota request is still held open: both desktop and phone must ALREADY have cleared the lookup error!
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.strictEqual(s.error, undefined, `${where}: lookup error clears immediately on recovery while quota is in flight`);
            }
            h.release();
            await pending;
            assert.deepStrictEqual([desk(inst).rows[0]?.percent, phone.last().rows[0]?.percent], [75, 75], 'quota then lands on both screens');
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 33 Fix 4 (main.js): re-enabling a disabled bucket triggers no beep or reset notice, and `disabled` is stripped.
        {
          const inst = fresh();
          writeAg('r33-dis@example.com', 'r33-dis-1');
          const mkResp = (disabled) => () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-11-20T05:00:00Z', disabled },
          ] }] }) });
          try {
            const beepsWere = beeps.length;
            quotaAnswer = mkResp(true);
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([shown(inst).rows[0]?.percent, 'disabled' in shown(inst).rows[0]], [100, false], 'disabled bucket shows 100% without exposing internal disabled flag');
            quotaAnswer = mkResp(false);
            await inst.readOne(wrappedAg, true);
            const notices = inst.sent.filter(([ch, v]) => ch === 'reset' && v);
            assert.deepStrictEqual([shown(inst).rows[0]?.percent, beeps.length - beepsWere, notices.length], [30, 0, 0], 're-enabling bucket shows 30% with zero beeps and zero reset notices');
          } finally {
            quotaAnswer = quotaAt(0.5);
          }
          inst.on['will-quit']();
        }

        // Round 34 Fix 1: after a 429 clears a previous 401 sign-in note, the 60s credential check must NOT resurrect
        // the old sign-in note from authRejected and hide the remaining wait on desktop and phone.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r34-429@example.com', 'r34-429-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, '401 shows sign-in note');
            quotaAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
            await inst.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: 429 clears sign-in note, restores cached 85%, and shows 120s wait`);
            }
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: 60s credential check keeps cached 85% and remaining wait instead of resurrecting 401 note`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 35 Fix 1: after HTTP 401 followed by HTTP 403 PERMISSION_DENIED with Retry-After: 120 on the same
        // credential, the 60s credential check must keep showing "Antigravity access denied" rather than reverting to
        // "Session expired" from stale authRejected.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r35-403@example.com', 'r35-403-1');
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, '401 shows sign-in note');
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '120' }), text: async () => permBody });
            await inst.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.match(s.error || '', /Antigravity access denied/i, `${where}: 403 PERMISSION_DENIED replaces sign-in note`);
            }
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.match(s.error || '', /Antigravity access denied/i, `${where}: 60s credential check keeps access denied instead of reverting to Session expired`);
            }
            assert.strictEqual(asked(sentBearers, 'r35-403-1'), 2, 'no extra quota request sent during 120s cooldown');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 36 Fix 1: for Claude (non-peekCred), switching from account A (85%) to account B returning 401 then
        // 429 must NOT restore account A's cached 85% rows under account B.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const claude = { id: 'claude', name: 'Claude', everyMs: 5 * 60_000, read: async () => ({ rows: [{ label: 'Session', percent: 85 }], renewsFor: 'claude-a', updatedAt: clock }) };
            await inst.readOne(claude, true);
            assert.strictEqual(inst.snapshot().find((p) => p.id === 'claude')?.rows?.[0]?.percent, 85, 'Claude account A 85% cached');
            claude.read = async () => ({ error: 'Session expired', renewsFor: 'claude-b' });
            await inst.readOne(claude, true);
            claude.read = async () => ({ error: 'Rate limited', soft: true, retryAfter: 120, renewsFor: 'claude-b' });
            await inst.readOne(claude, true);
            const snapC = inst.snapshot().find((p) => p.id === 'claude');
            const deskC = inst.sent.filter(([ch]) => ch === 'data').at(-1)?.[1]?.find((p) => p.id === 'claude');
            const phoneC = phone.last();
            // Verify Claude shows empty rows + wait (NOT account A's 85%).
            assert.deepStrictEqual([snapC.rows.length, snapC.error, snapC.waitMs > 0], [0, undefined, true], 'snapshot: Claude B 429 does not expose account A cached 85%');
            assert.deepStrictEqual([deskC.rows.length, deskC.error, deskC.waitMs > 0], [0, undefined, true], 'desktop: Claude B 429 does not expose account A cached 85%');
            assert.ok(phoneC, 'phone stream active');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
          }
        }

        // Round 37 Fix 1: if loadCodeAssist hits a transport error while quota is open, and during the 250ms retry
        // pause the SAME credential's expiry is updated to the past and verified by a forced refresh, the app reports
        // Session expired and cancels the loadCodeAssist retry (no second request sent).
        {
          const inst = fresh();
          const hq = holdOnce('r37-exp-1', quotaAt(0.5));
          const ht = holdOnce('r37-exp-1', offline, true);
          writeAg('r37-exp@example.com', 'r37-exp-1');
          const first = inst.readOne(wrappedAg, true);
          await until(() => hq.release && ht.release);
          ht.release();
          await settle(); // loadCodeAssist is now in its 250ms retry pause
          writeAg('r37-exp@example.com', 'r37-exp-1', { expiry: new Date(Date.now() - 60_000).toISOString() });
          await inst.readOne(wrappedAg, true);
          assert.match(shown(inst).error || '', /Session expired/i, 'app confirms credential expired during retry pause');
          await pastRetry();
          assert.strictEqual(asked(tierBearers, 'r37-exp-1'), 1, 'loadCodeAssist retry is cancelled after newer check confirms expiry');
          hq.release();
          await first;
          inst.on['will-quit']();
        }

        // Round 38 Fix 1: if loadCodeAssist fails with a transport error and quota returns HTTP 401 for the same
        // unexpired bearer during the 250ms retry pause, the app shows Session expired and cancels the tier retry.
        {
          const inst = fresh();
          const hq = holdOnce('r38-q401-1', () => ({ ok: false, status: 401, headers: new Headers() }));
          const ht = holdOnce('r38-q401-1', offline, true);
          writeAg('r38-q401@example.com', 'r38-q401-1');
          const first = inst.readOne(wrappedAg, true);
          await until(() => hq.release && ht.release);
          ht.release();
          await settle(); // loadCodeAssist is in its 250ms retry pause
          hq.release();
          await first;
          assert.match(shown(inst).error || '', /Session expired/i, 'quota 401 shows Session expired');
          await pastRetry();
          assert.strictEqual(asked(tierBearers, 'r38-q401-1'), 1, 'loadCodeAssist retry is cancelled after quota confirmed 401 rejection');
          inst.on['will-quit']();
        }

        // Round 38 Fix 2: switching A (401 + Retry-After: 600) -> B -> A (same rejected bearer) before the cooldown
        // lifts must keep showing "Session expired" on desktop and phone instead of "Waiting for usage data".
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r38-a@example.com', 'r38-a-1');
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, 'account A shows Session expired under 600s cooldown');
            // Switch to account B:
            writeAg('r38-b@example.com', 'r38-b-1');
            quotaAnswer = quotaAt(0.4);
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst).rows[0]?.percent, 60, 'account B loads 60% normally');
            // Switch back to account A with the same rejected bearer before 600s:
            clock += 60_000;
            writeAg('r38-a@example.com', 'r38-a-1');
            await inst.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length, `${where}: switching back to A keeps Session expired during its 401 cooldown`);
            }
            assert.strictEqual(asked(sentBearers, 'r38-a-1'), 1, 'account A still sends no quota request while 600s cooldown holds');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 39 Fix: a late quota 401 with Retry-After: 600 must save the bearer rejection on arrival BEFORE the
        // post-fetch check, so both (a) switching A -> B while A is pending, letting A return 401+600s, and switching
        // back to A, AND (b) a transient post-fetch credential check failure after A returns 401+600s keep showing
        // "Session expired" during the cooldown instead of waiting or keeping cached usage.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            // (a) Late 401 after switching away to B, then switching back to A:
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r39-a@example.com', 'r39-a-1');
            const ha = holdOnce('r39-a-1', () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) }));
            const reqA = inst.readOne(wrappedAg, true);
            await until(() => ha.release);
            writeAg('r39-b@example.com', 'r39-b-1');
            quotaAnswer = quotaAt(0.35);
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst).rows[0]?.percent, 65, 'account B loads 65%');
            ha.release();
            await reqA;
            // Switch back to A with the same rejected bearer before 600s:
            clock += 60_000;
            writeAg('r39-a@example.com', 'r39-a-1');
            await inst.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length, `${where}: late 401 rejection survives A -> B -> A during 600s cooldown`);
            }
            assert.strictEqual(asked(sentBearers, 'r39-a-1'), 1, 'no extra quota request sent for A during 600s cooldown');
            phone.close();
            inst.on['will-quit']();

            // (b) Transient post-fetch credential check failure after A returns 401+600s:
            const inst2 = fresh();
            const phone2 = phoneSees(inst2);
            writeAg('r39-pf@example.com', 'r39-pf-1');
            quotaAnswer = quotaAt(0.15);
            await inst2.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst2).rows[0]?.percent, 85, 'initial 85% cached');
            const hp = holdOnce('r39-pf-1', () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) }));
            const reqPf = inst2.readOne(wrappedAg, true);
            await until(() => hp.release);
            peekHook = lookupBroken;
            hp.release();
            await reqPf;
            peekHook = null;
            // Round 40 Fix 1: at once, before any later check, the refused bearer's 85% is gone from every screen.
            for (const [where, s] of [['snapshot', shown(inst2)], ['desktop', desk(inst2)], ['phone', phone2.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length, `${where}: a 401 whose post-fetch check fails shows Session expired at once, not the refused 85%`);
            }
            clock += 60_000;
            await inst2.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst2)], ['desktop', desk(inst2)], ['phone', phone2.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length, `${where}: after transient post-fetch error, next check shows Session expired instead of cached 85%`);
            }
            assert.strictEqual(asked(sentBearers, 'r39-pf-1'), 2, 'no extra quota request sent during 600s cooldown');
            phone2.close();
            inst2.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 34 Fix 2: if a replacement bearer is installed while a forced refresh is in flight and the old
        // bearer's request returns 401 with a 600s wait, the post-fetch check must immediately restore the cached 85%
        // on desktop and phone instead of leaving "Session expired" up until the next credential check.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r34-rot@example.com', 'r34-rot-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, 'initial 401 shows sign-in note');
            const h = holdOnce('r34-rot-1', () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            writeAg('r34-rot@example.com', 'r34-rot-2');
            h.release();
            await req;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: replacement verified during 401+Retry-After immediately restores cached 85% and wait`);
            }
            assert.strictEqual(asked(sentBearers, 'r34-rot-2'), 0, 'replacement still respects the 600s cooldown');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 40 Fix 2: A's first request is out when the account switches to B and back to A (the same bearer), and A's
        // second request goes out. The first one's 403 headers land with Retry-After 600 and its UNAUTHENTICATED body is
        // held; the second publishes 75%, then that body lands. The older refusal says nothing after the newer success: the
        // next check keeps 75% on both screens, and loadCodeAssist's retry for the bearer still goes.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            let body1 = null;
            const unauth = JSON.stringify({ error: { status: 'UNAUTHENTICATED', details: [{ reason: 'ACCESS_TOKEN_EXPIRED' }] } });
            const h1 = holdOnce('r40-o-a', () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: () => new Promise((r) => (body1 = () => r(unauth))) }));
            const ht = holdOnce('r40-o-a', offline, true);
            writeAg('r40-o-a@example.com', 'r40-o-a');
            const req1 = inst.readOne(wrappedAg, true);
            await until(() => h1.release && ht.release);
            writeAg('r40-o-b@example.com', 'r40-o-b');
            await inst.readOne(wrappedAg, true);
            writeAg('r40-o-a@example.com', 'r40-o-a');
            const h2 = holdOnce('r40-o-a', quotaAt(0.25));
            const req2 = inst.readOne(wrappedAg, true);
            await until(() => h2.release);
            h1.release();
            await until(() => body1); // the 403's headers are in, its body held
            h2.release();
            await req2;
            assert.strictEqual(shown(inst).rows[0]?.percent, 75, "A's second request publishes 75%");
            ht.release();
            await settle(); // loadCodeAssist is in its 250ms retry pause
            body1();
            await req1;
            await pastRetry();
            assert.strictEqual(asked(tierBearers, 'r40-o-a'), 2, "the older refusal doesn't call off loadCodeAssist's retry for the bearer");
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 75], `${where}: the older 403 refusal never replaces the newer confirmed 75%`);
            }
            assert.strictEqual(asked(sentBearers, 'r40-o-a'), 2, 'nothing more is asked under the 600s wait');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
          }
        }

        // Round 40 Fix 3 (refused replacement): A2 is refused with no cooldown, A1 for the same account is sent, and A2 is
        // put back before A1's 200 lands. The check after it finds the refused A2: both screens keep A2's sign-in note,
        // and A1's reading is neither shown nor saved.
        {
          const inst = fresh();
          const phone = phoneSees(inst);
          try {
            writeAg('r40-ra@example.com', 'r40-ra-2');
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, 'A2 refused, no cooldown');
            writeAg('r40-ra@example.com', 'r40-ra-1');
            const h = holdOnce('r40-ra-1', quotaAt(0.25));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            writeAg('r40-ra@example.com', 'r40-ra-2');
            h.release();
            await req;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length, `${where}: the refused A2 installed again keeps its sign-in note, not A1's 75%`);
            }
            assert.strictEqual(inst.savedCache().antigravity, undefined, "A1's reading is not saved");
          } finally {
            phone.close();
            inst.on['will-quit']();
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 40 Fix 3 (valid replacement): A1 is refused, refreshed again with A1, and a valid A2 is installed while that
        // request is out; it gets a 503 with Retry-After 600. The check after it finds A2: both screens drop A1's sign-in
        // note at once, for the cached 85% or an empty section, under the wait, and A2 asks nothing during it.
        for (const cached of [true, false]) {
          const tag = cached ? 'c' : 'n';
          const inst = fresh();
          const phone = phoneSees(inst);
          try {
            writeAg(`r40-rb-${tag}@example.com`, `r40-rb-${tag}-1`);
            if (cached) {
              quotaAnswer = quotaAt(0.15);
              await inst.readOne(wrappedAg, true);
            }
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, 'A1 refused');
            const h = holdOnce(`r40-rb-${tag}-1`, () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            writeAg(`r40-rb-${tag}@example.com`, `r40-rb-${tag}-2`);
            h.release();
            await req;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, cached ? 85 : undefined, true], `${where}: the valid A2 lifts A1's note at once (${cached ? 'cached 85%' : 'nothing cached'}) under the 503's wait`);
            }
            assert.strictEqual(asked(sentBearers, `r40-rb-${tag}-2`), 0, 'A2 asks nothing under the 600s wait');
          } finally {
            phone.close();
            inst.on['will-quit']();
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 40 Fix 4: a quota request is out when the same bearer's stored expiry moves to 100ms away, and a manual
        // refresh sees it and joins the request. The request meets a transport error and the expiry passes during the
        // 250ms pause: no retry goes with the bearer.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r40-exp@example.com', 'r40-exp-1');
            const h = holdOnce('r40-exp-1', offline);
            const first = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            writeAg('r40-exp@example.com', 'r40-exp-1', { expiry: new Date(clock + 100).toISOString() });
            const manual = inst.readOne(wrappedAg, true);
            await settle(); // the refresh saw the nearer expiry and joined
            h.release();
            await settle(); // quota is in its 250ms retry pause
            clock += 200;
            await pastRetry();
            await Promise.all([first, manual]);
            assert.strictEqual(asked(sentBearers, 'r40-exp-1'), 1, 'no retry goes once the expiry a joined refresh saw has passed');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
          }
        }

        // Round 41 Fix 1: an older delayed 403 UNAUTHENTICATED quota body must NOT cancel loadCodeAssist's transport
        // retry after a newer quota request for the same bearer already returned 429 or non-auth 403 PERMISSION_DENIED.
        for (const [tag, newerResp] of [
          ['429', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) })],
          ['403p', () => ({ ok: false, status: 403, headers: new Headers(), text: async () => JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } }) })],
        ]) {
          const inst = fresh();
          let releaseOldBody = null;
          const unauthBody = JSON.stringify({ error: { status: 'UNAUTHENTICATED', details: [{ reason: 'ACCESS_TOKEN_EXPIRED' }] } });
          try {
            writeAg(`r41-${tag}-a@example.com`, `r41-${tag}-a`);
            tierAnswer = () => ({ ok: true, json: async () => ({}) }); // keep tier uncached so retry runs on return
            const h1 = holdOnce(`r41-${tag}-a`, () => ({ ok: false, status: 403, headers: new Headers(), text: () => new Promise((r) => (releaseOldBody = r)) }));
            const req1 = inst.readOne(wrappedAg, true);
            await until(() => h1.release);
            // Switch to B so A's request is superseded:
            writeAg(`r41-${tag}-b@example.com`, `r41-${tag}-b`);
            quotaAnswer = quotaAt(0.5);
            tierAnswer = proTier;
            await inst.readOne(wrappedAg, true);
            // Deliver A's old 403 headers while holding its UNAUTHENTICATED body open:
            h1.release();
            await until(() => releaseOldBody);
            // Switch back to A (same bearer); clear local tier backoff by advancing clock or fresh tier attempt via offline:
            providersMod.clearAntigravityTierGates();
            wrappedAg.onSignedOut(); // clears in-memory empty-tier hold from first read
            writeAg(`r41-${tag}-a@example.com`, `r41-${tag}-a`);
            quotaAnswer = newerResp;
            const ht = holdOnce(`r41-${tag}-a`, offline, true);
            tierAnswer = proTier;
            await inst.readOne(wrappedAg, true);
            await until(() => ht.release);
            ht.release();
            await settle(); // loadCodeAssist is now in its 250ms retry pause
            releaseOldBody(unauthBody);
            await req1;
            await pastRetry();
            assert.strictEqual(asked(tierBearers, `r41-${tag}-a`), 3, `${tag}: older 403 UNAUTHENTICATED body does not cancel loadCodeAssist retry after newer ${tag}`);
          } finally {
            quotaAnswer = quotaAt(0.5);
            tierAnswer = proTier;
          }
          inst.on['will-quit']();
        }

        // Round 41 Fix 2: a replaced bearer's 403 PERMISSION_DENIED (ACCESS_TOKEN_SCOPE_INSUFFICIENT + Retry-After: 600)
        // must NOT overwrite the valid replacement bearer's restored 85% cached reading.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r41-perm@example.com', 'r41-perm-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, 'A1 401 shows Session expired');
            const scopeBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
            const h = holdOnce('r41-perm-1', () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => scopeBody }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            writeAg('r41-perm@example.com', 'r41-perm-2');
            h.release();
            await req;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: A1 403 PERMISSION_DENIED does not overwrite A2's restored 85% and 600s wait`);
            }
            assert.strictEqual(asked(sentBearers, 'r41-perm-2'), 0, 'A2 respects the 600s cooldown');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 41 Fix 3: a quota 401 followed by a failed post-fetch credential lookup must clear an active desktop
        // reset notice immediately instead of leaving the reset banner showing 5% beside Session expired.
        {
          const inst = fresh();
          writeAg('r41-rst@example.com', 'r41-rst-1');
          try {
            quotaAnswer = quotaAt(0.15); // 85%
            await inst.readOne(wrappedAg, true);
            quotaAnswer = quotaAt(0.95); // 5% -> fires reset notice
            await inst.readOne(wrappedAg, true);
            const resetBefore = inst.sent.filter(([ch]) => ch === 'reset').at(-1);
            assert.ok(resetBefore?.[1]?.rows?.[0]?.percent === 5, 'reset notice active showing 5%');
            const h = holdOnce('r41-rst-1', () => ({ ok: false, status: 401, headers: new Headers() }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            peekHook = lookupBroken;
            h.release();
            await req;
            const resetAfter = inst.sent.filter(([ch]) => ch === 'reset').at(-1);
            assert.deepStrictEqual([resetAfter?.[1], /Session expired/i.test(desk(inst).error || '')], [null, true], 'desktop reset notice is cleared immediately when 401 + failed lookup shows Session expired');
          } finally {
            peekHook = null;
            quotaAnswer = quotaAt(0.5);
          }
          inst.on['will-quit']();
        }

        // Round 42 Fix 1: after 401, a 429 with Retry-After: 600 whose post-fetch lookup fails once already cleared
        // authRejected; on the next scheduled lookup confirming the same unexpired bearer, both screens must lift
        // "Session expired", restore cached 85%, and show the remaining wait.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r42-429pf@example.com', 'r42-429pf-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, '401 shows Session expired');
            const h = holdOnce('r42-429pf-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            peekHook = lookupBroken;
            h.release();
            await req;
            peekHook = null;
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: next check lifts old Session expired after 429 and restores 85% + remaining wait`);
            }
            assert.strictEqual(asked(sentBearers, 'r42-429pf-1'), 3, 'cooldown still holds after 60s');
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 42 Fix 2: after 403 PERMISSION_DENIED (ACCESS_TOKEN_SCOPE_INSUFFICIENT + Retry-After: 600) finishes on
        // bearer A1, installing an unexpired replacement A2 for the same account and refreshing must lift A1's access
        // denied message, restore cached 85%, and honor the 600s wait on both screens.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r42-scope@example.com', 'r42-scope-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            const scopeBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => scopeBody });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Antigravity access denied/i, 'A1 403 shows access denied');
            // Refresh with same bearer A1 keeps access denied:
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Antigravity access denied/i, 'same bearer A1 keeps access denied');
            // Install valid replacement A2 for same account and refresh:
            writeAg('r42-scope@example.com', 'r42-scope-2');
            await inst.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: replacement A2 lifts A1 scope error and restores 85% + 600s wait`);
            }
            assert.strictEqual(asked(sentBearers, 'r42-scope-2'), 0, 'replacement A2 respects the 600s cooldown');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 43 Fix: after 403 PERMISSION_DENIED without Retry-After, a 429 with Retry-After: 600 whose post-fetch
        // lookup fails once must still lift the stale access-denied error on the next scheduled check confirming the
        // same unexpired bearer, restoring cached 85% and reporting waitMs > 0 on desktop and phone.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r43-403pf@example.com', 'r43-403pf-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody });
            await inst.readOne(wrappedAg, true);
            assert.ok(/Antigravity access denied/i.test(shown(inst).error || '') && shown(inst).errSeq === undefined, '403 PERMISSION_DENIED shows access denied without leaking errSeq');
            const h = holdOnce('r43-403pf-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            peekHook = lookupBroken;
            h.release();
            await req;
            peekHook = null;
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: next check lifts old 403 PERMISSION_DENIED after 429 and restores 85% + waitMs`);
            }
            assert.strictEqual(asked(sentBearers, 'r43-403pf-1'), 3, 'cooldown still holds after 60s');
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 44 Fix 1: a second 403 PERMISSION_DENIED with Retry-After: 600 whose post-fetch lookup fails once must
        // NOT advance errorLifted and replace the active permission denial with cached 85% on the next check.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r44-403x2@example.com', 'r44-403x2-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody });
            await inst.readOne(wrappedAg, true);
            const h = holdOnce('r44-403x2-1', () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => permBody }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            peekHook = lookupBroken;
            h.release();
            await req;
            peekHook = null;
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Antigravity access denied/i.test(s.error || '') && !s.rows.length, `${where}: second 403 with failed lookup keeps permission denial instead of restoring cached 85%`);
            }
            assert.strictEqual(asked(sentBearers, 'r44-403x2-1'), 3, 'cooldown still holds after 60s');
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 44 Fix 2: a 401 sign-in error restored after restart (no errSeq) must still be lifted after its wait
        // expires and a newer 429 (with Retry-After: 600 and a failed post-fetch lookup) clears the rejection.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst1 = fresh();
            writeAg('r44-rst429@example.com', 'r44-rst429-1');
            quotaAnswer = quotaAt(0.15);
            await inst1.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '120' }) });
            await inst1.readOne(wrappedAg, true);
            inst1.flushState();
            inst1.on['will-quit']();
            const inst2 = loadInstance();
            inst2.loadState();
            const phone = phoneSees(inst2);
            await inst2.readOne(wrappedAg, false);
            assert.match(shown(inst2).error || '', /Session expired/i, 'restart restores Session expired during 120s cooldown');
            // Cooldown expires; next refresh returns 429 with Retry-After: 600 and fails post-fetch lookup once:
            clock += 121_000;
            const h = holdOnce('r44-rst429-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst2.readOne(wrappedAg, true);
            await until(() => h.release);
            peekHook = lookupBroken;
            h.release();
            await req;
            peekHook = null;
            clock += 60_000;
            await inst2.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst2)], ['desktop', desk(inst2)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: restored Session expired lifts after newer 429 and restores 85% + waitMs`);
            }
            phone.close();
            inst2.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 45 Fix 1: an older 200 landing after a newer 403 PERMISSION_DENIED (with Retry-After: 600 and a failed
        // post-fetch lookup) must NOT advance errorLifted and restore cached 85% during the 403 cooldown.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const toggle = (on) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: on } }));
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            writeAg('r45-late200@example.com', 'r45-late200-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Antigravity access denied/i, 'initial 403 shows access denied');
            const h200 = holdOnce('r45-late200-1', quotaAt(0.3));
            const reqOld = inst.readOne(wrappedAg, true);
            await until(() => h200.release);
            // Disable and re-enable Antigravity so a newer request starts for the same bearer:
            await toggle(false);
            const h403 = holdOnce('r45-late200-1', () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => permBody }));
            await toggle(true);
            await until(() => h403.release);
            peekHook = lookupBroken;
            h403.release();
            await settle();
            peekHook = null;
            // Now release the older 200: its stale seq must NOT advance errorLifted!
            h200.release();
            await reqOld;
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Antigravity access denied/i.test(s.error || '') && !s.rows.length, `${where}: older 200 does not erase newer 403 permission denial during 600s cooldown`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 45 Fix 2: after 401, a 403 PERMISSION_DENIED with Retry-After: 600 whose post-fetch lookup fails once
        // must replace "Session expired" with "Antigravity access denied" immediately and after the 60s check.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            writeAg('r45-401to403@example.com', 'r45-401to403-1');
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, '401 shows Session expired');
            const h = holdOnce('r45-401to403-1', () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => permBody }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            peekHook = lookupBroken;
            h.release();
            await req;
            peekHook = null;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.match(s.error || '', /Antigravity access denied/i, `${where}: 403 replaces Session expired immediately even when post-fetch lookup fails`);
            }
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.match(s.error || '', /Antigravity access denied/i, `${where}: 60s check keeps access denied during 540s remaining cooldown`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 46 Fix 1: a 403 PERMISSION_DENIED with Retry-After: 600 must survive both a restart and an A -> B -> A
        // account switch during its cooldown on snapshot, desktop, and phone (with Refresh enabled and no extra fetch).
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            // (a) Restart during 403 PERMISSION_DENIED cooldown
            const inst1 = fresh();
            writeAg('r46-perm-rst@example.com', 'r46-perm-rst-1');
            quotaAnswer = quotaAt(0.15);
            await inst1.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => permBody });
            await inst1.readOne(wrappedAg, true);
            assert.strictEqual(asked(sentBearers, 'r46-perm-rst-1'), 2, 'initial 85% + 403 sent two requests');
            inst1.flushState();
            inst1.on['will-quit']();

            const inst2 = loadInstance();
            inst2.loadState();
            const phone1 = phoneSees(inst2);
            clock += 30_000;
            await inst2.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst2)], ['desktop', desk(inst2)], ['phone', phone1.last()]]) {
              assert.ok(/Antigravity access denied/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: restart during 403 cooldown keeps access denied with Refresh enabled`);
            }
            assert.strictEqual(asked(sentBearers, 'r46-perm-rst-1'), 2, 'cooldown holds off quota fetches after restart');
            phone1.close();
            inst2.on['will-quit']();

            // (b) Account switch A -> B -> A during 403 PERMISSION_DENIED cooldown
            const inst3 = fresh();
            const phone2 = phoneSees(inst3);
            writeAg('r46-perm-a@example.com', 'r46-perm-a-1');
            quotaAnswer = quotaAt(0.15);
            await inst3.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => permBody });
            await inst3.readOne(wrappedAg, true);
            assert.strictEqual(asked(sentBearers, 'r46-perm-a-1'), 2, 'A sent initial 85% + 403');
            writeAg('r46-perm-b@example.com', 'r46-perm-b-1');
            quotaAnswer = quotaAt(0.5);
            await inst3.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst3).rows[0]?.percent, 50, 'B loads normally');
            writeAg('r46-perm-a@example.com', 'r46-perm-a-1');
            clock += 30_000;
            await inst3.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst3)], ['desktop', desk(inst3)], ['phone', phone2.last()]]) {
              assert.ok(/Antigravity access denied/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: A -> B -> A during 403 cooldown keeps access denied with Refresh enabled`);
            }
            assert.strictEqual(asked(sentBearers, 'r46-perm-a-1'), 2, 'switching back to A during 403 cooldown sends no quota fetch');
            phone2.close();
            inst3.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 46 Fix 2: a late 401 for the currently active bearer (A1 held -> rotated to A2 returning 503 with
        // Retry-After: 300 -> restored A1 during cooldown -> original A1 returns 401 with Retry-After: 600) must show
        // "Session expired" with Refresh enabled immediately instead of leaving cached 85% and disabled Refresh for 60s.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r46-late401@example.com', 'r46-late401-a1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst).rows[0]?.percent, 85, 'seeded 85% reading for A1');

            const hA1 = holdOnce('r46-late401-a1', () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) }));
            const reqA1 = inst.readOne(wrappedAg, true);
            await until(() => hA1.release);

            writeAg('r46-late401@example.com', 'r46-late401-a2');
            quotaAnswer = () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '300' }) });
            await inst.readOne(wrappedAg, true);

            writeAg('r46-late401@example.com', 'r46-late401-a1');
            await inst.readOne(wrappedAg, true);
            assert.ok(shown(inst).rows[0]?.percent === 85 && shown(inst).waitMs > 0, 'A1 confirmed during 300s 503 cooldown shows cached 85% and disabled Refresh');

            hA1.release();
            await reqA1;
            // Immediately (no clock advance!): desktop, phone, and snapshot must show Session expired with waitMs === 0.
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: late 401 for active bearer immediately shows Session expired and keeps Refresh enabled`);
            }
            const beforeRetry = asked(sentBearers, 'r46-late401-a1');
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(asked(sentBearers, 'r46-late401-a1'), beforeRetry, 'extended 600s cooldown still holds off quota requests');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 47 Fix 1: an older 200 whose post-fetch credential check was paused while a disable/re-enable fetched
        // a newer 403 PERMISSION_DENIED (with Retry-After: 600) must NOT clear the newer denial when its check resolves.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const toggle = (on) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: on } }));
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            writeAg('r47-old200@example.com', 'r47-old200-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Antigravity access denied/i, 'initial 403 shows access denied');

            // Next refresh returns 200 and pauses its post-fetch peekCred:
            quotaAnswer = quotaAt(0.3);
            let step = 0;
            let releaseAfterPeek = null;
            peekHook = (orig) => (++step === 2 ? new Promise((r) => (releaseAfterPeek = () => r(orig()))) : orig());
            const oldReq = inst.readOne(wrappedAg, true);
            await until(() => releaseAfterPeek);
            peekHook = null;

            // Disable & re-enable Antigravity; newer request returns 403 PERMISSION_DENIED with Retry-After: 600:
            await toggle(false);
            quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => permBody });
            await toggle(true);
            await until(() => /Antigravity access denied/i.test(shown(inst).error || '') && inst.gate.get('antigravity') > clock);

            // Release the older paused post-fetch credential check:
            releaseAfterPeek();
            await oldReq;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Antigravity access denied/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: older paused 200 does not clear newer 403 permission denial`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 47 Fix 2: a late 200 arriving after the active bearer's local expiry has passed must NOT replace
        // "Session expired" with cached 85% and disable Refresh.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const expIso = new Date(clock + 5_000).toISOString();
            writeAg('r47-exp200@example.com', 'r47-exp200-a1', { expiry: expIso });
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, '401 shows Session expired');

            const hA1 = holdOnce('r47-exp200-a1', quotaAt(0.25));
            const reqA1 = inst.readOne(wrappedAg, true);
            await until(() => hA1.release);

            writeAg('r47-exp200@example.com', 'r47-exp200-a2');
            quotaAnswer = () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '300' }) });
            await inst.readOne(wrappedAg, true);

            // Restore A1 and refresh before its 5s expiry:
            clock += 2_000;
            writeAg('r47-exp200@example.com', 'r47-exp200-a1', { expiry: expIso });
            await inst.readOne(wrappedAg, true);
            assert.ok(/Session expired/i.test(shown(inst).error || '') && shown(inst).waitMs === 0, 'A1 confirmed before expiry still shows Session expired with Refresh enabled');

            // Advance past A1's expiry, then release A1's held 200:
            clock += 4_000;
            hA1.release();
            await reqA1;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: late 200 after bearer expiry keeps Session expired and Refresh enabled`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 47 Fix 3: a 429 with Retry-After: 600 whose post-fetch credential check fails must arm the live gate
        // right away so desktop and phone show waitMs > 0 (Refresh disabled) beside the cached reading.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r47-429gate@example.com', 'r47-429gate-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            const h = holdOnce('r47-429gate-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            peekHook = lookupBroken;
            h.release();
            await req;
            peekHook = null;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(!s.error && s.rows[0]?.percent === 85 && s.waitMs > 0, `${where}: 429 with failed post-fetch lookup still arms waitMs immediately`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 47 Fix 4: signing out and restoring the same bearer must NOT let an older pre-sign-out 401 cancel a
        // fresh loadCodeAssist transport retry after a newer pre-sign-out 200 had already succeeded.
        {
          const inst = fresh();
          const toggle = (on) => inst.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: on } }));
          try {
            writeAg('r47-tier@example.com', 'r47-tier-1');
            tierAnswer = proTier;
            const hOld401 = holdOnce('r47-tier-1', () => ({ ok: false, status: 401, headers: new Headers() }));
            const reqOld = inst.readOne(wrappedAg, true);
            await until(() => hOld401.release);

            // Disable & re-enable with same bearer; newer quota request succeeds with 200:
            await toggle(false);
            quotaAnswer = quotaAt(0.2);
            await toggle(true);
            await until(() => shown(inst).rows[0]?.percent === 80);

            // Sign out and confirm sign-out:
            fs.rmSync(agMainAuth, { force: true });
            await inst.readOne(wrappedAg, true);
            assert.ok(inst.last.get('antigravity')?.signedOut, 'sign-out confirmed');

            // Restore the same bearer; hold new quota 200 and make first loadCodeAssist attempt fail with transport error:
            writeAg('r47-tier@example.com', 'r47-tier-1');
            const hNew200 = holdOnce('r47-tier-1', quotaAt(0.3));
            const hTierErr = holdOnce('r47-tier-1', offline, true);
            tierAnswer = proTier;
            const reqNew = inst.readOne(wrappedAg, true);
            await until(() => hNew200.release && hTierErr.release);
            const tierBefore = asked(tierBearers, 'r47-tier-1');
            hTierErr.release();
            await settle(); // loadCodeAssist is now in its 250ms retry pause

            // Release the oldest pre-sign-out 401 during the pause: must NOT cancel loadCodeAssist retry!
            hOld401.release();
            await reqOld;
            await pastRetry();
            assert.strictEqual(asked(tierBearers, 'r47-tier-1'), tierBefore + 1, 'pre-sign-out 401 does not cancel fresh loadCodeAssist retry');
            hNew200.release();
            await reqNew;
            assert.deepStrictEqual([shown(inst).rows[0]?.percent, shown(inst).plan], [70, 'AI Pro'], 'fresh quota lands with recovered AI Pro plan');
          } finally {
            quotaAnswer = quotaAt(0.5);
            tierAnswer = proTier;
          }
          inst.on['will-quit']();
        }

        // Round 48 Fix 1: a non-superseded 403 PERMISSION_DENIED arriving after the bearer's local expiry has passed
        // (with a failed post-fetch lookup) must NOT replace "Session expired" with "Antigravity access denied".
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            const expIso = new Date(clock + 5_000).toISOString();
            writeAg('r48-exp403@example.com', 'r48-exp403-1', { expiry: expIso });
            quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
            await inst.readOne(wrappedAg, true);
            assert.match(shown(inst).error || '', /Session expired/i, 'initial 401 shows Session expired');

            const h = holdOnce('r48-exp403-1', () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            // Advance past local expiry, fail post-fetch lookup, and release the 403 PERMISSION_DENIED:
            clock += 6_000;
            peekHook = lookupBroken;
            h.release();
            await req;
            peekHook = null;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: 403 after local expiry keeps Session expired instead of switching to access denied`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 48 Fix 2: a stale "No usage windows reported" error followed by a 429 (Retry-After: 600) with a failed
        // post-fetch lookup must lift at the 60s credential check, restoring cached 85% and showing waitMs > 0.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg('r48-nowin@example.com', 'r48-nowin-1');
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            quotaAnswer = () => ({ ok: true, json: async () => ({ groups: [] }) });
            await inst.readOne(wrappedAg, true);
            assert.ok(/No usage windows/i.test(shown(inst).error || '') && shown(inst).errSeq === undefined, 'empty groups shows No usage windows without leaking errSeq');

            const h = holdOnce('r48-nowin-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);
            peekHook = lookupBroken;
            h.release();
            await req;
            peekHook = null;

            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: 60s check lifts stale No usage windows error, restores 85% and disables Refresh during 429 cooldown`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 48 Fix 3: an existing 90s cooldown discovered when the post-fetch credential check links a refresh token
        // onto an email-only credential during a 200 fetch must arm waitMs > 0 right away and resume polling at 90s.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            writeAg(undefined, 'r48-link-1', { refresh_token: 'r48-rt-link' });
            quotaAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }) });
            await inst.readOne(wrappedAg, true);
            const t0 = clock;

            writeAg('r48-link@example.com', 'r48-link-2');
            const h200 = holdOnce('r48-link-2', quotaAt(0.25));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h200.release);
            // Add original refresh token while quota request is in flight, then complete 200:
            writeAg('r48-link@example.com', 'r48-link-2', { refresh_token: 'r48-rt-link' });
            h200.release();
            await req;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(!s.error && s.rows[0]?.percent === 75 && s.waitMs > 0, `${where}: post-fetch linked cooldown arms waitMs immediately`);
            }
            // At 90s, scheduled check must fetch quota immediately (not wait out the 5m interval):
            quotaAnswer = quotaAt(0.4);
            const before90 = asked(sentBearers, 'r48-link-2');
            clock = t0 + 90_000;
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([asked(sentBearers, 'r48-link-2'), shown(inst).rows[0]?.percent], [before90 + 1, 60], 'scheduled check at 90s resumes quota polling immediately');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 48 Fix 4: a transport retry must NOT resend a bearer after an overtaken credential snapshot already
        // observed that bearer as expired (even while its replacement lookup is still pending).
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r48-exp-retry@example.com', 'r48-exp-retry-1', { expiry: new Date(clock + 3600_000).toISOString() });
            const hQuota = holdOnce('r48-exp-retry-1', offline);
            const reqQuota = inst.readOne(wrappedAg, true);
            await until(() => hQuota.release);

            // Prepare an already-expired snapshot of the same bearer on disk:
            writeAg('r48-exp-retry@example.com', 'r48-exp-retry-1', { expiry: new Date(clock - 10_000).toISOString() });
            let releaseExpPeek = null;
            let releaseRetryPeek = null;
            let peekCount = 0;
            peekHook = (orig) => {
              const n = ++peekCount;
              if (n === 1) {
                const p = orig(); // starts peekAntigravityCred with seq=2 (reads expired snapshot immediately)
                return new Promise((r) => (releaseExpPeek = () => r(p)));
              }
              if (n === 2) return lookupBroken(); // overtakes #1 in main.js peekCred immediately
              if (n === 3) return new Promise((r) => (releaseRetryPeek = () => r(orig()))); // holds #1's replacement lookup
              return orig();
            };

            const r1 = inst.readOne(wrappedAg, true);
            await until(() => releaseExpPeek);
            const r2 = inst.readOne(wrappedAg, true);
            await until(() => peekCount === 2);
            await settle();
            releaseExpPeek();
            await until(() => releaseRetryPeek);

            // Fail the original quota request with a transport error: must NOT retry the now-expired bearer!
            hQuota.release();
            await pastRetry();
            assert.strictEqual(asked(sentBearers, 'r48-exp-retry-1'), 1, 'transport retry does not resend bearer observed expired by overtaken snapshot');

            peekHook = null;
            releaseRetryPeek();
            await Promise.all([reqQuota, r1, r2]);
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 49 Fix 1: a 429 (Retry-After: 600) arriving after the bearer's local expiry with a failed post-fetch
        // credential lookup must show "Session expired" and keep Refresh enabled (waitMs === 0) on both screens while
        // the account cooldown still blocks quota requests (including if the 60s lookup fails again).
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const expIso = new Date(clock + 5_000).toISOString();
            writeAg('r49-exp429@example.com', 'r49-exp429-1', { expiry: expIso });
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst).rows[0]?.percent, 85, 'seeded 85% reading');

            const h = holdOnce('r49-exp429-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst.readOne(wrappedAg, true);
            await until(() => h.release);

            clock += 6_000;
            peekHook = lookupBroken;
            h.release();
            await req;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: 429 after local expiry with failed lookup shows Session expired and keeps Refresh enabled`);
            }
            // If the 60s lookup fails again, both screens still show Session expired with Refresh enabled:
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: second failed lookup keeps Session expired and Refresh enabled`);
            }
            // Installing a fresh unexpired bearer restores cached 85% while the 600s cooldown still blocks quota fetches:
            peekHook = null;
            writeAg('r49-exp429@example.com', 'r49-exp429-2', { expiry: new Date(clock + 3600_000).toISOString() });
            await inst.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(!s.error && s.rows[0]?.percent === 85 && s.waitMs > 0, `${where}: fresh bearer restores 85% under remaining 600s cooldown`);
            }
            assert.strictEqual(asked(sentBearers, 'r49-exp429-2'), 0, 'account cooldown still blocks quota requests for fresh bearer');
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 50 Fix 1: when a bearer expires during an active 429 cooldown and subsequent scheduled credential
        // lookups time out, desktop and phone must surface "Session expired" with waitMs === 0 (Refresh enabled) while
        // the account cooldown still blocks quota requests.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const expIso = new Date(clock + 5_000).toISOString();
            writeAg('r50-preerr@example.com', 'r50-preerr-1', { expiry: expIso });
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst).rows[0]?.percent, 85, 'seeded 85% reading at t=0');

            // At t+1s, 429 Retry-After: 600 with successful post-fetch lookup while bearer is still valid:
            clock += 1_000;
            quotaAnswer = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) });
            await inst.readOne(wrappedAg, true);
            assert.ok(!shown(inst).error && shown(inst).rows[0]?.percent === 85 && shown(inst).waitMs > 0, '429 arms 600s cooldown while bearer is valid');

            // At t+61s and t+121s (past t+5s expiry), scheduled lookups time out:
            peekHook = lookupBroken;
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: first timed-out lookup after expiry surfaces Session expired with Refresh enabled`);
            }
            clock += 60_000;
            await inst.readOne(wrappedAg, false);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: second timed-out lookup keeps Session expired with waitMs === 0`);
            }
            // Once lookup recovers with a fresh bearer, cached 85% returns under the remaining cooldown without fetching:
            peekHook = null;
            writeAg('r50-preerr@example.com', 'r50-preerr-2', { expiry: new Date(clock + 3600_000).toISOString() });
            await inst.readOne(wrappedAg, true);
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(!s.error && s.rows[0]?.percent === 85 && s.waitMs > 0, `${where}: fresh bearer restores 85% and remaining cooldown`);
            }
            assert.strictEqual(asked(sentBearers, 'r50-preerr-2'), 0, 'account cooldown still blocks quota requests');
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 51 Fix 1: when a failed Refresh surfaces local expiry ("Session expired") while an older request is in
        // flight, installing an unexpired replacement bearer and letting that request return 503 Retry-After: 600 must
        // lift "Session expired", restore cached 85%, and arm waitMs > 0 immediately on post-fetch verification.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst1 = fresh();
            const expIso = new Date(clock + 5_000).toISOString();
            writeAg('r51-repl503@example.com', 'r51-repl503-1', { expiry: expIso });
            quotaAnswer = quotaAt(0.15);
            await inst1.readOne(wrappedAg, true);
            inst1.flushState();
            inst1.on['will-quit']();

            // Restart at t+1s and hold the first quota response:
            clock += 1_000;
            const inst2 = loadInstance();
            inst2.loadState();
            const phone = phoneSees(inst2);
            const h503 = holdOnce('r51-repl503-1', () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '600' }) }));
            const req = inst2.readOne(wrappedAg, true);
            await until(() => h503.release);

            // At t+6s (past expiry), manual Refresh times out -> surfaces Session expired:
            clock += 5_000;
            peekHook = lookupBroken;
            const rTimedOut = inst2.readOne(wrappedAg, true);
            await until(() => /Session expired/i.test(shown(inst2).error || ''));
            assert.ok(/Session expired/i.test(shown(inst2).error || '') && shown(inst2).waitMs === 0, 'timed-out refresh after expiry shows Session expired');

            // Install an unexpired replacement bearer for the same account and release the 503 Retry-After: 600:
            peekHook = null;
            writeAg('r51-repl503@example.com', 'r51-repl503-2', { expiry: new Date(clock + 3600_000).toISOString() });
            h503.release();
            await Promise.all([req, rTimedOut]);
            for (const [where, s] of [['snapshot', shown(inst2)], ['desktop', desk(inst2)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: verified replacement lifts Session expired, restores 85% and arms 503 cooldown immediately`);
            }
            phone.close();
            inst2.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 51 Fix 2: an older loadCodeAssist response (AI Pro) landing after a newer linked bearer's response
        // (AI Ultra) must NOT roll back the displayed or cached subscription plan on the next tick.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const ultraTier = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } }) });
            writeAg('r51-tier@example.com', 'r51-tier-1');
            const hOldTier = holdOnce('r51-tier-1', proTier, true);
            quotaAnswer = quotaAt(0.2);
            await inst.readOne(wrappedAg, true);
            await until(() => hOldTier.release);

            // Rotate to a bare bearer (no email, no refresh token) returning AI Ultra:
            writeAg(undefined, 'r51-tier-2');
            tierAnswer = ultraTier;
            quotaAnswer = quotaAt(0.25);
            await inst.readOne(wrappedAg, true);
            await until(() => wrappedAg.cachedPlan('r51-tier-2') === 'AI Ultra' || inst.last.get('antigravity')?.plan === 'AI Ultra');

            // Add original email to the replacement bearer and refresh to link identities:
            writeAg('r51-tier@example.com', 'r51-tier-2');
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst).plan, 'AI Ultra', 'linked identity shows AI Ultra');

            // Advance clock slightly so arrival time of old response is strictly later, then release older AI Pro:
            clock += 5_000;
            hOldTier.release();
            await settle();
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(shown(inst).plan, 'AI Ultra', 'late older AI Pro response does not roll back AI Ultra');
            assert.strictEqual(inst.savedCache().antigravity?.plan, 'AI Ultra', 'saved cache keeps AI Ultra');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
            tierAnswer = proTier;
          }
        }

        // Round 52 Fix 1: when a bearer is later restored with expiry: null and verified, a superseded response from
        // an earlier request carrying an old expiry must NOT fall back to that old expiry and mark the session expired.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const expIso = new Date(clock + 5_000).toISOString();
            writeAg('r52-nullexp@example.com', 'r52-nullexp-a', { expiry: expIso });
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            assert.strictEqual(shown(inst).rows[0]?.percent, 85, 'seeded 85% with A (5s expiry)');

            // Hold a second request for A (with the 5s expiry):
            const hOld = holdOnce('r52-nullexp-a', () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '600' }) }));
            const reqOld = inst.readOne(wrappedAg, true);
            await until(() => hOld.release);

            // Switch to B on same account and refresh successfully:
            writeAg('r52-nullexp@example.com', 'r52-nullexp-b');
            quotaAnswer = quotaAt(0.2);
            await inst.readOne(wrappedAg, true);

            // Advance past A's original 5s expiry, restore A with expiry: null, and refresh successfully:
            clock += 6_000;
            writeAg('r52-nullexp@example.com', 'r52-nullexp-a', { expiry: null });
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);
            assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent], [undefined, 85], 'restored A with expiry: null loads 85% cleanly');

            // Release the superseded request as 503 Retry-After: 600:
            hOld.release();
            await reqOld;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 85, true], `${where}: superseded 503 does not mark expiry: null session expired; keeps 85% + cooldown`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 52 Fix 2: when two held tier responses land (AI Pro on email slot, then AI Ultra on linked bare-bearer
        // slot) while a third linked quota request is in flight, the quota response must publish and save AI Ultra.
        {
          const inst = fresh();
          const ultraTier = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } }) });
          try {
            writeAg('r52-tier@example.com', 'r52-tier-a');
            const hTierA = holdOnce('r52-tier-a', proTier, true);
            quotaAnswer = quotaAt(0.2);
            await inst.readOne(wrappedAg, true);
            await until(() => hTierA.release);

            writeAg(undefined, 'r52-tier-b');
            const hTierB = holdOnce('r52-tier-b', ultraTier, true);
            quotaAnswer = quotaAt(0.25);
            await inst.readOne(wrappedAg, true);
            await until(() => hTierB.release);

            // Add A's email to B and start a third refresh holding its quota response:
            writeAg('r52-tier@example.com', 'r52-tier-b');
            const hQuota3 = holdOnce('r52-tier-b', quotaAt(0.3));
            const req3 = inst.readOne(wrappedAg, true);
            await until(() => hQuota3.release);

            // Release A's tier (AI Pro) first, then B's newer tier (AI Ultra):
            const linkedAcct = inst.last.get('antigravity').renewsFor;
            hTierA.release();
            await settle();
            hTierB.release();
            await until(() => wrappedAg.cachedPlan(linkedAcct) === 'AI Ultra');

            // Now release the third quota response: must display AND save AI Ultra immediately!
            hQuota3.release();
            await req3;
            assert.deepStrictEqual([shown(inst).rows[0]?.percent, shown(inst).plan], [70, 'AI Ultra'], 'linked quota response publishes newest AI Ultra tier immediately');
            assert.strictEqual(inst.savedCache().antigravity?.plan, 'AI Ultra', 'saved cache stores AI Ultra');
            inst.on['will-quit']();
          } finally {
            quotaAnswer = quotaAt(0.5);
            tierAnswer = proTier;
          }
        }

        // Round 53 Fix 1: a delayed 403 PERMISSION_DENIED with a failed post-fetch check must NOT overwrite a
        // confirmed Session expired state when the request originally started with expiry: null and a joining refresh
        // later confirmed a nearer expiry that has since passed.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'CONSUMER_INVALID' }] } });
            writeAg('r53-exp403@example.com', 'r53-exp403-1', { expiry: null });
            quotaAnswer = quotaAt(0.15);
            await inst.readOne(wrappedAg, true);

            // Start a second refresh with expiry: null and hold its quota response:
            const h403 = holdOnce('r53-exp403-1', () => ({ ok: false, status: 403, headers: new Headers({ 'retry-after': '600' }), text: async () => permBody }));
            const reqHeld = inst.readOne(wrappedAg, true);
            await until(() => h403.release);

            // Update the same bearer's stored expiry to 5s from now; joining refresh records the 5s expiry:
            writeAg('r53-exp403@example.com', 'r53-exp403-1', { expiry: new Date(clock + 5_000).toISOString() });
            const reqJoin = inst.readOne(wrappedAg, true);
            await settle();

            // Advance 6s past expiry; failing refresh confirms Session expired on both screens:
            clock += 6_000;
            peekHook = lookupBroken;
            const reqFail = inst.readOne(wrappedAg, true);
            await until(() => /Session expired/i.test(shown(inst).error || ''));
            assert.ok(/Session expired/i.test(shown(inst).error || ''), 'confirmed Session expired after 5s expiry passed');

            // Release the held 403 PERMISSION_DENIED with post-fetch lookup also failing: must stay Session expired!
            h403.release();
            await Promise.all([reqHeld, reqJoin, reqFail]);
            peekHook = null;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: delayed 403 does not overwrite confirmed Session expired`);
            }
            phone.close();
            inst.on['will-quit']();
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 53 Fix 2: when account A's late 429 arms a `__weak__` gate while account B is still a bare bearer,
        // verifying B's email in B's post-fetch check (account deadline === 0) must clear the stale live gate so
        // desktop and phone receive waitMs === 0 alongside B's fresh reading.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            const phone = phoneSees(inst);
            // Seed A with email + bearer, then remove email (keeping bearer) and hold A's quota response:
            writeAg('r53-a@example.com', 'r53-a-1');
            quotaAnswer = quotaAt(0.2);
            await inst.readOne(wrappedAg, true);
            writeAg(undefined, 'r53-a-1');
            const hA429 = holdOnce('r53-a-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
            const reqA = inst.readOne(wrappedAg, true);
            await until(() => hA429.release);

            // Switch to bare bearer B and hold B's quota response too:
            writeAg(undefined, 'r53-b-1');
            const hB200 = holdOnce('r53-b-1', quotaAt(0.75));
            const reqB = inst.readOne(wrappedAg, true);
            await until(() => hB200.release);

            // Release A's 429 (arms __weak__ gate while B is still bare):
            hA429.release();
            await reqA;
            assert.ok(inst.gate.get('antigravity') > clock, 'A 429 temporarily arms __weak__ gate while B is bare');

            // Add B's email and release B's 200 (25% used): post-fetch check verifies B has no cooldown and clears gate!
            writeAg('r53-b@example.com', 'r53-b-1');
            hB200.release();
            await reqB;
            for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
              assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs], [undefined, 25, 0], `${where}: verified B clears stale __weak__ gate from A and keeps Refresh enabled`);
            }
            // Round 54 Fix 1: clearing A's temporary __weak__ gate must restore B's 5-minute polling floor so an
            // automatic poll 15s later does NOT send another quota request for B.
            assert.strictEqual(asked(sentBearers, 'r53-b-1'), 1, 'B sent one quota request so far');
            clock += 15_000;
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(asked(sentBearers, 'r53-b-1'), 1, 'automatic poll at +15s respects B five-minute polling floor');
            clock += wrappedAg.everyMs;
            quotaAnswer = quotaAt(0.6);
            await inst.readOne(wrappedAg, false);
            assert.deepStrictEqual([asked(sentBearers, 'r53-b-1'), shown(inst).rows[0]?.percent], [2, 40], 'automatic poll resumes once five-minute floor elapses');
            phone.close();
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Round 55 Fix 1: when a first late 429 arms a 1s `__weak__` gate (wiping `fetched`) and a second late 429
        // clears that expired gate before B publishes 200, B's publish must STILL restore its 5-minute polling floor.
        {
          let clock = clockWas();
          Date.now = () => clock;
          try {
            const inst = fresh();
            writeAg('r55-a@example.com', 'r55-a-1');
            quotaAnswer = quotaAt(0.2);
            await inst.readOne(wrappedAg, true);

            // Hold quota requests for named C, then bare A (same bearer), then bare B:
            writeAg('r55-c@example.com', 'r55-c-1');
            const hC429 = holdOnce('r55-c-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '600' }) }));
            const reqC = inst.readOne(wrappedAg, true);
            await until(() => hC429.release);

            writeAg(undefined, 'r55-a-1');
            const hA429 = holdOnce('r55-a-1', () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }) }));
            const reqA = inst.readOne(wrappedAg, true);
            await until(() => hA429.release);

            writeAg(undefined, 'r55-b-1');
            const hB200 = holdOnce('r55-b-1', quotaAt(0.75));
            const reqB = inst.readOne(wrappedAg, true);
            await until(() => hB200.release);

            // Release A (1s __weak__ gate wipes fetched), advance 2s, release C (armGate deletes expired gate):
            hA429.release();
            await reqA;
            clock += 2_000;
            hC429.release();
            await reqC;
            assert.strictEqual(inst.gate.has('antigravity'), false, 'second late 429 cleared expired __weak__ gate before B published');

            // Add B's email and release B as 200: automatic poll 15s later must NOT send another quota request!
            writeAg('r55-b@example.com', 'r55-b-1');
            hB200.release();
            await reqB;
            assert.strictEqual(asked(sentBearers, 'r55-b-1'), 1, 'B sent one quota request');
            clock += 15_000;
            await inst.readOne(wrappedAg, false);
            assert.strictEqual(asked(sentBearers, 'r55-b-1'), 1, 'automatic poll at +15s respects B five-minute polling floor even when gate was already cleared');
            inst.on['will-quit']();
          } finally {
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }

        // Refreshable Antigravity tokens (refresh_token present): 1-hour access token expiry stays quiet (keeps last
        // good quota bars without "Session expired"), paces credential checks on the 5-minute cadence, releases cached
        // rows across restarts for the same account (never leaking across accounts), retries on mid-flight rotation,
        // and still surfaces 403 permission denials and respects 429 cooldowns.
        {
          let clock = clockWas();
          Date.now = () => clock;
          const permBody = JSON.stringify({ error: { status: 'PERMISSION_DENIED', details: [{ reason: 'SUBSCRIPTION_REQUIRED' }] } });
          try {
            // 1. Idle 1h expiry keeps cached rows quietly, makes 0 network calls, paces cred checks (no 15s spin), and
            // resumes live polling as soon as Antigravity rotates the token.
            {
              let inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-idle@example.com', 'rf-idle-1', { refresh_token: 'rf-idle-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: initial 30%`);
              }

              // Advance past 1h expiry: next tick sees expired refreshable token, makes 0 quota calls, keeps 30% quietly.
              let peeks = 0;
              peekHook = (orig) => (peeks++, orig());
              clock += 3600_000 + 60_000;
              const sentBefore = sentBearers.length;
              await inst.readOne(wrappedAg, false);
              assert.deepStrictEqual([peeks, sentBearers.length], [1, sentBefore], 'checks cred once and sends no quota request');
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs], [undefined, 30, 0], `${where}: keeps 30% with no Session expired`);
              }

              // Subsequent 15s ticks must NOT spin peekCred while still inside the 5-minute cadence.
              clock += 15_000;
              await inst.readOne(wrappedAg, false);
              clock += 60_000;
              await inst.readOne(wrappedAg, false);
              assert.strictEqual(peeks, 1, 'no credential lookup spin between 5-minute checks');

              // After restart with the same expired refreshable token, cached 30% is released (not hidden, not Session expired).
              phone.close();
              inst.flushState();
              inst.on['will-quit']();
              providersMod.clearAntigravityAliases();
              providersMod.clearAntigravityTierGates();
              wrappedAg.onSignedOut();
              inst = loadInstance();
              inst.loadState();
              const phone2 = phoneSees(inst);
              await inst.readOne(wrappedAg, false);
              assert.strictEqual(sentBearers.length, sentBefore, 'restart with expired refreshable token makes no quota request');
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone2.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: restart releases cached 30% quietly`);
              }

              // Antigravity rotates token after 5 minutes -> next automatic tick immediately fetches live 45%.
              writeAg('rf-idle@example.com', 'rf-idle-2', { refresh_token: 'rf-idle-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.55);
              clock += wrappedAg.everyMs;
              await inst.readOne(wrappedAg, false);
              assert.strictEqual(sentBearers.at(-1), 'Bearer rf-idle-2', 'resumes live quota read once token rotates');
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone2.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 45], `${where}: updates to live 45%`);
              }

              // Switching to another account B whose token is already expired (with refresh_token) drops A's 45% without
              // showing Session expired.
              writeAg('rf-other@example.com', 'rf-other-1', { refresh_token: 'rf-other-rt', expiry: '2020-01-01T00:00:00Z' });
              await inst.readOne(wrappedAg, true);
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone2.last()]]) {
                assert.deepStrictEqual([s.error, s.rows.length], [undefined, 0], `${where}: account switch drops old rows without Session expired`);
              }
              peekHook = null;
              phone2.close();
              inst.on['will-quit']();
            }

            // 2. Server 401 on a refreshable token stays quiet; mid-flight token rotation immediately retries with the
            // replacement bearer; mid-flight refresh_token addition/removal aligns with post-fetch credential state.
            {
              const inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-401@example.com', 'rf-401-1', { refresh_token: 'rf-401-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);

              // Same bearer gets 401 -> stays quiet, keeps 30%.
              quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
              await inst.readOne(wrappedAg, true);
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: 401 on refreshable token stays quiet`);
              }

              // Mid-flight rotation while 401 is out -> immediately retries once with rf-401-2 and publishes 60%!
              const h401 = holdOnce('rf-401-1', () => ({ ok: false, status: 401, headers: new Headers() }));
              quotaAnswer = quotaAt(0.4);
              const reqRot = inst.readOne(wrappedAg, true);
              await until(() => h401.release);
              writeAg('rf-401@example.com', 'rf-401-2', { refresh_token: 'rf-401-rt', expiry: new Date(clock + 3600_000).toISOString() });
              h401.release();
              await reqRot;
              assert.strictEqual(sentBearers.at(-1), 'Bearer rf-401-2', 'retries once with rotated bearer after soft 401');
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 60], `${where}: rotated bearer publishes 60%`);
              }

              // Mid-flight refresh_token removal on same bearer while 401 is out -> promotes to hard Session expired.
              const hRem = holdOnce('rf-401-2', () => ({ ok: false, status: 401, headers: new Headers() }));
              const reqRem = inst.readOne(wrappedAg, true);
              await until(() => hRem.release);
              writeAg('rf-401@example.com', 'rf-401-2', { expiry: new Date(clock + 3600_000).toISOString() });
              hRem.release();
              await reqRem;
              assert.match(shown(inst).error || '', /Session expired/, 'removing refresh_token mid-flight promotes 401 to Session expired');

              // Mid-flight refresh_token addition on same bearer while 401 is out -> softens and lifts Session expired.
              const hAdd = holdOnce('rf-401-2', () => ({ ok: false, status: 401, headers: new Headers() }));
              const reqAdd = inst.readOne(wrappedAg, true);
              await until(() => hAdd.release);
              writeAg('rf-401@example.com', 'rf-401-2', { refresh_token: 'rf-401-rt', expiry: new Date(clock + 3600_000).toISOString() });
              hAdd.release();
              await reqAdd;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 60], `${where}: adding refresh_token mid-flight softens 401 and restores 60%`);
              }
              phone.close();
              inst.on['will-quit']();
            }

            // 3. 403 Permission Denied still surfaces and survives local expiry on the same bearer; 429 cooldown holds
            // beside cached rows on local expiry and resumes right as cooldown lifts; lookup error after expiry stays quiet.
            {
              const inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-perm@example.com', 'rf-perm-1', { refresh_token: 'rf-perm-rt', expiry: new Date(clock + 10_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);

              // Lookup failure after local expiry of a refreshable token must NOT replace 30% with Session expired!
              clock += 15_000;
              peekHook = async () => ({ status: 'error', error: 'lookup timed out', soft: true });
              await inst.readOne(wrappedAg, true);
              peekHook = null;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: failed lookup past refreshable expiry keeps 30%`);
              }

              // Fresh token gets 403 Permission Denied -> stays shown even after that bearer expires locally.
              writeAg('rf-perm@example.com', 'rf-perm-2', { refresh_token: 'rf-perm-rt', expiry: new Date(clock + 10_000).toISOString() });
              quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody });
              await inst.readOne(wrappedAg, true);
              assert.match(shown(inst).error || '', /access denied/i, '403 permission denial shows on refreshable token');
              clock += 15_000;
              await inst.readOne(wrappedAg, true);
              assert.match(shown(inst).error || '', /access denied/i, '403 permission denial persists when same bearer expires');

              // Rotating to another expired refreshable bearer lifts the old bearer's 403 and restores cached 30%.
              writeAg('rf-perm@example.com', 'rf-perm-3', { refresh_token: 'rf-perm-rt', expiry: '2020-01-01T00:00:00Z' });
              await inst.readOne(wrappedAg, true);
              assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent], [undefined, 30], 'new bearer lifts old bearer 403');

              // 429 cooldown with expired refreshable token keeps 30% + waitMs > 0, and checks immediately when cooldown lifts.
              writeAg('rf-perm@example.com', 'rf-perm-4', { refresh_token: 'rf-perm-rt', expiry: new Date(clock + 30_000).toISOString() });
              quotaAnswer = quota429; // 120s Retry-After
              await inst.readOne(wrappedAg, true);
              clock += 60_000; // past 30s expiry, still inside 120s cooldown
              await inst.readOne(wrappedAg, false);
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 30, true], `${where}: expired refreshable token during 429 keeps 30% and waitMs`);
              }
              writeAg('rf-perm@example.com', 'rf-perm-5', { refresh_token: 'rf-perm-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.2);
              clock += 60_000; // cooldown just lifted (only 60s since last check, well under 5m!)
              await inst.readOne(wrappedAg, false);
              assert.strictEqual(sentBearers.at(-1), 'Bearer rf-perm-5', 'checks immediately as 429 lifts and fetches with rotated token');
              assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent, shown(inst).waitMs], [undefined, 80, 0]);
              phone.close();
              inst.on['will-quit']();
            }

            // 4. Review fix 1: soft 401s record & sequence bearer rejection before post-fetch lookup, preserve existing
            // 403 permission denials behind newer soft 401s, block older delayed 403s after A -> B -> A, and surface
            // Session expired (including across restart) if refresh_token was removed by a joining check before post-fetch fails.
            {
              // 4a. Hold 401 + Retry-After: 600 on refreshable bearer, remove refresh_token + joining check, fail post-fetch.
              let inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-r1a@example.com', 'rf-r1a-1', { refresh_token: 'rf-r1a-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);

              const h401 = holdOnce('rf-r1a-1', () => ({ ok: false, status: 401, headers: new Headers({ 'retry-after': '600' }) }));
              const req = inst.readOne(wrappedAg, true);
              await until(() => h401.release);
              writeAg('rf-r1a@example.com', 'rf-r1a-1', { expiry: new Date(clock + 3600_000).toISOString() });
              const join = inst.readOne(wrappedAg, true);
              await settle();
              peekHook = async () => ({ status: 'error', error: 'lookup failed', soft: true });
              h401.release();
              await Promise.all([req, join]);
              peekHook = null;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: surfaces Session expired when refresh_token removed before failed post-fetch`);
              }
              // Survives restart during the 600s cooldown:
              phone.close();
              inst.flushState();
              inst.on['will-quit']();
              providersMod.clearAntigravityAliases();
              providersMod.clearAntigravityTierGates();
              wrappedAg.onSignedOut();
              inst = loadInstance();
              inst.loadState();
              await inst.readOne(wrappedAg, false);
              assert.ok(/Session expired/i.test(shown(inst).error || '') && !shown(inst).rows.length, 'persists Session expired across restart during cooldown');
              inst.on['will-quit']();

              // 4b. Delayed 403 permission denial after A -> B -> A cannot overwrite a newer soft 401; existing 403
              // before a newer soft 401 IS preserved.
              const inst2 = fresh();
              writeAg('rf-r1b@example.com', 'rf-r1b-a1', { refresh_token: 'rf-r1b-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst2.readOne(wrappedAg, true);
              const hOld403 = holdOnce('rf-r1b-a1', () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody }));
              const reqOld403 = inst2.readOne(wrappedAg, true);
              await until(() => hOld403.release);
              // Rotate A1 -> A2 -> A1 and get a newer soft 401 on A1:
              writeAg('rf-r1b@example.com', 'rf-r1b-a2', { refresh_token: 'rf-r1b-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.6);
              await inst2.readOne(wrappedAg, true);
              writeAg('rf-r1b@example.com', 'rf-r1b-a1', { refresh_token: 'rf-r1b-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
              await inst2.readOne(wrappedAg, true);
              // Release delayed older 403: must NOT overwrite newer soft 401!
              hOld403.release();
              await reqOld403;
              assert.deepStrictEqual([shown(inst2).error, shown(inst2).rows[0]?.percent], [undefined, 40], 'older delayed 403 cannot overwrite newer soft 401');
              // Existing 403 followed by a newer soft 401 preserves the 403 permission denial:
              quotaAnswer = () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody });
              await inst2.readOne(wrappedAg, true);
              assert.match(shown(inst2).error || '', /access denied/i);
              quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
              await inst2.readOne(wrappedAg, true);
              assert.match(shown(inst2).error || '', /access denied/i, 'newer soft 401 preserves existing 403 permission denial');
              inst2.on['will-quit']();
            }

            // 5. Review fix 2: retain verified bearer & refresh flag through soft expiry so late 403 reconciles
            // immediately and late 401 after failed lookups does not fall back to pre-join non-refreshable cred.
            {
              // 5a. Hold 403, let refreshable bearer expire, force check before releasing 403 -> surfaces 403 immediately.
              const inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-r2a@example.com', 'rf-r2a-1', { refresh_token: 'rf-r2a-rt', expiry: new Date(clock + 5_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);
              const h403 = holdOnce('rf-r2a-1', () => ({ ok: false, status: 403, headers: new Headers(), text: async () => permBody }));
              const req403 = inst.readOne(wrappedAg, true);
              await until(() => h403.release);
              clock += 10_000;
              await inst.readOne(wrappedAg, true); // soft expiry runs applyExpired
              assert.deepStrictEqual([shown(inst).error, shown(inst).rows[0]?.percent], [undefined, 30]);
              h403.release();
              await req403;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.ok(/access denied/i.test(s.error || '') && !s.rows.length, `${where}: late 403 reconciles immediately after soft expiry`);
              }
              phone.close();
              inst.on['will-quit']();

              // 5b. Start without refresh_token, add refresh_token via joining check, expire, fail next two lookups -> late 401 stays quiet!
              const inst2 = fresh();
              const phone2 = phoneSees(inst2);
              writeAg('rf-r2b@example.com', 'rf-r2b-1', { expiry: new Date(clock + 5_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst2.readOne(wrappedAg, true);
              const h401 = holdOnce('rf-r2b-1', () => ({ ok: false, status: 401, headers: new Headers() }));
              const req401 = inst2.readOne(wrappedAg, true);
              await until(() => h401.release);
              writeAg('rf-r2b@example.com', 'rf-r2b-1', { refresh_token: 'rf-r2b-rt', expiry: new Date(clock + 5_000).toISOString() });
              const join = inst2.readOne(wrappedAg, true);
              await settle();
              clock += 10_000;
              peekHook = async () => ({ status: 'error', error: 'lookup failed', soft: true });
              const fail1 = inst2.readOne(wrappedAg, true);
              await settle();
              h401.release();
              await Promise.all([req401, join, fail1]);
              peekHook = null;
              for (const [where, s] of [['snapshot', shown(inst2)], ['desktop', desk(inst2)], ['phone', phone2.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: late 401 after failed lookups honors joined refresh_token`);
              }
              phone2.close();
              inst2.on['will-quit']();
            }

            // 6. Review fix 3: adding refresh_token mid-flight lifts obsolete Session expired even when the quota
            // response is a 503 with Retry-After, restoring cached bars and cooldown countdown.
            {
              const inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-r3@example.com', 'rf-r3-1', { expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);
              quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
              await inst.readOne(wrappedAg, true);
              assert.match(shown(inst).error || '', /Session expired/);

              const h503 = holdOnce('rf-r3-1', () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '120' }) }));
              const req503 = inst.readOne(wrappedAg, true);
              await until(() => h503.release);
              writeAg('rf-r3@example.com', 'rf-r3-1', { refresh_token: 'rf-r3-rt', expiry: new Date(clock + 3600_000).toISOString() });
              h503.release();
              await req503;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 30, true], `${where}: 503 with Retry-After after adding refresh_token lifts Session expired and shows cooldown`);
              }
              phone.close();
              inst.on['will-quit']();
            }

            // 7. Review fix 4: prior non-bearer error ("No usage windows reported.") restores verified same-account
            // cache on both soft-expiry paths (HTTP 401 and local expiry).
            {
              const inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-r4@example.com', 'rf-r4-1', { refresh_token: 'rf-r4-rt', expiry: new Date(clock + 10_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);

              // Empty groups -> "No usage windows reported.", then soft HTTP 401 -> restores cached 30%!
              quotaAnswer = () => ({ ok: true, json: async () => ({ groups: [] }) });
              await inst.readOne(wrappedAg, true);
              assert.match(shown(inst).error || '', /No usage windows/);
              quotaAnswer = () => ({ ok: false, status: 401, headers: new Headers() });
              await inst.readOne(wrappedAg, true);
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: soft 401 restores same-account cache over empty-groups error`);
              }

              // Empty groups again, then local expiry -> restores cached 30%!
              quotaAnswer = () => ({ ok: true, json: async () => ({ groups: [] }) });
              await inst.readOne(wrappedAg, true);
              assert.match(shown(inst).error || '', /No usage windows/);
              clock += 15_000;
              await inst.readOne(wrappedAg, true);
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: local soft expiry restores same-account cache over empty-groups error`);
              }

              // Re-check fix 1a: failed credential lookup after refreshable bearer expires also restores cached 30% over empty-groups error.
              writeAg('rf-r4@example.com', 'rf-r4-2', { refresh_token: 'rf-r4-rt', expiry: new Date(clock + 10_000).toISOString() });
              quotaAnswer = () => ({ ok: true, json: async () => ({ groups: [] }) });
              await inst.readOne(wrappedAg, true);
              assert.match(shown(inst).error || '', /No usage windows/);
              clock += 15_000;
              peekHook = async () => ({ status: 'error', error: 'lookup timed out', soft: true });
              await inst.readOne(wrappedAg, true);
              peekHook = null;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: failed lookup past refreshable expiry restores same-account cache over empty-groups error`);
              }

              // Re-check fix 1b: in-flight 503 with Retry-After whose post-fetch lookup fails after refreshable expiry
              // restores cached 30% over empty-groups error and shows cooldown.
              writeAg('rf-r4@example.com', 'rf-r4-3', { refresh_token: 'rf-r4-rt', expiry: new Date(clock + 10_000).toISOString() });
              quotaAnswer = () => ({ ok: true, json: async () => ({ groups: [] }) });
              await inst.readOne(wrappedAg, true);
              assert.match(shown(inst).error || '', /No usage windows/);
              const h503 = holdOnce('rf-r4-3', () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '120' }) }));
              const req503 = inst.readOne(wrappedAg, true);
              await until(() => h503.release);
              clock += 15_000;
              peekHook = async () => ({ status: 'error', error: 'lookup timed out', soft: true });
              h503.release();
              await req503;
              peekHook = null;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.waitMs > 0], [undefined, 30, true], `${where}: 503 + failed post-fetch past refreshable expiry restores cache and arms cooldown`);
              }
              phone.close();
              inst.on['will-quit']();
            }

            // 8. Re-check fix 2: skipping a duplicate quota request after another read just published still saves
            // newly verified refresh_token metadata onto activeToken so later expiry + lookup timeout stays quiet.
            {
              const inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-r8@example.com', 'rf-r8-1', { expiry: new Date(clock + 10_000).toISOString() });
              const h200 = holdOnce('rf-r8-1', quotaAt(0.7));
              const req1 = inst.readOne(wrappedAg, true);
              await until(() => h200.release);

              // Start a manual refresh whose first peekCred is held while req1 finishes and publishes 30%.
              let releasePeek1;
              let peekCount = 0;
              peekHook = (orig) => {
                peekCount++;
                if (peekCount === 1) return new Promise((r) => (releasePeek1 = () => r(orig())));
                return orig();
              };
              const req2 = inst.readOne(wrappedAg, true);
              await until(() => releasePeek1);
              h200.release();
              await req1;
              // Add refresh_token before req2 rechecks (attempt 1) and skips duplicate fetch:
              writeAg('rf-r8@example.com', 'rf-r8-1', { refresh_token: 'rf-r8-rt', expiry: new Date(clock + 10_000).toISOString() });
              releasePeek1();
              await req2;
              peekHook = null;

              // Expire the bearer and fail the next lookup -> must keep 30%, NOT show Session expired!
              clock += 15_000;
              peekHook = async () => ({ status: 'error', error: 'lookup timed out', soft: true });
              await inst.readOne(wrappedAg, true);
              peekHook = null;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows[0]?.percent], [undefined, 30], `${where}: duplicate-skip refresh saves newly verified refresh_token`);
              }
              phone.close();
              inst.on['will-quit']();
            }

            // 9. Round 3 fix 1: late 503 with failed post-fetch lookup must NOT undo confirmed hard Session expired
            // after refresh_token was removed via a joining check and a failed lookup triggered expireActiveToken.
            {
              const inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-r9@example.com', 'rf-r9-1', { refresh_token: 'rf-r9-rt', expiry: new Date(clock + 10_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);

              // Hold 503 + Retry-After: 120, remove refresh_token, force joining check to record hasRefresh: false:
              const h503 = holdOnce('rf-r9-1', () => ({ ok: false, status: 503, headers: new Headers({ 'retry-after': '120' }) }));
              const req503 = inst.readOne(wrappedAg, true);
              await until(() => h503.release);
              writeAg('rf-r9@example.com', 'rf-r9-1', { expiry: new Date(clock + 10_000).toISOString() });
              const join = inst.readOne(wrappedAg, true);
              await settle();

              // Advance past expiry and fail another lookup -> UI shows hard Session expired:
              clock += 15_000;
              peekHook = async () => ({ status: 'error', error: 'lookup timed out', soft: true });
              const failExp = inst.readOne(wrappedAg, true);
              await until(() => /Session expired/i.test(shown(inst).error || ''));
              assert.ok(/Session expired/i.test(shown(inst).error || '') && !shown(inst).rows.length && shown(inst).waitMs === 0);

              // Release 503 with post-fetch lookup also failing -> must STAY Session expired with waitMs === 0!
              h503.release();
              await Promise.all([req503, join, failExp]);
              peekHook = null;
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.ok(/Session expired/i.test(s.error || '') && !s.rows.length && s.waitMs === 0, `${where}: late 503 with failed post-fetch does not undo confirmed hard Session expired`);
              }
              phone.close();
              inst.on['will-quit']();
            }

            // 10. Round 3 fix 2: blank/whitespace refresh_token never links distinct accounts or leaks cached quota,
            // and saved state.json alias groups / cache entries tainted by a blank-token key are invalidated on load.
            {
              const inst = fresh();
              const phone = phoneSees(inst);
              writeAg('rf-blank-a@example.com', 'rf-blank-a1', { refresh_token: ' ', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);
              writeAg('rf-blank-b@example.com', 'rf-blank-b1', { refresh_token: ' ', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.4);
              await inst.readOne(wrappedAg, true);
              writeAg('rf-blank-a@example.com', 'rf-blank-a1', { refresh_token: ' ', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.7);
              await inst.readOne(wrappedAg, true);
              assert.strictEqual(shown(inst).rows[0]?.percent, 30, 'A quota cached at 30%');

              // Switch to B with a real refresh_token and an already-expired expiry: must NOT show A's 30%!
              writeAg('rf-blank-b@example.com', 'rf-blank-b1', { refresh_token: 'rf-blank-b-rt', expiry: '2020-01-01T00:00:00Z' });
              const sentBefore = sentBearers.length;
              await inst.readOne(wrappedAg, true);
              assert.strictEqual(sentBearers.length, sentBefore, 'expired refreshable B makes no network call');
              for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                assert.deepStrictEqual([s.error, s.rows.length], [undefined, 0], `${where}: B does not inherit A quota through blank refresh_token`);
              }
              phone.close();
              inst.on['will-quit']();

              // Round 4 fixes 1 & 2: legacy state.json (no antigravityIdentityVersion) with arbitrary whitespace-only
              // refresh token (" \t ") linking A and B plus A's cached quota and quota/tier cooldowns discards all
              // legacy Antigravity cache, identity links, and cooldowns on upgrade so B neither inherits A's bars nor
              // waits on A's cooldowns.
              const hashA = keyOf('rf-leg-a@example.com');
              const hashB = keyOf('rf-leg-b@example.com');
              const hashWeirdBlank = keyOf(' \t ');
              const { antigravityIdentityVersion: _v, ...legacyBase } = clean;
              const legacyState = {
                ...legacyBase,
                cache: { antigravity: { plan: 'AI Pro', rows: [{ label: 'Gemini 5h', percent: 30, resetsAt: null }], renewsFor: hashA, gateKeys: [hashA, hashWeirdBlank, `tok:${keyOf('rf-leg-a1')}`, hashB, `tok:${keyOf('rf-leg-b1')}`], updatedAt: clock } },
                accountLinks: { antigravity: [[hashA, hashWeirdBlank, `tok:${keyOf('rf-leg-a1')}`, hashB, `tok:${keyOf('rf-leg-b1')}`]] },
                accountGates: { antigravity: [{ until: clock + 600_000, keys: [hashA, hashWeirdBlank, hashB, `tok:${keyOf('rf-leg-b1')}`], origin: [hashA, hashWeirdBlank, hashB] }] },
                tierGates: { antigravity: [{ until: clock + 600_000, keys: [hashA, hashWeirdBlank, hashB, `tok:${keyOf('rf-leg-b1')}`], origin: [hashA, hashWeirdBlank, hashB] }] },
                signedIn: { antigravity: hashA },
              };
              fs.writeFileSync(statePathR15, JSON.stringify(legacyState));
              providersMod.clearAntigravityAliases();
              providersMod.clearAntigravityTierGates();
              wrappedAg.onSignedOut();
              const inst2 = loadInstance();
              inst2.loadState();
              writeAg('rf-leg-b@example.com', 'rf-leg-b1', { refresh_token: 'rf-leg-b-rt', expiry: '2020-01-01T00:00:00Z' });
              await inst2.readOne(wrappedAg, true);
              assert.deepStrictEqual([shown(inst2).error, shown(inst2).rows.length, shown(inst2).waitMs], [undefined, 0, 0], 'legacy arbitrary-whitespace cache, links, and cooldowns are discarded on upgrade');
              // Valid B token immediately queries quota AND tier without being held by A's old cooldowns:
              writeAg('rf-leg-b@example.com', 'rf-leg-b2', { refresh_token: 'rf-leg-b-rt', expiry: new Date(clock + 3600_000).toISOString() });
              quotaAnswer = quotaAt(0.5);
              const tierBeforeLeg = tierBearers.length;
              await inst2.readOne(wrappedAg, true);
              await settle();
              assert.strictEqual(sentBearers.at(-1), 'Bearer rf-leg-b2', 'B is not blocked by legacy A quota cooldown');
              assert.strictEqual(tierBearers.length, tierBeforeLeg + 1, 'B is not blocked by legacy A tier cooldown');
              inst2.on['will-quit']();

              // Defense in depth on v2 state: a cooldown record contaminated by a blank-token key (" ") is completely
              // removed from both quota and tier cooldown lists instead of becoming an ownerless gate that blocks B.
              const hashSpace = keyOf(' ');
              const v2Contam = {
                ...clean,
                antigravityIdentityVersion: 2,
                accountLinks: { antigravity: [[hashA, hashSpace, hashB]] },
                accountGates: { antigravity: [{ until: clock + 600_000, keys: [hashA, hashSpace, hashB, `tok:${keyOf('rf-v2-b1')}`], origin: [hashA, hashSpace, hashB] }] },
                tierGates: { antigravity: [{ until: clock + 600_000, keys: [hashA, hashSpace, hashB, `tok:${keyOf('rf-v2-b1')}`], origin: [hashA, hashSpace, hashB] }] },
              };
              fs.writeFileSync(statePathR15, JSON.stringify(v2Contam));
              providersMod.clearAntigravityAliases();
              providersMod.clearAntigravityTierGates();
              wrappedAg.onSignedOut();
              const inst3 = loadInstance();
              inst3.loadState();
              writeAg('rf-leg-b@example.com', 'rf-v2-b1', { refresh_token: 'rf-v2-b-rt', expiry: new Date(clock + 3600_000).toISOString() });
              const tierBeforeV2 = tierBearers.length;
              await inst3.readOne(wrappedAg, true);
              await settle();
              assert.strictEqual(sentBearers.at(-1), 'Bearer rf-v2-b1', 'purged blank-token quota cooldown does not block B');
              assert.strictEqual(tierBearers.length, tierBeforeV2 + 1, 'purged blank-token tier cooldown does not block B');
              assert.strictEqual(shown(inst3).waitMs, 0);
              inst3.on['will-quit']();
            }

            // 11. Round 3 fix 3 & Round 4 fix 3: an unexpired joining check immediately clears a local Session expired
            // note, restores verified same-account cached bars, and renames cache so a background tier upgrade folds in
            // immediately even when the joining credential drops id_token_email.
            {
              const inst = fresh();
              const phone = phoneSees(inst);
              const savedTierAns = tierAnswer;
              try {
                tierAnswer = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
                writeAg('rf-r11@example.com', 'rf-r11-0', { refresh_token: 'rf-r11-rt', expiry: new Date(clock + 3600_000).toISOString() });
                quotaAnswer = quotaAt(0.7);
                await inst.readOne(wrappedAg, true);
                await settle();
                await inst.readOne(wrappedAg, false);
                assert.strictEqual(shown(inst).plan, 'AI Pro', 'initial cached plan is AI Pro');

                // Rotate bearer (without refresh_token), hold quota request, and let its tier lookup return AI Ultra:
                tierAnswer = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } }) });
                writeAg('rf-r11@example.com', 'rf-r11-1', { expiry: new Date(clock + 10_000).toISOString() });
                const hSlow = holdOnce('rf-r11-1', quotaAt(0.5));
                const reqSlow = inst.readOne(wrappedAg, true);
                await until(() => hSlow.release);
                await settle(); // background loadCodeAssist settles with AI Ultra while quota is still held

                // Let bearer expire, fail refresh lookup -> local Session expired shows:
                clock += 15_000;
                peekHook = async () => ({ status: 'error', error: 'lookup timed out', soft: true });
                const reqFail = inst.readOne(wrappedAg, true);
                await until(() => /Session expired/i.test(shown(inst).error || ''));
                peekHook = null;

                // Update same bearer with future expiry + refresh_token and NO email -> joining check immediately clears
                // Session expired, restores cached 30%, AND folds AI Ultra BEFORE hSlow is released!
                writeBare({ access_token: 'rf-r11-1', refresh_token: 'rf-r11-rt', expiry: new Date(clock + 3600_000).toISOString() });
                const reqJoin = inst.readOne(wrappedAg, true);
                await until(() => !shown(inst).error && shown(inst).rows[0]?.percent === 30);
                for (const [where, s] of [['snapshot', shown(inst)], ['desktop', desk(inst)], ['phone', phone.last()]]) {
                  assert.deepStrictEqual([s.error, s.rows[0]?.percent, s.plan], [undefined, 30, 'AI Ultra'], `${where}: unexpired email-less join clears Session expired and folds AI Ultra immediately`);
                }
                hSlow.release();
                await Promise.all([reqSlow, reqFail, reqJoin]);
              } finally {
                tierAnswer = savedTierAns;
              }
              phone.close();
              inst.on['will-quit']();
            }
          } finally {
            peekHook = null;
            Date.now = clockWas;
            quotaAnswer = quotaAt(0.5);
          }
        }
      } finally {
        Date.now = clockWas;
        global.fetch = savedFetchR15;
        fs.writeFileSync(statePathR15, stateBefore);
        providersMod.clearAntigravityTierGates();
        wrappedAg.restoreTierGates(tierBefore);
      }
    }

    // Round 6 Fix 4: Failed post-fetch credential check holds background loadCodeAssist tier updates until credentials are confirmed.
    {
      writeAg('acct-tier-hold@example.com', 'tok-th-1');
      agAssist = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
      agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.4, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
      await readOne(wrappedAg, true);
      await new Promise((r) => setImmediate(r));
      await readOne(wrappedAg, false);
      assert.strictEqual(last.get('antigravity').plan, 'AI Pro');
      // Rotate token so loadCodeAssist runs again (held, upgrading to AI Ultra), and make post-fetch peekCred time out!
      writeAg('acct-tier-hold@example.com', 'tok-th-2');
      let releaseBgTier;
      agAssist = () => new Promise((r) => (releaseBgTier = () => r({ ok: true, json: async () => ({ paidTier: { id: 'g1-ultra-lite-tier', name: 'Google AI Ultra' } }) })));
      let step = 0;
      peekHook = (orig) => (++step === 2 ? Promise.resolve({ status: 'error', error: 'timeout', soft: true }) : orig());
      await readOne(wrappedAg, true);
      peekHook = null;
      assert.ok(releaseBgTier, 'background loadCodeAssist started');
      releaseBgTier();
      await new Promise((r) => setImmediate(r));
      // Next non-forced tick runs during credRetryAt backoff: MUST NOT fold or save the unconfirmed tier!
      await readOne(wrappedAg, false);
      assert.strictEqual(last.get('antigravity').plan, 'AI Pro', 'tier update is held while credential check is backed off');
      assert.strictEqual(savedCache().antigravity.plan, 'AI Pro', 'and is not written to disk cache');
      // Even a forced refresh whose peekCred still fails must NOT fold the tier.
      peekHook = async () => ({ status: 'error', error: 'timeout', soft: true });
      await readOne(wrappedAg, true);
      peekHook = null;
      assert.strictEqual(last.get('antigravity').plan, 'AI Pro', 'tier update stays held while peekCred fails');
      // Once a credential check succeeds for the same account, the tier folds in!
      await readOne(wrappedAg, true);
      assert.strictEqual(last.get('antigravity').plan, 'AI Ultra', 'tier folds in once credentials confirm the account');
      agAssist = () => ({ ok: true, json: async () => ({ paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }) });
    }

    // Back to B at 5% for startup tests.
    writeAg('acct-b@example.com', 'tok-b');
    agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
    await readOne(wrappedAg, true);

    // Startup cache verification: reloading state.json hides Antigravity in snapshot AND phone /api/events until credentials confirm the account!
    flushState();
    loadState();
    const restored = snapshot().find((p) => p.id === 'antigravity');
    assert.deepStrictEqual([restored.rows.length, restored.plan], [0, undefined], 'startup hides unverified Antigravity cache from snapshot');
    let firstEvent = '';
    let closeEvt;
    phoneHandler(
      { method: 'GET', url: '/api/events', headers: { host: 'localhost' }, on: (_, fn) => (closeEvt = fn) },
      { writeHead() { return this; }, write(c) { if (!firstEvent) firstEvent = c; }, end() {} }
    );
    const evtAg = JSON.parse(firstEvent.slice(6)).providers.find((p) => p.id === 'antigravity');
    assert.deepStrictEqual([evtAg.rows.length, evtAg.plan], [0, undefined], 'phone /api/events never gets unverified previous-account data on startup');
    closeEvt();

    // Startup with matching locally EXPIRED token must NEVER flash cached rows before reporting session expiry!
    writeAg('acct-b@example.com', 'tok-b', { expiry: '2020-01-01T00:00:00Z' });
    sent.length = 0;
    await readOne(wrappedAg, true);
    const dataPushes = sent.filter(([ch]) => ch === 'data').map(([, d]) => d.find((p) => p.id === 'antigravity'));
    assert.ok(dataPushes.every((p) => p.rows.length === 0), 'matching expired token at startup never flashes cached rows');
    assert.match(last.get('antigravity').error, /Session expired/);

    // Restore valid token for B and confirm cached rows resume cleanly; also verify failed credential lookups on
    // unverified startup cache throttle retries while keeping cached rows hidden!
    writeAg('acct-b@example.com', 'tok-b');
    loadState();
    peekHook = async () => ({ status: 'error', error: 'Antigravity credential lookup timed out', soft: true });
    const peeksBeforeErr = peekCalls;
    await readOne(wrappedAg, false);
    assert.strictEqual(peekCalls, peeksBeforeErr + 1, 'initial unverified startup tick runs peekCred once');
    assert.strictEqual(snapshot().find((p) => p.id === 'antigravity').rows.length, 0, 'failed lookup keeps unverified startup rows hidden');
    await readOne(wrappedAg, false);
    await readOne(wrappedAg, false);
    assert.strictEqual(peekCalls, peeksBeforeErr + 1, 'consecutive non-forced reads after a failed lookup do NOT immediately relaunch peekCred');
    peekHook = null;
    await readOne(wrappedAg, true);
    assert.strictEqual(snapshot().find((p) => p.id === 'antigravity').rows[0].percent, 5);

    // B hits 429 -> B -> C succeeds -> C -> B inside B's 120s window STILL enforces B's persisted gate!
    agQuota = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
    await readOne(wrappedAg, true);
    assert.ok(gate.get('antigravity') > Date.now() + 100_000, 'account B is gated');
    const callsWhileGated = agQuotaCalls;
    // Non-forced ticks inside the 60s credential-check cadence do NOT invoke peekCred repeatedly.
    const peeksWhileGated = peekCalls;
    await readOne(wrappedAg, false);
    await readOne(wrappedAg, false);
    assert.strictEqual(peekCalls, peeksWhileGated, 'gated non-forced ticks respect the 60s credential-check cadence');
    await readOne(wrappedAg, true);
    assert.strictEqual(agQuotaCalls, callsWhileGated, 'same account B stays gated on manual refresh');
    writeAg('acct-c@example.com', 'tok-c');
    agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
    await readOne(wrappedAg, true);
    assert.strictEqual(agQuotaCalls, callsWhileGated + 1, 'switching to account C is not blocked by B\'s 429 gate');
    assert.strictEqual(last.get('antigravity').rows[0].percent, 30);
    writeAg('acct-b@example.com', 'tok-b');
    const callsBeforeBackToB = agQuotaCalls;
    await readOne(wrappedAg, true);
    assert.strictEqual(agQuotaCalls, callsBeforeBackToB, 'switching B -> C -> B still enforces B\'s unexpired 429 deadline');
    assert.ok(gate.get('antigravity') > Date.now() + 100_000);

    // Access-token-only 429 stays gated across token rotation, when a refresh_token is added to the ROTATED weak
    // token, AND after a fresh process restart (persisted alias promotion)!
    fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'weak-tok-1', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
    agQuota = () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }) });
    await readOne(wrappedAg, true);
    const callsAfterWeak429 = agQuotaCalls;
    fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'weak-tok-2', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
    await readOne(wrappedAg, true);
    assert.strictEqual(agQuotaCalls, callsAfterWeak429, 'rotating an access-token-only credential does not bypass its 429 gate');
    // Adding refresh_token to the ROTATED weak-tok-2 inherits its carried bearer alias and promotes onto the strong account key!
    fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'weak-tok-2', refresh_token: 'rt-added', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
    await readOne(wrappedAg, true);
    assert.strictEqual(agQuotaCalls, callsAfterWeak429, 'adding refresh_token to the rotated weak token stays gated');
    flushState();
    // Restart a fresh main.js instance with a new access token + same refresh_token: promoted strong gate survived restart!
    // A real restart forgets which keys are linked, so this one does too: only what state.json kept may hold it back.
    providersMod.clearAntigravityAliases();
    providersMod.clearAntigravityTierGates();
    const restartedGate = loadInstance();
    restartedGate.loadState();
    fs.writeFileSync(agMainAuth, JSON.stringify({ token: { access_token: 'weak-tok-3', refresh_token: 'rt-added', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
    await restartedGate.readOne(wrappedAg, true);
    assert.strictEqual(agQuotaCalls, callsAfterWeak429, 'promoted strong account gate survives restart and access-token rotation');
    restartedGate.on['will-quit']();

    // Sign-out clears live rows, saved cache, AND any active desktop reset notice; repeated signed-out ticks stay throttled and don't rewrite state.json.
    writeAg('acct-c@example.com', 'tok-c');
    agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.2, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
    await readOne(wrappedAg, true);
    agQuota = () => ({ ok: true, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: '2026-11-20T02:01:25Z' }] }] }) });
    await readOne(wrappedAg, true);
    sent.length = 0;
    fs.rmSync(agMainAuth, { force: true });
    await readOne(wrappedAg, true);
    assert.match(last.get('antigravity').error, /No Antigravity credentials/);
    assert.strictEqual(savedCache().antigravity, undefined);
    assert.ok(sent.some(([ch, v]) => ch === 'reset' && v === null), 'sign-out clears the desktop reset notice');
    flushState();
    assert.strictEqual(saved().cache?.antigravity, undefined);
    const peeksAfterSignOut = peekCalls;
    await readOne(wrappedAg, false);
    await readOne(wrappedAg, false);
    assert.strictEqual(peekCalls, peeksAfterSignOut, 'signed-out non-forced ticks respect cadence instead of spawning on every tick');
    const mtimeBefore = fs.statSync(path.join(dir, 'state.json')).mtimeMs;
    await new Promise((r) => setTimeout(r, 25));
    await readOne(wrappedAg, true);
    flushState();
    assert.strictEqual(fs.statSync(path.join(dir, 'state.json')).mtimeMs, mtimeBefore, 'unchanged signed-out re-check does not rewrite state.json');

    // /api/options exposes Antigravity only to clients requesting ?toggle=1; /api/settings validates toggleProvider;
    // legacy whole-list writes neither disable nor re-enable unmanaged providers (Antigravity) even after /api/options or restart!
    const legacyOpts = JSON.parse((await ask('GET', '/api/options')).body);
    assert.ok(!legacyOpts.providers.some((p) => p.id === 'antigravity'), 'bare /api/options omits Antigravity from legacy clients that cannot toggle it');
    assert.strictEqual(legacyOpts.choices.antigravity, undefined, 'and omits Antigravity choices for legacy clients');
    assert.strictEqual(legacyOpts.pages.antigravity, undefined, 'and omits Antigravity usage page for legacy clients');
    const optsResp = JSON.parse((await ask('GET', '/api/options?toggle=1')).body);
    assert.strictEqual(optsResp.capabilities?.toggleProvider, true, '/api/options?toggle=1 advertises toggleProvider support');
    assert.ok(optsResp.providers.some((p) => p.id === 'antigravity'), '/api/options?toggle=1 exposes Antigravity to toggle-capable clients');
    assert.strictEqual(optsResp.pages.antigravity, 'https://antigravity.google.com/remote?settingsOpen=true&settingsScreen=General', '/api/options?toggle=1 exposes Antigravity usage page');
    assert.ok(optsResp.providers.every((p) => typeof p.color2 === 'string' && p.color2), "and each provider's bar's second stop");
    for (const bad of [null, [], 'codex', { id: 1, enabled: true }, { id: 'codex', enabled: 'yes' }]) {
      assert.strictEqual((await ask('POST', '/api/settings', JSON.stringify({ toggleProvider: bad }))).status, 400);
    }
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ enabled: ['claude', 'codex', 'opencode-go', 'xai', 'cpu', 'ram'], known: ['claude', 'codex', 'opencode-go', 'xai', 'cpu', 'ram'] }));
    loadState();
    // Unrelated /api/options call must NOT allow a legacy APK whole-list write to silently disable Antigravity.
    await ask('GET', '/api/options?toggle=1');
    const legacyAfterOpts = await ask('POST', '/api/settings', JSON.stringify({ enabled: ['claude', 'opencode-go', 'xai', 'cpu', 'ram'] }));
    assert.ok(JSON.parse(legacyAfterOpts.body).enabled.includes('antigravity'), 'legacy whole-list write after unrelated /api/options still preserves Antigravity');
    assert.ok(!JSON.parse(legacyAfterOpts.body).enabled.includes('codex'), 'legacy whole-list write still applies to Codex');
    // Hybrid payload (updated APK before new options arrive): toggleProvider takes precedence and companion enabled is ignored.
    const hybrid = await ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'codex', enabled: true }, enabled: ['claude', 'codex'] }));
    assert.ok(JSON.parse(hybrid.body).enabled.includes('codex') && JSON.parse(hybrid.body).enabled.includes('antigravity'), 'toggleProvider ignores companion legacy enabled list');
    flushState();
    // Fresh-process restart loading persisted state.json (where antigravity is already in `known`): legacy write STILL preserves Antigravity!
    const restarted = loadInstance();
    restarted.loadState();
    const legacyAfterRestart = await restarted.ask('POST', '/api/settings', JSON.stringify({ enabled: ['claude', 'codex', 'opencode-go', 'xai', 'cpu', 'ram'] }));
    assert.ok(JSON.parse(legacyAfterRestart.body).enabled.includes('antigravity'), 'legacy whole-list write after a fresh PC restart still preserves Antigravity');
    const explicitDisable = await restarted.ask('POST', '/api/settings', JSON.stringify({ toggleProvider: { id: 'antigravity', enabled: false } }));
    assert.ok(!JSON.parse(explicitDisable.body).enabled.includes('antigravity'), 'toggleProvider can explicitly disable Antigravity');
    // A stale legacy whole-list write that still includes Antigravity MUST NOT re-enable an explicitly disabled Antigravity!
    const staleReenable = await restarted.ask('POST', '/api/settings', JSON.stringify({ enabled: ['claude', 'codex', 'opencode-go', 'xai', 'antigravity', 'cpu', 'ram'] }));
    assert.ok(!JSON.parse(staleReenable.body).enabled.includes('antigravity'), 'legacy whole-list write never re-enables explicitly disabled Antigravity');
    const knownEnable = await restarted.ask('POST', '/api/settings', JSON.stringify({ enabled: ['claude', 'codex', 'opencode-go', 'xai', 'antigravity', 'cpu', 'ram'], known: ['claude', 'codex', 'opencode-go', 'xai', 'antigravity', 'cpu', 'ram'] }));
    assert.ok(JSON.parse(knownEnable.body).enabled.includes('antigravity'), 'whole-list write with explicit known catalog manages Antigravity too');
    restarted.on['will-quit']();
    on['will-quit']();
  } finally {
    global.fetch = originalFetch;
    if (savedAgEnv === undefined) delete process.env.ANTIGRAVITY_AUTH_FILE;
    else process.env.ANTIGRAVITY_AUTH_FILE = savedAgEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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
  const N = require('./providers').PROVIDERS.length;
  for (const [e, s] of [['top', 1.25], ['bottom', 1.25], ['top', 1], ['top', 0.68]]) {
    set(e, s);
    assert.ok(windowSize().width <= 600, `${N} chips on the ${e} edge at Size ${s} fit a 600px display, not ${windowSize().width}px`);
    assert.strictEqual(panelScale(), Math.max(1, s), 'the panel keeps its zoom');
  }
  set('top', 1.25);
  assert.ok(pillScale() < 1.25 && pillScale() > 0.68, `Extra large shrinks the pill just enough, to ${pillScale()}`);
  set('top', 0.68);
  assert.strictEqual(pillScale(), 0.68, 'Small fits, so it stays Small');
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
  assert.strictEqual(bounds.width, Math.ceil(N * 88 * 1.25 + 32), 'on a wide display, Extra large');
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
  // Round 55 Fix 2: on a short 320px-tall work area, a side-docked pill shrinks to fit all N chips without clipping.
  for (const e of ['right', 'left']) {
    set(e, 1.25);
    display.workArea.height = 320;
    events['display-metrics-changed']();
    assert.ok(pillScale() < 1.25 && N * 56 * pillScale() + 32 <= 320 && panelScale() === 1.25, `${e} edge on a 320px-tall display shrinks pillScale (${pillScale()}) so all ${N} chips fit`);
    assert.ok(bounds.height <= 320 && sent.at(-1)[0] === 'layout' && sent.at(-1)[1].scale === pillScale(), `${e} edge sends shrunk pill scale to renderer`);
  }
  display.workArea.height = 1000;
  set('top', 1.25);
  // On a second monitor, which is unplugged and then plugged back in: the primary meanwhile, then its own again.
  const second = { id: 2, workArea: { x: 600, y: 0, width: 1920, height: 1080 } };
  displays.push(second);
  setDisplay(2);
  events['display-added']();
  assert.ok(bounds.x >= 600 && bounds.width === Math.ceil(N * 88 * 1.25 + 32), `placed on the second, wide display: ${JSON.stringify(bounds)}`);
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
