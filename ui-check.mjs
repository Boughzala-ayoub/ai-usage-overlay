import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

// Drives index.html in headless Chrome with a fake window.api, the same messages main sends.
const require = createRequire(import.meta.url);
const THEMES = require('./themes.js').flatMap(([, list]) => list);
const base = process.env.UI_BASE || pathToFileURL(path.resolve('index.html')).href;
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shots = path.join(os.tmpdir(), 'ai-usage-overlay-ui');
const themes = process.env.UI_THEME ? THEMES.filter(([id]) => process.env.UI_THEME.split(',').includes(id)) : THEMES;
const edges = ['left', 'right', 'top', 'bottom'];
const states = ['hidden', 'rest', 'open', 'reset', 'codex', 'codex-zero', 'codex-offline', 'codex-expiry-missing', 'codex-multiple', 'claude-banked', 'claude-credit', 'claude-credit-stale', 'claude-credit-lapsed', 'claude-credit-expired', 'warning', 'limited', 'limited-one', 'error', 'xai-unavailable', 'loading', 'long', 'refreshing'];
const shows = ['hidden', 'rest', 'open', 'reset']; // what every theme is checked in
const viewports = [320, 375, 768, 1024, 1280].map((width) => ({ width, height: 700 }));
// The native windows at Size = Large for the six providers below, each only on the edges main gives that shape.
// From main.js's windowSize(): beside the pill 8 + 86 + 300 + 16 by max(6 × 56, 600) + 32, above or below it
// max(6 × 88, 300) + 32 by 8 + 60 + 600 + 16.
const NATIVE = { left: 410, right: 410, top: 560, bottom: 560 };
viewports.push({ width: 410, height: 632, edges: ['left', 'right'] }, { width: 560, height: 684, edges: ['top', 'bottom'] });
// Extra large on a 600px portrait monitor: main shrinks the pill to fit (pillScale: (600 - 32) / (6 × 88)) and keeps
// the panel's 1.25, in a window of 600 by 8 + 60 × that + 600 × 1.25 + 16.
const XL = (600 - 32) / (6 * 88);
viewports.push({ width: 600, height: Math.ceil(8 + 60 * XL + 750 + 16), edges: ['top', 'bottom'], scale: XL, panel: 1.25 });
// Extra large on a display 600px tall: main stops the window at the display's height (windowSize), and the panel's rows
// scroll. Beside the pill the window is 8 + 86 × 1.25 + 300 × 1.25 + 16 wide; above or below it, the 600px display's width.
viewports.push({ width: Math.ceil(8 + 86 * 1.25 + 375 + 16), height: 600, edges: ['left', 'right'], scale: 1.25, panel: 1.25 }, { width: 600, height: 600, edges: ['top', 'bottom'], scale: XL, panel: 1.25 });
const data = [
  {
    id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', plan: 'Max 5x', ringPercent: 37,
    rows: [
      { label: 'Session', percent: 37, resets: 'in 2h 10m' },
      { label: 'All models', percent: 14, resets: 'in 3d 4h' },
      { label: 'Fable', percent: 8, resets: 'in 3d 4h' },
    ],
    updatedAt: Date.now(),
  },
  {
    id: 'codex', name: 'Codex', glyph: '◉', color: '#10a37f', plan: 'Pro Lite', ringPercent: 4,
    bankedResets: 1,
    bankedResetExpiries: [Date.parse('2026-10-04T05:36:14Z')],
    rows: [{ label: 'Weekly', percent: 4, resets: 'in 6d 2h' }],
    updatedAt: Date.now(),
  },
  {
    id: 'opencode-go', name: 'OpenCode Go', glyph: '▣', color: '#fab283', plan: 'Go', ringPercent: 33,
    rows: [
      { label: '5h limit', percent: 18, resets: 'in 3h 5m' },
      { label: 'Weekly', percent: 33, resets: 'in 4d 1h' },
      { label: 'Monthly', percent: 9, resets: 'in 21d 3h' },
    ],
    updatedAt: Date.now(),
  },
  {
    // xAI's mark is monochrome, so it takes the theme's ink, in every theme.
    id: 'xai', name: 'xAI', glyph: '✕', color: 'var(--fg)', plan: '', ringPercent: 42.5,
    rows: [{ label: 'Weekly', percent: 42.5, resets: 'in 5d 6h' }, { label: 'Monthly', percent: 25, resets: 'in 18d 12h' }],
    updatedAt: Date.now(),
  },
  // This PC: a long CPU model in the plan tag, and RAM's GB in the reset column.
  { id: 'cpu', name: 'CPU', glyph: '▦', color: '#5b9cf5', plan: 'AMD Ryzen 9 7950X3D 16-Core Processor', ringPercent: 23, local: true, rows: [{ label: 'Load', percent: 23, resets: '' }], updatedAt: Date.now() },
  { id: 'ram', name: 'RAM', glyph: '▤', color: '#b48cf2', plan: '127.8 GB', ringPercent: 58, local: true, rows: [{ label: 'In use', percent: 58, resets: '112.4 GB' }], updatedAt: Date.now() },
];

