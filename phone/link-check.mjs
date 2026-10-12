// Checks the phone link end to end on this PC: Link.java (the phone's half, on a desktop JVM, its page ports
// moved up by OFFSET since this PC's own apps hold 7430) against link.js (the PC's half, told the gateway is
// 127.0.0.1). Needs a JDK on PATH, Tailscale up, and port 7499 free. LINK_LOG=1 prints the link's log.
// Usage: node phone/link-check.mjs
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.LINK_GATEWAY = '127.0.0.1';
const link = createRequire(import.meta.url)('../link.js');
const OFFSET = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The phone's half, built for the desktop: Link.java and a main that runs it for the overlay and loom-dev (no
// tailnet port), with a given tailnet name ("-": none) and secret.
const classes = fs.mkdtempSync(path.join(os.tmpdir(), 'link-check-'));
const main = path.join(classes, 'LinkMain.java');
fs.writeFileSync(main, `package com.local.aiusage;
public class LinkMain {
  public static void main(String[] a) throws Exception {
    java.util.Map<String, String> m = new java.util.concurrent.ConcurrentHashMap<>();
    if (System.getenv("LINK_LOG") != null) Link.log = System.err::println;
    m.put("secret", a[1]);
    Link.App[] apps = { new Link.App("overlay", 7430, 8443), new Link.App("loom-dev", 7421, 0) };
    new Link(a[0].equals("-") ? "" : a[0], new Link.Store() {
      public String get(String k) { return m.get(k); }
      public void put(String k, String v) { m.put(k, v); }
    }, apps, 7499, ${OFFSET}).open();
    System.out.println("ready");
    System.out.flush();
    Thread.sleep(Long.MAX_VALUE);
  }
}`);
execFileSync('javac', ['--release', '17', '-d', classes, path.join(here, 'src', 'com', 'local', 'aiusage', 'Link.java'), main], { stdio: 'inherit' });
let phone = null;
// `java` on PATH may be Oracle's launcher, which runs the JVM as its child: end the whole tree.
const kill = (p) => p && p.exitCode === null && execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
async function startPhone(host, secret) {
  if (phone) {
    const gone = new Promise((r) => phone.on('exit', r));
    kill(phone);
    await gone; // its ports let go
  }
  phone = spawn('java', ['-cp', classes, 'com.local.aiusage.LinkMain', host || '-', secret], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    phone.stdout.on('data', (d) => String(d).includes('ready') && resolve());
    phone.on('exit', (code) => reject(new Error(`the phone's half exited (${code})`)));
  });
}

// A stand-in for the PC's app: it says what it got, so an answer proves the hotspot path carried it.
const app = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c)).on('end', () => res.end(`via link ${req.method} ${req.url} ${req.headers.host} ${body.length}`));
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));

const get = (port, p, { method = 'GET', body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: 'localhost', port, path: p, method, agent: false }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c)).on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject);
  req.end(body);
});
const page = 7430 + OFFSET;

let stop = () => {};
try {
  const key = link.secret();
  assert.match(key, /^[0-9a-f]{64}$/, 'the shared secret file');
  assert.strictEqual(link.hmac('Jefe', 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'RFC 4231 case 2');
  assert.deepStrictEqual(link.gateways('  0.0.0.0          0.0.0.0     192.168.1.1     192.168.1.15     35\n  0.0.0.0          0.0.0.0     100.100.1.1     100.94.6.17      5\n  0.0.0.0          0.0.0.0      10.149.184.129  10.149.184.102  25\n'), ['10.149.184.129', '192.168.1.1'], 'private gateways, best metric first');

  // 1. No Tailscale name: with the PC on the hotspot, everything goes that way.
  await startPhone('', key);
  assert.strictEqual(await link.connect('127.0.0.1', 'overlay', app.address().port, 'f'.repeat(64), () => {}), false, 'a wrong secret is refused');
  assert.strictEqual(await link.connect('127.0.0.1', 'nobody', app.address().port, key, () => {}), false, 'an unknown app is refused');
  stop = link.start('overlay', app.address().port);
  await sleep(2500); // the pool fills
  assert.strictEqual((await get(page, '/api/usage')).text, `via link GET /api/usage localhost:${page} 0`, 'over the hotspot, Host untouched');
  const post = await get(page, '/api/settings', { method: 'POST', body: 'x'.repeat(100_000) });
  assert.strictEqual(post.text, `via link POST /api/settings localhost:${page} 100000`, 'a body arrives whole');
  const burst = await Promise.all(Array.from({ length: 15 }, (_, i) => get(page, `/b${i}`)));
  assert.ok(burst.every((r, i) => r.text.startsWith(`via link GET /b${i} `)), 'a burst past the pool waits for new connections');
  await sleep(11_000); // past a ping
  assert.ok((await get(page, '/after-ping')).text.startsWith('via link GET /after-ping'), 'waiting connections survive a ping');
  await assert.rejects(get(7421 + OFFSET, '/'), 'loom-dev: no PC of its own on the hotspot, and no tailnet port');

  // 2. Tailscale works: it wins, though the PC is on the hotspot too.
  const host = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' })).Self.DNSName.replace(/\.$/, '');
  await startPhone(host, key);
  await sleep(6000); // link.js backs off 5 s after the old phone went, then fills the new one's pool
  const tailnet = await get(page, '/api/usage');
  assert.strictEqual(tailnet.status, 200, `over Tailscale to ${host}:8443: ${tailnet.text.slice(0, 120)}`);
  assert.ok(JSON.parse(tailnet.text).providers, 'the real overlay answered, not the hotspot stand-in');

  // 3. A Tailscale name that doesn't answer (this PC's loopback, nothing on 8443): the hotspot takes over.
  await startPhone('localhost', key);
  await sleep(6000);
  assert.ok((await get(page, '/down')).text.startsWith('via link GET /down'), 'Tailscale down: over the hotspot');
  console.log('link-check: all passed');
} finally {
  stop();
  kill(phone);
  app.close();
  fs.rmSync(classes, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100);
}
