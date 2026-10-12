'use strict';
// The PC's half of the phone link (phone/src/com/local/aiusage/Link.java, where the protocol is described).
// On the phone's own hotspot Tailscale can't reach the phone (tailscale/tailscale#20782), so the phone listens on
// its hotspot address, port 7499, and this connects out to it as the PC's gateway. Both prove they know the
// secret the phone read from /api/link over Tailscale. Each connection then waits for the phone's "GO" and
// pipes one of the phone page's connections to this PC's own port. Only outgoing connections: nothing new
// listens here, so no firewall asks, and a café's network sees nothing new. Loom does the same in link.rs.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const PORT = 7499;
const POOL = 6; // waiting connections: a page opens a few at once
// One secret for every app on this PC that speaks the link (Loom too), so the phone needs only one.
const SECRET_FILE = path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'phone-link', 'secret');

const hmac = (secret, message) => crypto.createHmac('sha256', secret).update(message).digest('hex');

function secret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  try {
    fs.writeFileSync(SECRET_FILE, s, { flag: 'wx' }); // Loom may be making it at the same moment: the first one wins
    return s;
  } catch {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  }
}

/** `route print`'s default routes, through private gateways only, best metric first. */
function gateways(out) {
  return [...String(out).matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\d+)\s*$/gm)]
    .map((m) => ({ ip: m[1], metric: +m[2] }))
    .filter((r) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(r.ip))
    .sort((a, b) => a.metric - b.metric)
    .map((r) => r.ip);
}

const gateway = () =>
  process.env.LINK_GATEWAY // a test's stand-in phone on this PC
    ? Promise.resolve(process.env.LINK_GATEWAY)
    : new Promise((resolve) => execFile('route', ['print', '-4', '0.0.0.0'], { windowsHide: true, timeout: 5000 }, (_, out) => resolve(gateways(out)[0] || null)));

/**
 * One connection to the phone at `gw`: proves itself, then waits. Resolves true once both sides are proven,
 * false if the gateway isn't the phone's link. `freed` runs once when it stops waiting, used or dropped.
 */
function connect(gw, name, port, key, freed) {
  return new Promise((resolve) => {
    const s = net.connect({ host: gw, port: PORT });
    const mine = crypto.randomBytes(16).toString('hex');
    let stage = 'connecting'; // then 'proving', 'waiting', 'piping', 'done'
    let theirs = '';
    let buf = '';
    const end = () => {
      if (stage === 'done') return;
      clearTimeout(deadline);
      if (stage === 'waiting') freed();
      if (stage === 'connecting' || stage === 'proving') resolve(false);
      stage = 'done';
      s.destroy();
    };
    // To connect and prove itself, however the gateway paces its bytes; waiting, the phone pings every 10 s.
    const deadline = setTimeout(end, 3000);
    s.setNoDelay(true);
    s.on('timeout', end).on('error', end).on('close', () => stage !== 'piping' && end());
    s.on('connect', () => (stage = 'proving'));
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (stage === 'proving' && !theirs) {
          const m = /^LINK1 ([0-9a-f]{32})$/.exec(line);
          if (!m) return end();
          theirs = m[1];
          s.write(`${name} ${mine} ${hmac(key, `pc|${name}|${theirs}|${mine}`)}\n`);
        } else if (stage === 'proving') {
          if (line !== hmac(key, `phone|${name}|${theirs}|${mine}`)) return end();
          stage = 'waiting';
          clearTimeout(deadline);
          s.setTimeout(30_000);
          resolve(true);
        } else if (stage === 'waiting' && line === 'P') {
          s.write('P\n');
        } else if (stage === 'waiting' && line === 'GO') {
          freed();
          stage = 'piping';
          s.removeListener('data', onData);
          s.setTimeout(0);
          const local = net.connect({ host: '127.0.0.1', port }, () => {
            s.write('OK\n');
            s.pipe(local);
            local.pipe(s);
          });
          local.on('error', () => s.destroy());
          local.on('close', () => s.destroy());
          s.on('close', () => local.destroy());
          return;
        } else return end();
      }
      if (buf.length > 300) end(); // no line of the link's is this long: a peer that never ends one is cut off
    };
    s.on('data', onData);
  });
}

const tailscale = (args) =>
  new Promise((resolve) => execFile('tailscale', args, { windowsHide: true, timeout: 15_000 }, (err, out) => resolve(err ? null : String(out))));

async function statusOf(run) {
  try {
    return JSON.parse((await run(['status', '--json'])) ?? 'null');
  } catch {
    return null;
  }
}

/**
 * One look at Tailscale's tunnel to the phone, once this PC has left the phone's hotspot. Coming back from it,
 * Tailscale here can keep a frozen session: the phone answers Tailscale's own ping through a relay, and nothing
 * gets through the tunnel, for the bubble, Loom's phone app or Taildrop alike, until Tailscale reconnects on this
 * PC (seen 2026-10-12, after three switches of network in two minutes). Frozen for 90 s, it reconnects: down,
 * then up with no flags, which keeps its settings. Once per 10 minutes at most, and never while Tailscale is off
 * here, unless it was this that turned it off. `w` keeps { frozenAt, fixedAt, down } between looks. Returns what it
 * saw: 'ok', 'frozen', or 'away' (no phone answers at all, which a reconnect here can't help).
 */