fs.mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
try {
const page = await browser.newPage();
page.on('pageerror', (error) => { throw error; });
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
await page.evaluateOnNewDocument(() => {
  const events = {};
  window.__overlayEvents = events;
  window.api = {
    onData: (fn) => (events.data = fn),
    onLayout: (fn) => (events.layout = fn),
    onOpen: (fn) => (events.open = fn),
    onReset: (fn) => (events.reset = fn),
    onReveal: (fn) => (events.reveal = fn),
    onDragging: (fn) => (events.dragging = fn),
    get: async () => [],
    rects(r) { window.__rects = r; }, menu() { window.__menuCalled = true; }, refresh() { window.__refreshCalled = true; }, dragStart() {}, dragEnd() {},
  };
});
await page.goto(base, { waitUntil: 'load' });
await page.addStyleTag({ content: 'html{background:linear-gradient(125deg,#08111f 0%,#823f5e 48%,#d7efff 100%)!important}*,*::before,*::after{animation:none!important;transition:none!important}' });

let checked = 0;
const clipped = new Set();
for (const { width, height, edges: only, scale, panel: panelZoom } of viewports) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  for (const [theme, , css] of themes) for (const edge of only || edges) for (const state of states) {
    // Every theme at every width would be 10k combinations; themes get the states that show them off.
    if (height !== 700 && theme !== 'noir' && !process.env.UI_THEME) continue;
    if (!process.env.UI_THEME && !['noir', 'paper'].includes(theme) && !shows.includes(state)) continue;
    await page.evaluate(({ data, edge, theme, css, state, scale, panelZoom }) => {
      if (state === 'claude-banked') { data[0].bankedResets = 1; data[0].bankedResetExpiries = [Date.parse('2026-10-22T16:00:00Z')]; }
      if (state === 'claude-credit') data[0].apiCredit = { leftCents: 9195, grantedCents: 10000, expiresAt: Date.parse('2099-10-27T00:00:00Z') };
      if (state === 'claude-credit-stale') data[0].apiCredit = { leftCents: 9195, grantedCents: 10000, expiresAt: Date.parse('2099-10-27T00:00:00Z'), error: 'API credit not refreshed (HTTP 503), showing the last reading.' };
      if (state === 'claude-credit-lapsed') data[0].apiCredit = { leftCents: 9195, grantedCents: 10000, expiresAt: Date.parse('2026-09-27T00:00:00Z') };
      if (state === 'claude-credit-expired') data[0].apiCredit = { error: 'Console session expired. Copy a new `sessionKey` and pick Paste Console session key in the tray.' };
      if (state === 'codex-zero') data[1].bankedResets = 0;
      if (state === 'codex-offline') delete data[1].bankedResets;
      if (state === 'codex-expiry-missing') delete data[1].bankedResetExpiries;
      if (state === 'codex-multiple') { data[1].bankedResets = 2; data[1].bankedResetExpiries.push(Date.parse('2026-10-12T18:15:00Z')); }
      if (state === 'warning') data[0].rows[0].percent = data[0].ringPercent = 96;
      if (state === 'limited') data.forEach((p) => (p.waitMs = 90000));
      if (state === 'limited-one') { data[0].waitMs = 90000; data[0].updatedAt = Date.now() - 15 * 60000; } // gated, and behind
      if (state === 'error') { data[0].rows = []; data[0].error = 'No Claude credentials — run `claude` to sign in.'; }
      if (state === 'xai-unavailable') { data[3].rows = []; data[3].error = 'Grok sign-in expired — run `grok` to renew it.'; }
      if (state === 'loading') { data[0].rows = []; data[0].updatedAt = null; }
      if (state === 'long') {
        data[0].plan = 'Enterprise subscription with an extended plan name';
        data[0].note = 'Live refresh unavailable; showing the most recent local usage.';
        data[0].rows = Array.from({ length: 8 }, (_, i) => ({ label: 'Model usage limit ' + (i + 1), percent: i * 12, resets: 'in 23h 59m' }));
      }
      const ev = window.__overlayEvents;
      ev.open(false);
      ev.reset(null);
      ev.layout({ edge, count: data.length, theme, css, scale, panel: panelZoom });
      ev.data(data);
      ev.reveal(state !== 'hidden');
      if (state === 'reset') ev.reset({ id: 'codex', name: 'Codex', glyph: '◉', color: '#10a37f', rows: [{ label: 'Weekly', percent: 0 }] });
      else if (!['hidden', 'rest'].includes(state)) ev.open(true);
      if (state === 'refreshing') document.querySelector('#rf').click();
    }, { data, edge, theme, css, state, scale, panelZoom });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(({ state, edge }) => {
      const root = document.documentElement;
      const island = document.querySelector('#island');
      const lip = document.querySelector('#lip');
      const r = island.getBoundingClientRect();
      const vertical = edge === 'left' || edge === 'right';
      const panel = !['hidden', 'rest'].includes(state);
      const exposed = vertical
        ? Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0))
        : Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const visible = state === 'hidden' ? [lip] : [island, ...document.querySelectorAll('.chip'), ...(panel && state !== 'reset' ? [document.querySelector('#rf'), document.querySelector('#mn')] : [])];
      const outside = visible.map((el) => {
        const b = el.getBoundingClientRect();
        return { id: el.id || el.getAttribute('aria-label'), left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      }).filter((b) => b.left < -1 || b.right > innerWidth + 1 || b.top < -1 || b.bottom > innerHeight + 1);
      const lipRect = lip.getBoundingClientRect();
      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        exposed,
        outside,
        islandW: r.width,
        summaryW: document.querySelector('#summary').getBoundingClientRect().width,
        detailsW: document.querySelector('#details').getBoundingClientRect().width,
        lipThickness: vertical ? lipRect.width : lipRect.height,
        lipLevels: lip.children.length,
        noticing: document.body.classList.contains('noticing'),
        contentOverflow: panel && [...document.querySelectorAll('.inner, .prov, .row, .foot, #notice')].some((el) => el.offsetParent && el.scrollWidth > el.clientWidth + 1),
        rows: document.querySelectorAll('#sections .row[data-k]').length,
        disabled: document.querySelector('#rf').disabled,
        chips: [...document.querySelectorAll('.chip b')].map((b) => b.textContent),
        xaiInk: getComputedStyle(document.querySelectorAll('.chip .g')[3]).color === getComputedStyle(document.body).color,
        xaiLabel: document.querySelectorAll('.chip')[3].getAttribute('aria-label'),
        status: [...document.querySelectorAll('.status')].map((el) => el.textContent),
        bank: [...document.querySelectorAll('.bank')].map((el) => el.textContent),
        rects: window.__rects,
      };
    }, { state, edge });
    const bad = [];
    const panel = !['hidden', 'rest', 'reset'].includes(state);
    if (result.scrollWidth > result.clientWidth) bad.push('horizontal scroll');
    // main sizes each window to hold its capsule. Narrower than NATIVE, as top or bottom at 320px, a page the overlay
    // never opens, the six-chip capsule is wider than the page: centred, both its ends clip, the end chips with them.
    // Its buttons may not.
    const across = !['left', 'right'].includes(edge);
    const clip = result.outside.filter((b) => across && width < NATIVE[edge] && b.top >= -1 && b.bottom <= height + 1 && (b.id === 'island' ? Math.abs(b.left + b.right - width) <= 2 : !['rf', 'mn'].includes(b.id)));
    if (result.outside.length > clip.length) bad.push('outside the window');
    if (clip.length) clipped.add(`${edge} at ${width}px`);
    if (result.contentOverflow) bad.push('content overflows the panel');
    if (state === 'hidden' && (result.exposed !== 0 || Math.abs(result.lipThickness - 5 * (scale || 1)) > 0.01 || result.lipLevels !== 6)) bad.push('lip');
    if (state === 'rest' && result.detailsW !== 0) bad.push('panel open at rest');
    if ((panel || state === 'reset') && result.detailsW < 200) bad.push('panel did not open');
    if (result.islandW > Math.max(300 * (panelZoom || 1) + 86 * (scale || 1), result.summaryW + 1)) bad.push('panel too wide');
    if (state === 'reset' && !result.noticing) bad.push('reset notice');
    if (['open', 'warning', 'refreshing'].includes(state) && result.rows !== 11) bad.push('one row per limit');
    if (state === 'long' && result.rows !== 16) bad.push('long rows');
    if (['limited', 'refreshing'].includes(state) !== result.disabled) bad.push('refresh enabled state');
    // A rate limit is never shown, in any state. Numbers that have fallen behind say how old they are, gated or not.
    if (result.status.some((s) => s.includes('Rate limited'))) bad.push('rate-limit line');
    if (state === 'limited-one' && !result.status.includes('Updated 15 min ago')) bad.push('age line while gated');
    if (['error', 'loading'].includes(state) && result.chips[0] !== '—') bad.push('empty chip');
    if (state === 'error' && !result.status.includes('No Claude credentials — run claude to sign in.')) bad.push('error line');
    if (!result.xaiInk) bad.push("xAI mark not in the theme's ink");
    // Unavailable, xAI's chip is a dash and its section says how to get it back; the others carry on.
    const xaiOut = state === 'xai-unavailable';
    if (xaiOut !== (result.chips[3] === '—') || xaiOut !== (result.xaiLabel === 'xAI: usage unavailable')) bad.push('xAI chip');
    if (panel && xaiOut !== result.status.includes('Grok sign-in expired — run grok to renew it.')) bad.push('xAI line');
    if (!['error', 'loading', 'hidden'].includes(state) && result.chips[0] !== (state === 'warning' ? '96' : '37')) bad.push('chip number');
    if (!result.rects || !result.rects.island || !result.rects.lip) bad.push('rects not reported');
    if (panel) {
      // One line per provider with banked resets, plus Claude's API credit; none at zero, every date, the month once per run.
      const bank = {
        'codex-zero': [],
        'codex-offline': [],
        'codex-multiple': ['2 banked resets expire Oct 4 and 12'],
        'codex-expiry-missing': ['1 banked reset'],
        'claude-banked': ['1 banked reset expires Oct 22', '1 banked reset expires Oct 4'],
        'claude-credit': ['$91.95 of $100 API credit left, expires Oct 27', '1 banked reset expires Oct 4'],
        'claude-credit-stale': ['$91.95 of $100 API credit left, expires Oct 27', '1 banked reset expires Oct 4'],
      }[state] ?? ['1 banked reset expires Oct 4'];
      if (JSON.stringify(result.bank) !== JSON.stringify(bank)) bad.push('banked resets');
      if ((state === 'claude-credit-stale') !== result.status.includes('API credit not refreshed (HTTP 503), showing the last reading.')) bad.push('stale credit line');
      // A balance past its deadline isn't shown as funds, whatever data still carries it.
      if ((state === 'claude-credit-lapsed') !== result.status.includes('API credit expired Sep 27, waiting for a fresh reading.')) bad.push('lapsed credit line');
      if ((state === 'claude-credit-expired') !== result.status.includes('Console session expired. Copy a new sessionKey and pick Paste Console session key in the tray.')) bad.push('credit error line');
    }
    if (bad.length) throw new Error(`${theme}/${edge}/${state}/${width}x${height}: ${bad.join(', ')} ${JSON.stringify(result)}`);
    checked++;

    const representative = theme === 'noir' || (width === 375 && edge === 'right' && ['rest', 'open'].includes(state));
    if (representative) await page.screenshot({ path: path.join(shots, `${theme}-${edge}-${state}-${width}x${height}.png`) });
  }
}

