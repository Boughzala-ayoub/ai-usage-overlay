// bubble.html in headless Chrome, as the phone's WebView shows it, against a stand-in for the PC: the tab
// docked, lifted and hidden at each size; the panel at every width with the tab at the top, middle and
// bottom of either side; the settings at every width, each kind of change, and a theme the PC pushes.
// Fails on overflow, anything outside the tab, a tab that moves when the panel opens or closes, a panel
// off screen or over the tab, a tap that closes what it shouldn't or doesn't close what it should, and a
// change that doesn't reach the PC or come back. Screenshots land in %TEMP%\ai-usage-bubble.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const pageFile = process.env.BUBBLE_PAGE || path.join(here, 'bubble.html'); // BUBBLE_PAGE: the page as packed in the APK
const require = createRequire(import.meta.url);
const THEME_GROUPS = require('../themes.js');
const css = (id) => THEME_GROUPS.flatMap(([, l]) => l).find(([t]) => t === id)[2];
const shots = path.join(os.tmpdir(), 'ai-usage-bubble');
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });
const h = 3600_000;
const providers = (hot) => [
  { id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', plan: 'Max 5x', ringPercent: hot ? 96 : 34, bankedResets: 1, bankedResetExpiries: [Date.parse('2026-10-22T16:00:00Z')], updatedAt: Date.now(), waitMs: 0,
    apiCredit: { leftCents: 9195, grantedCents: 10000, expiresAt: Date.parse('2099-10-27T00:00:00Z'), ...(hot ? { error: 'API credit not refreshed (HTTP 503), showing the last reading.' } : {}) },
    rows: [{ label: 'Session', percent: hot ? 96 : 34, resets: 'in 3h 2m' }, { label: 'All models', percent: 56, resets: 'in 3h 42m' }, { label: 'Fable', percent: 0, resets: 'in 3h 42m' }] },
  { id: 'codex', name: 'Codex', glyph: '◉', color: '#10a37f', plan: 'Pro Lite', ringPercent: hot ? 100 : 3, bankedResets: 2, bankedResetExpiries: [Date.parse('2026-10-28T10:00:00Z'), Date.parse('2026-11-04T10:00:00Z')], updatedAt: Date.now() - (hot ? h : 0), waitMs: hot ? 90_000 : 0,
    rows: [{ label: 'Weekly', percent: hot ? 100 : 3, resets: 'in 6d 12h' }] },
  { id: 'opencode-go', name: 'OpenCode Go', glyph: '▣', color: '#fab283', plan: 'Go', ringPercent: hot ? 78 : 61, updatedAt: Date.now(), waitMs: 0,
    rows: [{ label: '5h limit', percent: 0, resets: 'in 5h' }, { label: 'Weekly', percent: 1, resets: 'in 4d 2h' }, { label: 'Monthly', percent: hot ? 78 : 61, resets: 'in 2d 23h' }] },
  // Hot, xAI is the provider whose usage is unavailable: signed out, no numbers at all.
  { id: 'xai', name: 'xAI', glyph: '✕', color: 'var(--fg)', plan: '', ringPercent: hot ? 0 : 42.5, updatedAt: Date.now(), waitMs: 0,
    ...(hot ? { rows: [], error: 'Grok sign-in expired — run `grok` to renew it.' } : { rows: [{ label: 'Weekly', percent: 42.5, resets: 'in 5d 6h' }, { label: 'Monthly', percent: 25, resets: 'in 18d 12h' }] }) },
];
const options = {
  themes: THEME_GROUPS,
  providers: providers(false).map(({ id, name, glyph, color }) => ({ id, name, glyph, color })),
  choices: { claude: [['Highest limit', ''], ['Session', 'Session'], ['Weekly', 'All models'], ['Fable', 'Fable']], 'opencode-go': [['Highest limit', ''], ['5-hour', '5h limit'], ['Weekly', 'Weekly'], ['Monthly', 'Monthly']] },
  pages: { claude: 'https://claude.ai/settings/usage', codex: 'https://chatgpt.com/codex/settings/usage', xai: 'https://grok.com/?_s=usage' },
};