async function heal(w, run = tailscale, now = Date.now()) {
  const status = await statusOf(run);
  // Its own down that no up has undone yet: up on every look until one does. Stopped once that's done, it's the
  // user's doing, and left alone.
  if (w.down && (!status || status.BackendState === 'Stopped')) {
    if ((await run(['up'])) !== null) w.down = false;
    return 'away';
  }
  w.down = false;
  const seen = [];
  if (status?.BackendState === 'Running') {
    // ponytail: every Android device of this PC's owner that's online counts as the phone; name it if that's ever wrong
    for (const p of Object.values(status.Peer || {})) {
      if (p.OS !== 'android' || !p.Online || p.UserID !== status.Self?.UserID || !p.TailscaleIPs?.[0]) continue;
      const ip = p.TailscaleIPs[0];
      if ((await run(['ping', '--tsmp', '--c', '1', '--timeout', '4s', ip])) !== null) seen.push('ok');
      else if ((await run(['ping', '--until-direct=false', '--c', '1', '--timeout', '4s', ip])) !== null) seen.push('frozen');
    }
  }
  const state = seen.includes('frozen') ? 'frozen' : seen.includes('ok') ? 'ok' : 'away';
  if (state !== 'frozen') w.frozenAt = 0;
  else if (!w.frozenAt) w.frozenAt = now;
  else if (now - w.frozenAt >= 90_000 && now - w.fixedAt >= 600_000) {
    // The pings took seconds. Tailscale turned off since, or the PC back on the hotspot (which clears frozenAt):
    // left as it is.
    const since = w.frozenAt;
    if ((await statusOf(run))?.BackendState !== 'Running' || w.frozenAt !== since) return state;
    w.fixedAt = now;
    w.down = true;
    await run(['down']);
    await new Promise((r) => setTimeout(r, 3000));
    // Up whatever down answered, and again if the first doesn't take: left down, nothing reaches the tailnet.
    if ((await run(['up'])) !== null || (await run(['up'])) !== null) w.down = false;
  }
  return state;
}

/** Keeps POOL connections waiting at the phone whenever this PC's gateway is the phone's link. */
function start(name, port) {
  let waiting = 0;
  let proven = 0; // of those, the ones the phone has taken: the PC is on its hotspot
  let left = false; // the PC has been on the hotspot, and Tailscale to the phone hasn't been seen working since
  let looking = false;
  const w = { frozenAt: 0, fixedAt: 0, down: false };
  let busy = false;
  let retryAt = 0;
  let key = null;
  let gw = null;
  let gwAt = 0; // when `route print` last said: while connections keep working, it's asked every 10 s at most
  const tick = async () => {
    if (busy || waiting >= POOL || Date.now() < retryAt) return;
    busy = true;
    try {
      key = key || secret();
      if (!gw || Date.now() - gwAt > 10_000) [gw, gwAt] = [await gateway(), Date.now()];
      if (!gw) {
        retryAt = Date.now() + 5000;
        return;
      }
      // Every missing one at once: a page that just used several wants them back before it asks again.
      const n = POOL - waiting;
      waiting += n;
      // Each one proven means the PC is on the hotspot again: a look still out at the watcher loses its frozen time.
      const proved = await Promise.all(Array.from({ length: n }, () =>
        connect(gw, name, port, key, () => (waiting--, proven--)).then((ok) => (ok && (proven++, (left = true), (w.frozenAt = 0)), ok))));
      const failed = proved.filter((ok) => !ok).length;
      waiting -= failed;
      if (failed === n) {
        // ponytail: one back-off for a gateway that isn't the phone and for a phone that's away; every 5 s costs a
        // `route print` and a refused connection to the router at home
        retryAt = Date.now() + 5000;
        [key, gw] = [null, null]; // both read again: Loom may have just made the file, the network may have changed
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => tick().catch(() => {}), 100);
  // Off the hotspot, Tailscale to the phone is watched until it's seen working. Not on it: the link carries the
  // pages there, and a reconnect would only bring the hotspot's own Tailscale bug back within minutes.
  // A down of its own that no up has undone is looked at on the hotspot too: those looks only bring Tailscale back.
  // ponytail: a phone that stays away keeps this asking `tailscale status` every 15 s until it's back
  const watcher = setInterval(() => {
    if (proven > 0) w.frozenAt = 0;
    if (looking || (!w.down && (!left || proven > 0))) return;
    looking = true;
    return heal(w) // for a check to wait on
      .then((state) => state === 'ok' && (left = false))
      .catch(() => {})
      .finally(() => (looking = false));
  }, 15_000);
  return () => (clearInterval(timer), clearInterval(watcher));
}

module.exports = { PORT, SECRET_FILE, hmac, secret, gateways, gateway, connect, heal, start };