await page.evaluate((data) => {
  window.__overlayEvents.reset(null);
  window.__overlayEvents.data(data);
  window.__overlayEvents.open(true);
}, data);
await page.click('#mn');
await page.click('#rf');
const actions = await page.evaluate(() => window.__menuCalled && window.__refreshCalled && document.querySelector('#rf').disabled && document.querySelector('#rf').getAttribute('aria-busy') === 'true');
if (!actions) throw new Error('Menu or refresh action failed');

// Reload without the static-screenshot overrides and exercise the real morph.
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
await page.reload({ waitUntil: 'load' });
for (const edge of edges) {
  const vertical = edge === 'left' || edge === 'right';
  await page.setViewport(vertical ? { width: 410, height: 632 } : { width: NATIVE.top, height: 684 });
  await page.evaluate(async ({ data, edge }) => {
    const check = (ok, message) => { if (!ok) throw new Error(edge + ': ' + message); };
    const settle = async () => {
      await new Promise(requestAnimationFrame);
      // Skips loops and the notice's 6s countdown, which would outlast the notice it belongs to.
      await Promise.all(document.getAnimations().filter((a) => a.effect.getTiming().iterations !== Infinity && !a.effect.target.matches('.life')).map((a) => a.finished.catch(() => {})));
    };
    const chipsAt = () => [...document.querySelectorAll('.chip')].map((c) => { const r = c.getBoundingClientRect(); return [r.left, r.top]; });
    // Within a pixel: centring an odd height lands on a half pixel, which is not a move anyone sees.
    const still = (a, b) => a.every(([x, y], i) => Math.abs(x - b[i][0]) <= 1 && Math.abs(y - b[i][1]) <= 1);
    const ev = window.__overlayEvents;
    ev.open(false);
    ev.reveal(false);
    ev.layout({ edge, theme: 'noir' });
    ev.data(data);
    await settle();
    ev.reveal(true);
    await new Promise(requestAnimationFrame);
    check(document.querySelector('.chip .hair').getAnimations().length > 0, 'Hairlines do not fill as the capsule slides out');
    await settle();
    check(document.querySelector('.chip .hair').style.getPropertyValue('--p') === '37%', 'Hairline does not read 37%');
    check(document.querySelector('.chip b').textContent === '37', 'Number does not count up to 37');
    const before = chipsAt();
    ev.open(true);
    await new Promise(requestAnimationFrame);
    check(document.querySelector('#details').getAnimations().length > 0, 'Capsule does not grow');
    check(document.querySelector('#sections .row .hair').getAnimations().length > 0, 'Rows do not fill as the panel opens');
    check(document.querySelector('#sections .row .pc b').textContent === '0', 'Row numbers do not count up as the panel opens');
    await settle();
    check(still(chipsAt(), before), 'Chips moved while the capsule grew: ' + before + ' -> ' + chipsAt());
    check(document.querySelector('#details').getBoundingClientRect().width > 250, 'Panel did not open');
    document.querySelector('#rf').click();
    check(getComputedStyle(document.querySelector('#rf svg')).animationName === 'spin', 'Refresh icon does not spin');
    ev.data(data);
    check(!document.querySelector('#rf').hasAttribute('aria-busy'), 'Refresh spinner did not stop after data arrived');
    ev.open(false);
    await settle();
    check(document.querySelector('#details').getBoundingClientRect().width === 0, 'Panel did not close');
    check(still(chipsAt(), before), 'Chips moved while the capsule shrank');
    ev.reset({ id: 'codex', name: 'Codex', glyph: '◉', color: '#10a37f', rows: [{ label: 'Weekly', percent: 0 }] });
    await settle();
    check(document.body.classList.contains('noticing') && document.querySelector('#notice').offsetHeight > 0, 'Reset notice did not open the capsule');
    ev.open(true);
    check(!document.body.classList.contains('noticing'), 'Hovering does not swap the notice for the panel');
    await settle();
    check(document.documentElement.scrollWidth <= innerWidth, 'Motion causes horizontal overflow');
  }, { data, edge });
  await page.screenshot({ path: path.join(shots, `motion-${edge}.png`) });
}
// Small shrinks the pill, not the panel's small print.
await page.evaluate(async (data) => {
  const ev = window.__overlayEvents;
  const measure = async (scale) => {
    ev.layout({ edge: 'right', theme: 'noir', scale });
    ev.data(data);
    ev.open(true);
    await new Promise(requestAnimationFrame);
    return [document.querySelector('.chip b'), document.querySelector('.row .rs')].map((el) => el.getBoundingClientRect().height);
  };
  const [chipL, lineL] = await measure(1);
  const [chipS, lineS] = await measure(0.68);
  if (Math.abs(chipS / chipL - 0.68) > 0.05 || lineS !== lineL) throw new Error(`Size should shrink the pill only: chip ${chipL} -> ${chipS}, reset line ${lineL} -> ${lineS}`);
  await measure(1);
}, data);
// Swapping one provider for another keeps the count, and the layout can arrive before the new list:
// the chips must still take the new providers' marks and colours.
await page.evaluate((data) => {
  const ev = window.__overlayEvents;
  ev.layout({ edge: 'right', theme: 'noir' });
  ev.data(data);
  ev.data([data[1], { ...data[0], id: 'opencode-go', name: 'OpenCode Go', glyph: '▣', color: '#fab283' }]);
  const chips = [...document.querySelectorAll('.chip')].map((c) => c.querySelector('.g').textContent + c.style.getPropertyValue('--c'));
  if (chips.join() !== '◉#10a37f,▣#fab283') throw new Error('Chips kept the old providers\' marks: ' + chips);
}, data);
// The footer dates the usage, not CPU and RAM, which are always fresh; with only those two it dates them.
await page.evaluate((data) => {
  const ev = window.__overlayEvents;
  const ft = () => document.querySelector('#ft').textContent;
  ev.data(data.map((p) => ({ ...p, updatedAt: p.local ? Date.now() : Date.now() - 5 * 60000 })));
  if (ft() !== 'Updated 5 min ago') throw new Error('Footer with fresh CPU and older usage says ' + ft());
  ev.data(data.filter((p) => p.local).map((p) => ({ ...p, updatedAt: Date.now() })));
  if (ft() !== 'Updated just now') throw new Error('Footer with only CPU and RAM says ' + ft());
  ev.data(data);
}, data);
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
await page.evaluate(async () => {
  window.__overlayEvents.open(false);
  await new Promise(requestAnimationFrame);
  const grow = parseFloat(getComputedStyle(document.querySelector('#details')).transitionDuration);
  const sweep = parseFloat(getComputedStyle(document.querySelector('.chip .hair')).transitionDuration);
  if (grow > 0.001 || sweep > 0.001) throw new Error('Reduced motion preference ignored');
});

console.log(`PASS: ${checked} theme, edge, state and width combinations; screenshots: ${shots}`);
if (clipped.size) console.log(`LIMIT: the capsule's ends clip, every control in view, ${[...clipped].join(', ')}: narrower than main ever opens that window`);
console.log('PASS: reveal sweep, morph with fixed chips, notice, refresh and reduced-motion checks');
} finally {
  await browser.close();
}
