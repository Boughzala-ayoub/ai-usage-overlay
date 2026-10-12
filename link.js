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
      if (stage === 'waiting') freed();
      if (stage === 'connecting' || stage === 'proving') resolve(false);
      stage = 'done';
      s.destroy();
    };
    s.setTimeout(3000); // to connect and prove itself; waiting, the phone pings every 10 s
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
    };
    s.on('data', onData);
  });
}

/** Keeps POOL connections waiting at the phone whenever this PC's gateway is the phone's link. */
function start(name, port) {
  let waiting = 0;
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
      const proved = await Promise.all(Array.from({ length: n }, () => connect(gw, name, port, key, () => waiting--)));
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
  return () => clearInterval(timer);
}

module.exports = { PORT, SECRET_FILE, hmac, secret, gateways, gateway, connect, start };