// ---- the stand-in PC: the same routes and answers as main.js's servePhone
let answer = 'ok';
let holdUsage = false; // the next /api/usage answer waits for release(), as a slow network would hold it
let holdSettings = false; // the same for the next /api/settings answer
let release = null;
let holdStreams = false; // a cut stream's reconnections wait, so a reconnect's fresh state can't hide a rollback
let dropUsage = false; // the next /api/usage connection ends unanswered, as the link ends it switching ways
let opened = 0; // streams the page has opened
const waiting = [];
const pc = { theme: 'noir', enabled: ['claude', 'codex', 'opencode-go', 'xai'], choices: {} };
// Every provider on: the tallest tab. Its height is 6px above and below, 40.5px per provider, as fit() draws it.
const COUNT = pc.enabled.length;
const TAB = 8.5 + 40.5 * COUNT;
const posts = [];
const streams = new Set();
// Numbered as main.js numbers them: the run of the overlay, and one more for each snapshot made.
let run = 'stand-in';
let revs = 0;
const payload = () => JSON.stringify({ css: pc.theme === 'noir' ? '' : css(pc.theme), ...pc, providers: providers(answer === 'hot').filter((p) => pc.enabled.includes(p.id)), run, rev: ++revs });
const tell = () => streams.forEach((res) => res.write('data: ' + payload() + '\n\n'));
const openStream = (req, res) => {
  opened++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('retry: 300\n'); // once let through, reconnect fast: the check shouldn't sit out Chrome's 3 s default
  res.write('data: ' + payload() + '\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
};
// The stream drops, and stays down until reopen(): reconnections are held unanswered, so it stays CONNECTING.
const cut = () => {
  holdStreams = true;
  streams.forEach((res) => res.destroy());
  streams.clear();
};
const reopen = () => {
  holdStreams = false;
  waiting.splice(0).forEach(([req, res]) => openStream(req, res));
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/') return res.end(fs.readFileSync(pageFile));
  if (req.url === '/fonts/geist.woff2') return res.end(fs.readFileSync(path.join(here, '..', 'fonts', 'geist.woff2')));
  if (answer === 'down') return res.writeHead(502).end();
  if (req.url === '/api/events') {
    if (holdStreams) return void waiting.push([req, res]);
    return openStream(req, res);
  }
  if (req.url === '/api/options') return res.end(JSON.stringify(options));
  if (req.url === '/api/settings') {
    let body = '';
    for await (const c of req) body += c;
    posts.push({ type: req.headers['content-type'], body: JSON.parse(body) });
    const want = JSON.parse(body);
    if (want.theme) pc.theme = want.theme;
    if (want.enabled) pc.enabled = want.enabled;
    if (want.choices) Object.assign(pc.choices, want.choices);
    // As main.js does: the phones hear the change, then the answer goes, unless it is held back.
    const state = payload();
    tell();
    if (!holdSettings) return res.end(state);
    holdSettings = false;
    release = () => res.end(state);
    return;
  }
  if (dropUsage) return void ((dropUsage = false), res.destroy());
  res.setHeader('content-type', 'application/json');
  const body = payload(); // the PC's state as the request arrives, however late the answer lands
  if (!holdUsage) return res.end(body);
  holdUsage = false;
  release = () => res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
// The stand-in serves before any browser check: the page, the font and each route the page reads.
for (const route of ['', 'fonts/geist.woff2', 'api/usage', 'api/options']) {
  const status = (await fetch(url + route)).status;
  if (status !== 200) {
    console.log(`FAIL ${url + route} answers ${status}`);
    process.exit(1);
  }
}

// ---- the real PC: main.js's own phone handler, with Electron faked and one provider whose read the check
// holds and finishes by hand, behind a server that can cut its streams. For the orders only main.js makes:
// its reads snapshot after their provider answers, not as they arrive.
const root = path.join(here, '..');
const requireRoot = createRequire(path.join(root, 'main.js'));
const pcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bubble-pc-'));
const held = { read: async () => ({ rows: [] }) };
let realHandler = null;
const realPc = (() => {
  const electron = { app: { commandLine: { appendSwitch() {} }, whenReady: () => new Promise(() => {}), on() {}, getPath: () => pcDir }, ipcMain: { on() {}, handle() {} }, globalShortcut: { unregisterAll() {} } };
  const fakeHttp = { createServer: (fn) => ((realHandler = fn), { on() { return this; }, listen() { return this; } }) };
  const fakeProviders = { ...requireRoot('./providers'), PROVIDERS: [{ id: 'claude', name: 'Claude', glyph: '✳', color: '#d97757', everyMs: 0, read: () => held.read() }] };
  const mod = { exports: {} };
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8') + '\nmodule.exports = { last, gate, servePhone };';
  new Function('require', 'module', '__dirname', src)((id) => (id === 'electron' ? electron : id === 'http' ? fakeHttp : id === './providers' ? fakeProviders : requireRoot(id)), mod, root);
  mod.exports.servePhone(); // hands its handler to the fake http: no port opens, 7430 stays the installed overlay's
  return mod.exports;
})();
let cutReal = false;
const realStreams = new Set();
const realWaiting = [];
const realServer = http.createServer((req, res) => {
  if (req.url === '/') return res.end(fs.readFileSync(pageFile));
  if (req.url === '/api/events') {
    if (cutReal) return void realWaiting.push([req, res]); // held, as the stand-in's are, so a reconnect can't hide anything
    realStreams.add(res);
    req.on('close', () => realStreams.delete(res));
  }
  realHandler(req, res);
});
await new Promise((r) => realServer.listen(0, '127.0.0.1', r));
const realUrl = `http://127.0.0.1:${realServer.address().port}/`;
for (const route of ['', 'api/options', 'api/usage']) {
  const status = (await fetch(realUrl + route)).status;
  if (status !== 200) {
    console.log(`FAIL ${realUrl + route} answers ${status}`);
    process.exit(1);
  }
}

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const failures = [];
const fail = (what) => failures.push(what) && console.log('FAIL ' + what);
const rect = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
const near = (a, b) => Math.abs(a - b) < 0.6;
const windowFor = (z) => ({ width: Math.ceil(38 * z) + 12, height: Math.ceil(TAB * z) + 24, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
const small = windowFor(1);
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => fail('page error: ' + e.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // setViewport can return before the page has the new size; wait for it, then for a frame drawn at it.
  const resize = async (v) => {
    await page.setViewport(v);
    await page.waitForFunction((w) => innerWidth === w, {}, v.width);
    await settle();
  };
  const has = (cls) => page.evaluate((c) => document.body.classList.contains(c), cls);
  // A wait that fails the check with what the page shows instead of throwing, so the rest still runs.
  const until = async (fn, what, arg) => {
    try {
      await page.waitForFunction(fn, { timeout: 4000 }, arg);
      return true;
    } catch {
      const seen = await page.evaluate(() => ({ body: document.body.className, theme: document.querySelector('[aria-pressed="true"].sw')?.dataset.theme, cells: document.querySelectorAll('#cells .cell').length }));
      fail(`${what}: never happened; the page shows ${JSON.stringify(seen)}, the PC got ${JSON.stringify(posts.map((p) => p.body))}`);
      return false;
    }
  };
  // Waits for the panel to finish closing, after `act` (a tap) starts it.
  const closes = async (act) => {
    // Braces, not a returned promise: evaluate() would wait on it, and the tap would come after the timeout.
    await page.evaluate(() => {
      window.handed = new Promise((r) => {
        addEventListener('animationend', function f(e) {
          if (e.animationName !== 'push') return; // the scrim ends its own animation too
          removeEventListener('animationend', f, true);
          r(true);
        }, true);
        setTimeout(() => r(false), 1000);
      });
    });
    await act();
    return page.evaluate(() => window.handed);
  };
  const open = async (width, height, side, wy, z = 1) => {
    const win = windowFor(z);
    await resize(win);
    await page.evaluate((s) => dock(s, false), side);
    await settle(); // a lift() just before leaves a slide running for two frames
    await page.evaluate((a) => expand(...a), [side === 'right' ? width - win.width : 0, wy, 24, 48]);
    await resize({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  };
  // Bubble.java's reanchor(): when the screen turns or the size changes with the panel open, the tab's
  // window goes back to its edge for the new screen and size, inside the bars, and the page gets that place.
  const reanchor = async (tag, width, height, side, wy, z = 1) => {
    const win = windowFor(z);
    try {
      await page.evaluate((a) => anchor(...a), [side === 'right' ? width - win.width : 0, Math.max(24, Math.min(wy, height - 48 - win.height)), 24, 48]);
    } catch (e) {
      fail(`${tag}: ${e.message.split('\n')[0]}`);
    }
    await settle();
  };
  // Every control on screen lies inside the viewport: a page that hides its overflow passes a scrollWidth
  // check with them cut off. Rows scrolled out of their list are not on screen, so they don't count, and of a
  // row scrolled partly out only the part the list shows does.
  const outOfView = () => page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    return [...document.querySelectorAll('#tab, #tab .dial, #tab b, #card, #card button, #card input, #card header, #card .row, #card p')].flatMap((e) => {
      const b = e.getBoundingClientRect();
      if (!b.width || !b.height) return [];
      const r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      const list = e.closest('#usage, #prefs');
      if (list && list !== e) {
        const c = list.getBoundingClientRect();
        if (r.bottom <= c.top || r.top >= c.bottom) return [];
        [r.top, r.bottom] = [Math.max(r.top, c.top), Math.min(r.bottom, c.bottom)];
      }
      return r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5 ? [(e.id || e.className || e.tagName) + ' at ' + [r.left, r.top, r.right, r.bottom].map(Math.round)] : [];
    });
  });
  // The open panel at this size and edge: the tab flush with its edge and whole, its rings inside it, the
  // panel clear of it, nothing off screen, nothing scrolling sideways.
  const openCheck = async (tag, width, height, side, z = 1) => {
    const t = await rect(page, '#tab');
    const c = await rect(page, '#card');
    if (side === 'right' ? Math.abs(t.r - width) > 1 : Math.abs(t.l) > 1) fail(`${tag}: the tab isn't flush with the ${side} edge: ${t.l.toFixed(1)} to ${t.r.toFixed(1)}`);
    if (!near(t.r - t.l, 38 * z) || !near(t.b - t.t, TAB * z)) fail(`${tag}: the tab is ${(t.r - t.l).toFixed(1)}x${(t.b - t.t).toFixed(1)}`);
    if (t.t < 36 - 0.5 || t.b > height - 60 + 0.5) fail(`${tag}: the tab is outside the bars, ${t.t.toFixed(1)} to ${t.b.toFixed(1)}`);
    if (side === 'right' ? c.r > t.l - 8 + 0.5 : c.l < t.r + 8 - 0.5) fail(`${tag}: panel over the tab, panel ${c.l.toFixed(1)} to ${c.r.toFixed(1)}, tab ${t.l.toFixed(1)} to ${t.r.toFixed(1)}`);
    const spilt = await page.evaluate(({ l, t, r, b }) => [...document.querySelectorAll('#tab .dial, #tab b')].filter((e) => { const x = e.getBoundingClientRect(); return x.left < l + 1 || x.right > r - 1 || x.top < t || x.bottom > b; }).length, t);
    if (spilt) fail(`${tag}: ${spilt} rings or numbers outside the tab`);
    const off = await outOfView();
    if (off.length) fail(`${tag}: off screen: ${off.slice(0, 4).join(' | ')}`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) fail(`${tag}: scrolls sideways`);
  };

  for (const state of ['ok', 'hot', 'down']) {
    answer = state === 'down' ? 'ok' : state; // down: it has seen the PC once, then loses it
    await page.setViewport(small); // before the page: a blank one has no viewport tag, so its width is 980
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction((n) => document.querySelectorAll('#cells .cell .dial').length === n, {}, COUNT);
    // xAI wears the theme's ink. Signed out (hot), its ring shows a dash and its section says how to sign in.
    const xai = await page.evaluate(() => {
      const cell = document.querySelectorAll('#cells .cell')[3];
      return { fill: getComputedStyle(cell.querySelector('.logo')).fill, ink: getComputedStyle(document.body).color, num: cell.querySelector('b').textContent, off: cell.classList.contains('off'), status: [...document.querySelectorAll('#sections .status')].map((e) => e.textContent) };
    });
    if (xai.fill !== xai.ink) fail(`${state}: the xAI mark is ${xai.fill}, not the theme's ink ${xai.ink}`);
    const signedOut = state === 'hot';
    if (signedOut !== xai.off || xai.num !== (signedOut ? '—' : '43%')) fail(`${state}: the xAI ring reads ${xai.num}${xai.off ? ', off' : ''}`);
    if (signedOut !== xai.status.includes('Grok sign-in expired — run grok to renew it.')) fail(`${state}: the xAI section says ${JSON.stringify(xai.status)}`);
    if (state === 'down') {
      answer = 'down';
      await page.evaluate(() => load());
    }

    // ---- collapsed: docked on each side, lifted as a drag starts, and hidden at the edge
    for (const pose of ['right', 'left', 'lifted', 'peek']) {
      await page.evaluate((pose) => {
        peek(false);
        if (pose === 'lifted') dock('right', false), lift();
        else if (pose === 'peek') dock('right', false), peek(true);
        else dock(pose, false);
      }, pose);
      await settle();
      await page.screenshot({ path: path.join(shots, `tab-${state}-${pose}.png`), omitBackground: true });
      const t = await rect(page, '#tab');
      const home = { right: 12, left: 0, lifted: 6, peek: 12 }[pose];
      if (!near(t.l, home) || !near(t.t, 12) || !near(t.r - t.l, 38) || !near(t.b - t.t, TAB)) fail(`${state} ${pose}: tab at ${t.l},${t.t} ${t.r - t.l}x${t.b - t.t}`);
      const out = await page.evaluate(({ l, t, r, b }) =>
        [...document.querySelectorAll('#tab .dial, #tab b, #lip i')].filter((e) => {
          const x = e.getBoundingClientRect();
          return x.left < l + 2 || x.right > r - 2 || x.top < t || x.bottom > b;
        }).map((e) => e.textContent || e.tagName), t);
      if (out.length) fail(`${state} ${pose}: outside the tab: ${out}`);
      // Hidden, only the lip shows: its levels sit in the 12px left on screen, the rings are gone.
      const shown = await page.evaluate(() => [getComputedStyle(document.querySelector('#lip')).opacity, getComputedStyle(document.querySelector('#cells')).opacity]);
      if (pose === 'peek' ? shown.join() !== '1,0' : shown.join() !== '0,1') fail(`${state} ${pose}: lip and rings at opacity ${shown}`);
      if (pose === 'peek') {
        const lipR = await rect(page, '#lip');
        if (lipR.r > t.l + 12) fail(`${state} peek: the lip's levels reach ${lipR.r - t.l}px into the tab, past the 12px on screen`);
      }
    }
    await page.evaluate(() => peek(false));

    // ---- open, at every width, with the tab at the top, middle and bottom of either side
    for (const [width, height] of [[320, 700], [375, 812], [412, 915], [768, 1024], [1024, 768], [1280, 800]]) {
      for (const side of ['right', 'left']) {
        for (const at of ['top', 'middle', 'bottom']) {
          const tag = `${state} ${width}x${height} ${side}-${at}`;
          const wx = side === 'right' ? width - small.width : 0;
          const wy = { top: 24, middle: Math.round(height / 2 - small.height / 2), bottom: height - 48 - small.height }[at];
          await open(width, height, side, wy);
          const tab = await rect(page, '#tab');
          const want = { l: wx + (side === 'right' ? 12 : 0), t: wy + 12 };
          if (!near(tab.l, want.l) || !near(tab.t, want.t)) fail(`${tag}: the tab moved on opening, to ${tab.l},${tab.t} from ${want.l},${want.t}`);
          const card = await rect(page, '#card');
          if (card.l < 12 - 0.5 || card.r > width - 12 + 0.5 || card.t < 36 - 0.5 || card.b > height - 60 + 0.5) fail(`${tag}: panel off screen ${[card.l, card.t, card.r, card.b].map(Math.round)}`);
          if (side === 'right' ? card.r > tab.l - 8 + 0.5 : card.l < tab.r + 8 - 0.5) fail(`${tag}: panel over the tab`);
          // Level with the tab, unless the screen's bottom pushed it up.
          if (!near(card.t, Math.max(tab.t, 36)) && !near(card.b, height - 60)) fail(`${tag}: panel top ${Math.round(card.t)} is neither level with the tab (${tab.t}) nor pushed up`);
          const m = await page.evaluate(() => {
            const s = document.querySelector('#usage');
            const spill = [...document.querySelectorAll('#card .row > *, #card header > *, #card p')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis').map((e) => e.className + ':' + e.textContent);
            return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sx: s.scrollWidth - s.clientWidth, spill, shown: s.clientHeight, all: s.scrollHeight };
          });
          if (m.sw > m.cw) fail(`${tag}: page scrolls sideways`);
          if (m.shown < Math.min(m.all, 200)) fail(`${tag}: only ${m.shown}px of ${m.all}px of limits on show`);
          if (m.sx > 0) fail(`${tag}: the panel scrolls sideways by ${m.sx}`);
          if (m.spill.length) fail(`${tag}: text spills: ${m.spill.join(' | ')}`);
          const off = await outOfView();
          if (off.length) fail(`${tag}: off screen: ${off.slice(0, 4).join(' | ')}`);
          if ([320, 412].includes(width) || (width === 768 && at === 'middle')) await page.screenshot({ path: path.join(shots, `open-${state}-${width}-${side}-${at}.png`) });

          // A tap inside the panel leaves it open; one anywhere else closes it. Where: below the panel, above
          // it (the empty part of #dock that keeps it level with the tab), or on the tab itself.
          await page.mouse.click((card.l + card.r) / 2, card.t + 30);
          await settle();
          if (await has('closing')) fail(`${tag}: a tap inside the panel closed it`);
          const dock = await rect(page, '#dock');
          const cx = (card.l + card.r) / 2;
          const spot = at === 'top' && dock.b - card.b > 20 ? [cx, card.b + 10, 'below the panel']
            : at === 'middle' && card.t - dock.t > 20 ? [cx, card.t - 10, 'above the panel']
            : [(tab.l + tab.r) / 2, (tab.t + tab.b) / 2, 'on the tab'];
          if (!(await closes(() => page.mouse.click(spot[0], spot[1])))) fail(`${tag}: a tap ${spot[2]} didn't close the panel`);
          await resize(small);
          const back = await rect(page, '#tab');
          if (!near(back.l, side === 'right' ? 12 : 0) || !near(back.t, 12)) fail(`${tag}: back in the small window the tab is at ${back.l},${back.t}`);
          if (await has('closing')) fail(`${tag}: closing never cleared`);
        }
      }
    }
  }

  // ---- settings: the PC's menu and the phone's own, at every width
  answer = 'ok';
  await page.setViewport(small);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction((n) => document.querySelectorAll('#cells .cell .dial').length === n, {}, COUNT);
  for (const [width, height, side] of [[320, 700], [375, 812], [412, 915], [768, 1024], [1024, 768], [1280, 800]].flatMap(([w, h]) => [[w, h, 'right'], [w, h, 'left']])) {
    const tag = `settings ${width}x${height} ${side}`;
    await open(width, height, side, 120);
    await page.click('#mn');
    await page.waitForSelector('#prefs .sw');
    const m = await page.evaluate(() => {
      const p = document.querySelector('#prefs');
      const spill = [...p.querySelectorAll('h3, h4, .hint, .opt > span, .who, .seg button, .links button, #remove')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent);
      const small = [...p.querySelectorAll('.seg button, .links button, #remove, .opt')].filter((e) => e.getBoundingClientRect().height < 34).map((e) => e.textContent);
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sx: p.scrollWidth - p.clientWidth, spill, small, usage: getComputedStyle(document.querySelector('#usage')).display, themes: p.querySelectorAll('.sw').length };
    });
    if (m.sw > m.cw || m.sx > 0) fail(`${tag}: scrolls sideways`);
    if (m.spill.length) fail(`${tag}: text spills: ${m.spill.join(' | ')}`);
    if (m.small.length) fail(`${tag}: under 34px to tap: ${m.small.join(' | ')}`);
    if (m.usage !== 'none') fail(`${tag}: the numbers still show under the settings`);
    if (m.themes !== THEME_GROUPS.flatMap(([, l]) => l).length) fail(`${tag}: ${m.themes} themes on offer`);
    const off = await outOfView();
    if (off.length) fail(`${tag}: off screen: ${off.slice(0, 4).join(' | ')}`);
    await page.screenshot({ path: path.join(shots, `settings-${width}-${side}.png`) });
    if (width === 412) {
      await page.$eval('#prefs', (p) => (p.scrollTop = p.scrollHeight));
      await page.screenshot({ path: path.join(shots, `settings-${width}-${side}-end.png`) });
      await page.$eval('#prefs', (p) => (p.scrollTop = 0));
    }
    // A tap in the settings keeps the panel open; one outside closes it, and it opens on the numbers next time.
    const inside = await rect(page, '#prefs');
    await page.mouse.click((inside.l + inside.r) / 2, inside.t + 8);
    await settle();
    if (await has('closing')) fail(`${tag}: a tap inside the settings closed the panel`);
    if (!(await closes(() => page.mouse.click(20, height - 30)))) fail(`${tag}: a tap outside the settings didn't close the panel`);
    await resize(small);
    if (await has('prefs')) fail(`${tag}: the panel will open on the settings next time`);
  }

  // ---- snipping at every width. The scissors put the panel and the tab away under a dim and a cue; a drag
  // marks a rectangle that goes to Bubble.java as fractions of the screen, and the click that ends the drag
  // doesn't cancel it. A stand-in for Bubble.java records what the page asks of it.
  const stub = (canSnip) => page.evaluate((can) => {
    window.calls = [];
    window.Android = new Proxy({}, { get: (_, k) => (...a) => (k === 'canSnip' ? can : calls.push([k, ...a])) });
  }, canSnip);
  const unstub = () => page.evaluate(() => delete window.Android);
  for (const [width, height] of [[320, 700], [375, 812], [412, 915], [768, 1024], [1024, 768], [1280, 800]]) {
    const tag = `snip ${width}x${height}`;
    await open(width, height, 'right', 120);
    await stub(true);
    await page.click('#sn');
    await settle();
    const shown = await page.evaluate(() => ['#snip', '#cue', '#dock', '#tab', '#scrim'].map((s) => getComputedStyle(document.querySelector(s)).display).join());
    if (shown !== 'block,grid,none,none,none') fail(`${tag}: snip, cue, panel, tab and scrim show as ${shown}`);
    const cue = await rect(page, '#cue');
    if (cue.l < 16 - 0.5 || cue.r > width - 16 + 0.5 || cue.t < 24) fail(`${tag}: the cue sits at ${[cue.l, cue.t, cue.r, cue.b].map(Math.round)}`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) fail(`${tag}: scrolls sideways`);
    await page.screenshot({ path: path.join(shots, `snip-${width}.png`) });
    await page.mouse.move(40, 100);
    await page.mouse.down();
    await page.mouse.move(width - 60, height / 2, { steps: 5 });
    await settle(); // Chrome hands moves over once a frame
    const s = await rect(page, '#sel');
    if (!near(s.l, 40) || !near(s.t, 100) || !near(s.r, width - 60) || !near(s.b, height / 2)) fail(`${tag}: the rectangle is ${[s.l, s.t, s.r, s.b].map(Math.round)}`);
    await page.screenshot({ path: path.join(shots, `snip-${width}-drawing.png`) });
    await page.mouse.up();
    await settle();
    const calls = await page.evaluate(() => calls);
    const want = [40 / width, 100 / height, (width - 100) / width, (height / 2 - 100) / height];
    const got = calls.find(([k]) => k === 'snipped');
    if (!got || want.some((v, i) => Math.abs(got[i + 1] - v) > 1e-6)) fail(`${tag}: Bubble.java got ${JSON.stringify(calls)}, not snipped(${want})`);
    if (calls.some(([k]) => k === 'collapse')) fail(`${tag}: the drag's own click cancelled the snip`);
    if ((await page.$eval('#snip', (e) => getComputedStyle(e).visibility)) !== 'hidden') fail(`${tag}: the dim is still up for the screenshot`);
    await unstub();
    await resize(small);
    if ((await has('snip')) || (await has('shot'))) fail(`${tag}: still snipping back in the small window`);
  }
  // A tap instead of a drag cancels: the window folds back and nothing is copied.
  await open(412, 915, 'left', 120);
  await stub(true);
  await page.click('#sn');
  await page.mouse.click(200, 400);
  await settle();
  const tapped = await page.evaluate(() => calls);
  if (!tapped.some(([k]) => k === 'collapse') || tapped.some(([k]) => k === 'snipped')) fail(`snip: a tap sent ${JSON.stringify(tapped)}`);
  await unstub();
  await resize(small);
  // Only the finger that started a snip moves or ends it: another finger's down, move, release or cancel
  // changes nothing. Real touches through CDP, each call putting down, moving or lifting the fingers it lists.
  // CDP cancels only every finger at once, so the other finger's cancel goes to #snip with its own pointerId
  // while that finger is really down.
  const cdp = await page.createCDPSession();
  const touch = (type, fingers) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: fingers.map(([id, x, y]) => ({ id, x, y })) });
  const drawn = async (want, what) => {
    await settle();
    const s = await rect(page, '#sel');
    const state = await page.evaluate(() => ({ calls, drawing: document.body.classList.contains('drawing') }));
    if (![s.l, s.t, s.r, s.b].every((v, i) => near(v, want[i]))) fail(`snip, two fingers: after ${what} the rectangle is ${[s.l, s.t, s.r, s.b].map(Math.round)}, not ${want}`);
    if (!state.drawing || state.calls.length) fail(`snip, two fingers: ${what} ended the snip: ${JSON.stringify(state)}`);
  };
  await open(375, 812, 'right', 120);
  await stub(true);
  await page.click('#sn');
  await page.evaluate(() => {
    window.ids = [];
    document.querySelector('#snip').addEventListener('pointerdown', (e) => ids.push(e.pointerId));
  });
  await touch('touchStart', [[1, 40, 100]]);
  await touch('touchMove', [[1, 150, 300]]);
  await touch('touchStart', [[1, 150, 300], [2, 270, 500]]);
  await drawn([40, 100, 150, 300], "a second finger's down");
  await touch('touchMove', [[1, 150, 300], [2, 300, 600]]);
  await drawn([40, 100, 150, 300], "the second finger's move");
  await page.screenshot({ path: path.join(shots, 'snip-375-two-fingers.png') });
  await touch('touchEnd', [[2, 300, 600]]);
  await drawn([40, 100, 150, 300], "the second finger's release");
  await touch('touchStart', [[1, 150, 300], [3, 200, 650]]);
  await page.evaluate(() => document.querySelector('#snip').dispatchEvent(new PointerEvent('pointercancel', { pointerId: ids.at(-1), pointerType: 'touch', bubbles: true })));
  await drawn([40, 100, 150, 300], "a third finger's cancel");
  await touch('touchEnd', [[3, 200, 650]]);
  await touch('touchMove', [[1, 250, 450]]);
  await drawn([40, 100, 250, 450], 'the first finger moving on');
  await touch('touchEnd', [[1, 250, 450]]);
  await settle();
  const fingers = await page.evaluate(() => calls);
  const crop = [40 / 375, 100 / 812, 210 / 375, 350 / 812];
  const cropped = fingers.find(([k]) => k === 'snipped');
  if (!cropped || crop.some((v, i) => Math.abs(cropped[i + 1] - v) > 1e-6) || fingers.length !== 1) fail(`snip, two fingers: Bubble.java got ${JSON.stringify(fingers)}, not only snipped(${crop})`);
  await unstub();
  await resize(small);
  // The first finger's own cancel still drops the rectangle, and the next drag snips as usual.
  await open(375, 812, 'right', 120);
  await stub(true);
  await page.click('#sn');
  await touch('touchStart', [[1, 60, 120]]);
  await touch('touchMove', [[1, 200, 320]]);
  await touch('touchCancel', []);
  await settle();
  const dropped = await page.evaluate(() => ({ calls, drawing: document.body.classList.contains('drawing'), snip: document.body.classList.contains('snip') }));
  if (dropped.calls.length || dropped.drawing || !dropped.snip) fail(`snip: after a cancel ${JSON.stringify(dropped)}, not still snipping with nothing drawn`);
  await touch('touchStart', [[1, 60, 120]]);
  await touch('touchMove', [[1, 200, 320]]);
  await touch('touchEnd', [[1, 200, 320]]);
  await settle();
  const after = await page.evaluate(() => calls.filter(([k]) => k === 'snipped'));
  if (after.length !== 1 || Math.abs(after[0][3] - 140 / 375) > 1e-6) fail(`snip: the drag after a cancel sent ${JSON.stringify(after)}`);
  await unstub();
  await resize(small);
  // Back mid-drag folds the window with the finger still down; that finger, lifted after, can't block the next snip.
  await open(375, 812, 'right', 120);
  await stub(true);
  await page.click('#sn');
  await touch('touchStart', [[1, 60, 120]]);
  await touch('touchMove', [[1, 200, 320]]);
  await page.evaluate(() => shut());
  await resize(small);
  await touch('touchEnd', [[1, 20, 20]]);
  await unstub();
  await open(375, 812, 'right', 120);
  await stub(true);
  await page.click('#sn');
  await touch('touchStart', [[1, 60, 120]]);
  await touch('touchMove', [[1, 200, 320]]);
  await touch('touchEnd', [[1, 200, 320]]);
  await settle();
  const next = await page.evaluate(() => calls.filter(([k]) => k === 'snipped'));
  if (next.length !== 1 || Math.abs(next[0][3] - 140 / 375) > 1e-6) fail(`snip: after Back mid-drag the next drag sent ${JSON.stringify(next)}`);
  await unstub();
  await resize(small);
  // With the accessibility service off, the scissors say where to turn it on instead, and both buttons go there.
  for (const [width, height, side] of [[320, 700], [375, 812], [412, 915], [768, 1024], [1024, 768], [1280, 800]].flatMap(([w, h]) => [[w, h, 'right'], [w, h, 'left']])) {
    const tag = `snip off ${width}x${height} ${side}`;
    await open(width, height, side, 120);
    await stub(false);
    await page.click('#sn');
    await settle();
    if (await has('snip')) fail(`${tag}: snipping started with the service off`);
    const m = await page.evaluate(() => {
      const n = document.querySelector('#needs');
      return { shown: n.getBoundingClientRect().height, spill: [...n.querySelectorAll('p, button')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent), small: [...n.querySelectorAll('button')].filter((e) => e.getBoundingClientRect().height < 34).length };
    });
    if (!m.shown) fail(`${tag}: the panel doesn't say where to turn it on`);
    if (m.spill.length || m.small) fail(`${tag}: ${m.spill.join(' | ')} spills, ${m.small} buttons under 34px`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) fail(`${tag}: scrolls sideways`);
    const off = await outOfView();
    if (off.length) fail(`${tag}: off screen: ${off.slice(0, 4).join(' | ')}`);
    await page.screenshot({ path: path.join(shots, `snip-off-${width}-${side}.png`) });
    await page.click('#needs [data-settings="app"]');
    await page.click('#needs [data-settings="accessibility"]');
    const asked = await page.evaluate(() => calls.filter(([k]) => k === 'settings').map(([, w]) => w).join());
    if (asked !== 'app,accessibility') fail(`${tag}: the buttons asked for ${asked}`);
    await unstub();
    if (!(await closes(() => page.mouse.click(side === 'right' ? 20 : width - 20, height - 30)))) fail(`${tag}: a tap outside didn't close the panel`);
    await resize(small);
    if (await page.$eval('#needs', (n) => !n.hidden)) fail(`${tag}: the note is still there for next time`);
  }

  // Each change goes to the PC as JSON and comes back as the PC's state.
  await open(412, 915, 'right', 120);
  await page.click('#mn');
  await page.waitForSelector('#prefs .sw');
  posts.length = 0;
  await page.click('#prefs [data-theme="paper"]');
  await until(() => document.querySelector('[data-theme="paper"]').getAttribute('aria-pressed') === 'true', 'theme: Paper marked chosen');
  await settle();
  const painted = await page.evaluate(() => document.documentElement.style.cssText);
  if (!posts.some((p) => p.type === 'application/json' && p.body.theme === 'paper')) fail(`theme: the PC got ${JSON.stringify(posts)}`);
  if (!painted.includes('--bg:') || pc.theme !== 'paper') fail(`theme: the page wears "${painted.slice(0, 40)}", the PC "${pc.theme}"`);
  await page.screenshot({ path: path.join(shots, 'settings-412-paper.png') });
  await page.click('#prefs [data-provider="codex"]');
  await until((n) => document.querySelectorAll('#cells .cell').length === n, 'providers: Codex off the tab', COUNT - 1);
  // The tab shrinks to the ones left, and they still fit inside it.
  await settle();
  const fewer = await rect(page, '#tab');
  if (!near(fewer.b - fewer.t, TAB - 40.5)) fail(`providers: with one fewer the tab is ${(fewer.b - fewer.t).toFixed(1)} tall`);
  const tight = await page.evaluate(({ t, b }) => [...document.querySelectorAll('#tab .dial, #tab b')].filter((e) => { const x = e.getBoundingClientRect(); return x.top < t + 4 || x.bottom > b - 4; }).length, fewer);
  if (tight) fail(`providers: with one fewer, ${tight} rings or numbers crowd the tab's ends`);
  if (!posts.some((p) => p.body.enabled && !p.body.enabled.includes('codex') && p.body.enabled.length === COUNT - 1)) fail(`providers: the PC got ${JSON.stringify(posts.at(-1))}`);
  await page.click('#prefs [data-provider="codex"]');
  await until((n) => document.querySelectorAll('#cells .cell').length === n, 'providers: Codex back on the tab', COUNT);
  await page.click('#prefs [data-choice="claude"][data-row="Session"]');
  await until(() => document.querySelector('[data-choice="claude"][data-row="Session"]').getAttribute('aria-pressed') === 'true', 'summary: Session marked chosen');
  if (pc.choices.claude !== 'Session') fail(`summary: the PC has ${JSON.stringify(pc.choices)}`);
  // A theme picked on the PC lands here without a reload.
  pc.theme = 'aurora-glow';
  tell();
  await until((c) => document.documentElement.style.cssText.includes(c), 'sync: a theme pushed from the PC shows', '#050b14');
  // A slow read, or a slow Refresh, must not roll back what the stream has brought since it was asked.
  for (const [refresh, theme, bg] of [[false, 'paper', '#f8f8f5'], [true, 'molten', '#130705']]) {
    const what = refresh ? 'a late Refresh' : 'a late read';
    holdUsage = true;
    await page.evaluate((r) => {
      load(r);
    }, refresh);
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20));
    pc.theme = theme;
    tell();
    await until((c) => document.documentElement.style.cssText.includes(c), `${what}: the streamed theme shows first`, bg);
    release?.();
    release = null;
    await new Promise((r) => setTimeout(r, 300));
    const after = await page.evaluate((c) => ({ theme: data.theme, painted: document.documentElement.style.cssText.includes(c), reached }), bg);
    if (after.theme !== theme || !after.painted) fail(`${what} rolled the theme back to ${after.theme}`);
    if (!after.reached) fail(`${what}: the page thinks the PC is out of reach`);
  }
  // The same with the stream cut while the answer is on its way, and its reconnections held so a reconnect's
  // fresh state can't hide the rollback. Whether the stream is open as the answer lands can't tell: the
  // stream brought newer state, then dropped. A read, a Refresh and a settings change alike.
  for (const [kind, theme, start] of [
    ['read', 'paper', () => page.evaluate(() => { window.pending = load(false); })],
    ['Refresh', 'molten', () => page.evaluate(() => { window.pending = load(true); })],
    ['settings reply', 'aurora-glow', () => page.evaluate(() => { window.pending = post({ choices: { claude: 'All models' } }).catch(() => {}); })],
  ]) {
    const what = `a ${kind} landing after the stream dropped`;
    pc.theme = 'noir';
    tell();
    await until(() => data.theme === 'noir' && es.readyState === EventSource.OPEN, `${what}: Noir to start, stream open`);
    if (kind === 'settings reply') holdSettings = true;
    else holdUsage = true;
    await start();
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20));
    if (!release) fail(`${what}: the request never reached the PC`);
    pc.theme = theme;
    tell();
    await until((t) => data.theme === t, `${what}: the streamed theme lands first`, theme);
    cut();
    await until(() => es.readyState !== EventSource.OPEN, `${what}: the stream drops`);
    release?.();
    release = null;
    await page.evaluate(() => window.pending);
    const after = await page.evaluate(() => ({ theme: data.theme, stream: es.readyState, reached }));
    if (after.theme !== theme) fail(`${what} rolled the theme back to ${after.theme} (stream readyState ${after.stream})`);
    if (!after.reached) fail(`${what}: the page thinks the PC is out of reach`);
    reopen();
    await until(() => es.readyState === EventSource.OPEN, `${what}: the stream comes back`);
  }
  // Two settings changes in flight at once, with the stream down so it can't put things right: the first
  // one's answer is the older, and landing after the second's it must not undo it.
  pc.theme = 'noir';
  tell();
  await until(() => data.theme === 'noir' && es.readyState === EventSource.OPEN, 'overlap: Noir to start, stream open');
  cut();
  await until(() => es.readyState !== EventSource.OPEN, 'overlap: the stream drops');
  holdSettings = true;
  await page.evaluate(() => {
    window.first = post({ theme: 'paper' }).catch(() => {});
  });
  for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20));
  const firstAnswer = release;
  release = null;
  await page.evaluate(() => post({ theme: 'molten' }));
  await until(() => data.theme === 'molten', 'overlap: the second change lands');
  firstAnswer?.();
  await page.evaluate(() => window.first);
  const overlapped = await page.evaluate(() => data.theme);
  if (overlapped !== 'molten') fail(`overlap: the first change's late answer undid the second: the page wears ${overlapped}, the PC molten`);
  reopen();
  await until(() => es.readyState === EventSource.OPEN, 'overlap: the stream comes back');
  // The size is the phone's own: the PC hears nothing of it.
  posts.length = 0;
  await page.click('#prefs [data-size="1.2"]');
  if (posts.length) fail(`size: the PC got ${JSON.stringify(posts)}`);
  await closes(() => page.mouse.click(20, 885));
  // ---- turning the screen with the panel open, on either edge: the tab follows its edge, nothing leaves the screen
  await page.evaluate(() => setSize(1));
  for (const side of ['right', 'left']) {
    await open(812, 375, side, 120);
    await openCheck(`rotate ${side} at 812x375`, 812, 375, side);
    for (const [width, height] of [[375, 812], [812, 375]]) {
      await resize({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await reanchor(`rotate ${side} to ${width}x${height}`, width, height, side, 120);
      await openCheck(`rotate ${side} to ${width}x${height}`, width, height, side);
      await page.screenshot({ path: path.join(shots, `rotate-${side}-${width}x${height}.png`) });
    }
    await closes(() => page.mouse.click(side === 'right' ? 20 : 792, 340));
  }

  // ---- a new size with the panel open, at the five widths and on either edge, from the bottom of the screen:
  // the tab stays flush with its edge and inside the bars, and closes back to that place
  for (const [width, height] of [[320, 700], [375, 812], [768, 1024], [1024, 768], [1280, 800]]) {
    for (const side of ['right', 'left']) {
      await page.evaluate(() => setSize(1));
      const wy = height - 48 - windowFor(1).height; // as low as the tab goes, so Large has to rise
      await open(width, height, side, wy);
      await page.click('#mn');
      await page.waitForSelector('#prefs [data-size]');
      for (const z of [1.2, 0.85, 1]) {
        const tag = `size ${z} while open, ${width}x${height} ${side}`;
        await page.click(`#prefs [data-size="${z}"]`);
        // A tap in the settings that redraws them under the finger is still a tap inside the panel. Asked at
        // once: in a browser the close undoes itself a frame later, and on the phone it collapses the panel.
        if (await has('closing')) fail(`${tag}: tapping the size closed the panel`);
        await reanchor(tag, width, height, side, wy, z);
        await openCheck(tag, width, height, side, z);
        if (width === 375 && z !== 1) await page.screenshot({ path: path.join(shots, `size-open-${z}-${side}.png`) });
      }
      await closes(() => page.mouse.click(side === 'right' ? 20 : width - 20, 30));
    }
  }

  for (const z of [1.2, 0.85]) {
    await page.evaluate((z) => setSize(z), z);
    await resize(windowFor(z));
    await page.evaluate(() => dock('right', false));
    await settle();
    const t = await rect(page, '#tab');
    const win = windowFor(z);
    if (t.r > win.width + 0.5 || t.b > win.height || !near(t.r - t.l, 38 * z) || !near(t.b - t.t, TAB * z)) fail(`size ${z}: tab ${t.l},${t.t} to ${t.r},${t.b} in a ${win.width}x${win.height} window`);
    const out = await page.evaluate(({ l, t, r, b }) => [...document.querySelectorAll('#tab .dial, #tab b')].filter((e) => { const x = e.getBoundingClientRect(); return x.left < l + 1 || x.right > r - 1 || x.top < t || x.bottom > b; }).length, t);
    if (out) fail(`size ${z}: ${out} rings or numbers outside the tab`);
    await page.screenshot({ path: path.join(shots, `tab-size-${z}.png`), omitBackground: true });
  }

  // The PC restarted: the new run numbers from 1 again, and still wins over the old run's higher numbers.
  run = 'stand-in, restarted';
  revs = 0;
  pc.theme = 'paper';
  tell();
  await until(() => data.theme === 'paper' && data.run === 'stand-in, restarted', 'restart: the new run lands');
  // A run the page has seen replaced can't come back: a late snapshot from before the restart, however high its
  // number, must not undo the new run, while the new run's low numbers still land. Fed straight to take(), the
  // one door every snapshot goes through.
  const comeback = await page.evaluate(() => {
    const base = { ...data };
    take({ ...base, run: 'old run', rev: 99, theme: 'noir' });
    take({ ...base, run: 'new run', rev: 1, theme: 'paper' });
    take({ ...base, run: 'old run', rev: 100, theme: 'noir' });
    return data.theme;
  });
  if (comeback !== 'paper') fail(`restart: a late snapshot from the replaced run rolled the page back to ${comeback}`);
  // A reading saved before snapshots were numbered counts as the oldest: the first numbered one replaces it.
  await page.evaluate(() => localStorage.setItem('usage', JSON.stringify({ css: '', theme: 'gold', enabled: ['claude'], choices: {}, providers: [], at: Date.now() })));
  pc.theme = 'molten';
  await page.reload({ waitUntil: 'load' });
  await until(() => data.theme === 'molten' && Number.isFinite(data.rev), 'unnumbered: a numbered snapshot replaces a saved unnumbered one');

  // ---- switching networks. A read the link ends as it changes ways: one more read, and the PC is still there.
  dropUsage = true;
  server.closeIdleConnections(); // on a reused keep-alive connection Chrome would retry by itself, hiding the page's own
  await page.evaluate(() => load());
  if (dropUsage || !(await page.evaluate(() => reached))) fail(`switch: one ended read ${dropUsage ? 'never happened' : 'says the PC is out of reach'}`);
  // A ping keeps the stream; 45 s with nothing at all (a connection that died without a word) and the page opens
  // another. The page's clock jumps instead of the check waiting it out.
  await until(() => es.readyState === EventSource.OPEN, 'silent: the stream is open');
  const pinged = await page.evaluate(() => (window.before = heard));
  await new Promise((r) => setTimeout(r, 20));
  streams.forEach((res) => res.write('event: ping\ndata: 1\n\n'));
  await until(() => heard > window.before, 'silent: a ping counts as hearing from the PC');
  const streamsBefore = opened;
  await page.evaluate((t) => {
    window.realNow ??= Date.now;
    Date.now = () => t;
  }, pinged + 46_000);
  for (let i = 0; i < 70 && opened === streamsBefore; i++) await new Promise((r) => setTimeout(r, 100));
  await page.evaluate(() => (Date.now = window.realNow));
  if (opened === streamsBefore) fail('silent: a stream quiet for 45 s was kept, never replaced');

  // ---- out of reach, the page draws the reading it saved. A saved balance past its deadline isn't funds:
  // from that moment the line says it expired, with no answer from the PC. Up to it, the balance shows.
  const deadline = Date.parse('2099-10-27T00:00:00Z');
  const saved = providers(false).map((p) => (p.id === 'claude' ? { ...p, apiCredit: { leftCents: 9195, grantedCents: 10000, expiresAt: deadline } } : p));
  await page.evaluate((list) => localStorage.setItem('usage', JSON.stringify({ css: '', theme: 'noir', enabled: list.map((p) => p.id), choices: {}, providers: list, run: 'saved', rev: 1, at: Date.now() })), saved);
  answer = 'down';
  await page.reload({ waitUntil: 'load' });
  await until(() => document.body.classList.contains('away'), 'offline: the page knows the PC is out of reach');
  const creditAt = (at) => page.evaluate((at) => {
    window.realNow ??= Date.now;
    Date.now = () => at;
    draw();
    return [...document.querySelectorAll('#sections .bank, #sections .status')].map((e) => e.textContent);
  }, at);
  const early = await creditAt(deadline - 1);
  if (!early.includes('$91.95 of $100 API credit left, expires Oct 27')) fail(`offline: a saved balance before its deadline should show, the page shows ${JSON.stringify(early)}`);
  const lapsed = await creditAt(deadline);
  if (lapsed.some((t) => t.includes('$91.95')) || !lapsed.includes('API credit expired Oct 27, waiting for a fresh reading.')) fail(`offline: a saved balance at its deadline should be gone, the page shows ${JSON.stringify(lapsed)}`);
  // The expired line at every width, the clock held at the deadline, at the size the open checks measure.
  await page.evaluate(() => setSize(1));
  for (const [width, height] of [[320, 700], [375, 812], [768, 1024], [1024, 768], [1280, 800]]) {
    await open(width, height, 'right', 120);
    await openCheck(`offline expired ${width}x${height}`, width, height, 'right');
    if (width === 320) await page.screenshot({ path: path.join(shots, 'open-offline-expired-320.png') });
    await closes(() => page.evaluate(() => shut()));
    await resize(small);
  }
  await page.evaluate(() => (Date.now = window.realNow));
  answer = 'ok';

  // ---- against main.js itself, the review's order: the page's first read waits on a slow provider; the
  // stream opens meanwhile on the cached 10% and then drops, its reconnections held; the read then answers
  // with the fresh 80%. That answer arrives last but was made last: the page must take it.
  realPc.last.set('claude', { rows: [{ label: 'Weekly', percent: 10 }], updatedAt: 1 });
  realPc.gate.delete('claude');
  let finish = null;
  held.read = () => new Promise((r) => (finish = r));
  const fresh = await browser.createBrowserContext(); // nothing saved from the stand-in's pages
  const phone = await fresh.newPage();
  phone.on('pageerror', (e) => fail('page error against main.js: ' + e.message));
  await phone.setViewport(small);
  await phone.goto(realUrl, { waitUntil: 'load' });
  const percent = () => phone.evaluate(() => ({ percent: data?.providers?.[0]?.rows?.[0]?.percent, stream: es?.readyState, rev: data?.rev }));
  try {
    await phone.waitForFunction(() => data?.providers?.[0]?.rows?.[0]?.percent === 10 && es.readyState === EventSource.OPEN, { timeout: 5000 });
    for (let i = 0; i < 100 && !finish; i++) await new Promise((r) => setTimeout(r, 20));
    if (!finish) fail('against main.js: the first read never reached the provider');
    cutReal = true;
    realStreams.forEach((res) => res.destroy());
    realStreams.clear();
    await phone.waitForFunction(() => es.readyState !== EventSource.OPEN, { timeout: 5000 });
    finish?.({ rows: [{ label: 'Weekly', percent: 80 }], updatedAt: 2 });
    try {
      await phone.waitForFunction(() => data.providers[0].rows[0].percent === 80, { timeout: 4000 });
    } catch {
      fail(`against main.js: the fresh read was thrown away: the PC has 80%, the page keeps ${JSON.stringify(await percent())}`);
    }
  } catch (e) {
    fail(`against main.js: ${e.message.split('\n')[0]}; the page shows ${JSON.stringify(await percent())}`);
  }
  cutReal = false;
  realWaiting.splice(0).forEach(([req, res]) => realHandler(req, res));
  await fresh.close();
} finally {
  await browser.close();
  server.close();
  realServer.close();
  fs.rmSync(pcDir, { recursive: true, force: true });
}
console.log(failures.length ? `${failures.length} failures` : `ok, screenshots in ${shots}`);
process.exit(failures.length ? 1 : 0);
