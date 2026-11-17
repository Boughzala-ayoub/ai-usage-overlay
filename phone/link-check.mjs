// Checks the phone link end to end on this PC: Link.java (the phone's half, on a desktop JVM, its page ports
// moved up by OFFSET since this PC's own apps hold 7430) against link.js (the PC's half, told the gateway is
// 127.0.0.1). Needs a JDK on PATH, Tailscale up, and port 7499 free. LINK_LOG=1 prints the link's log.
// "offline" runs only the first checks, which need neither Tailscale nor the shared secret: they run
// Link.start on ports of their own with a made-up secret.
// Usage: node phone/link-check.mjs [offline]
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
    Link link = new Link(a[0].equals("-") ? "" : a[0], new Link.Store() {
      public String get(String k) { return m.get(k); }
      public void put(String k, String v) { m.put(k, v); }
    }, apps, 7499, ${OFFSET});
    link.open();
    System.out.println("ready " + link.key); // the page's key, which the bubble's WebView holds as a cookie
    System.out.flush();
    Thread.sleep(Long.MAX_VALUE);
  }
}`);
// The checks that need no PC: Link.start and Link.end as the bubble calls them, with stand-ins for the PC.
const checks = path.join(classes, 'LinkChecks.java');
fs.writeFileSync(checks, `package com.local.aiusage;
import java.io.*;
import java.net.*;
import java.util.Map;
import java.util.concurrent.*;
public class LinkChecks {
  static final String SECRET = "ab".repeat(32);
  static void check(boolean ok, String what) {
    if (!ok) throw new AssertionError(what);
  }
  /** The PC on this hotspot, as link.js is: it proves itself on the link's PC port, then waits for a page. */
  static Socket pc(int port) throws Exception {
    Socket s = new Socket(InetAddress.getLoopbackAddress(), port);
    s.setSoTimeout(5000);
    String nonce = Link.line(s).substring("LINK1 ".length()), mine = "cd".repeat(16);
    Link.write(s, "overlay " + mine + " " + Link.hmac(SECRET, "pc|overlay|" + nonce + "|" + mine));
    check(Link.line(s).equals(Link.hmac(SECRET, "phone|overlay|" + nonce + "|" + mine)), "the link proves itself to the PC");
    return s;
  }
  /** A request as the bubble's WebView sends it, with the link's key in its cookie unless it's null. */
  static void send(Socket s, String start, String key, String more, String body) throws IOException {
    String cookie = key == null ? "" : "Cookie: " + Link.COOKIE + "=" + key + "\\r\\n";
    s.getOutputStream().write((start + " HTTP/1.1\\r\\nHost: localhost:7430\\r\\n" + cookie + more + "Content-Length: " + body.length() + "\\r\\n\\r\\n" + body).getBytes("ISO-8859-1"));
  }
  /** What reached the PC: a request's head through its blank line, then n bytes of body. */
  static String got(Socket pc, int n) throws IOException {
    StringBuilder b = new StringBuilder();
    for (String l; !(l = Link.line(pc)).equals("\\r");) b.append(l, 0, l.length() - 1).append('\\n'); // less its \\r
    for (int i = 0; i < n; i++) b.append((char) pc.getInputStream().read());
    return b.toString();
  }
  /** The PC on the hotspot, waiting, and a page's connection that sent a request with the key and took it. */
  static Socket[] piped(Link link, int page, int pcPort) throws Exception {
    Socket pc = pc(pcPort);
    for (int i = 0; i < 500 && link.idle.get("overlay").isEmpty(); i++) Thread.sleep(10);
    Socket p = new Socket(InetAddress.getLoopbackAddress(), page);
    p.setSoTimeout(5000);
    send(p, "GET /api/usage", link.key, "", "");
    check("GO".equals(Link.line(pc)), "a page's request takes the PC's waiting connection");
    Link.write(pc, "OK");
    check(got(pc, 0).equals("GET /api/usage HTTP/1.1\\nHost: localhost:7430\\nContent-Length: 0\\n"), "the page's request reaches the PC, without the key");
    pc.getOutputStream().write('y');
    check(p.getInputStream().read() == 'y', "the PC reaches the page");
    return new Socket[] { p, pc };
  }
  /** The link answered 403 and closed the connection (readAllBytes runs to its end, or throws after 5 s). */
  static boolean refused(Socket p) throws IOException {
    return Link.line(p).startsWith("HTTP/1.1 403 ") && new String(p.getInputStream().readAllBytes(), "ISO-8859-1").endsWith("\\r\\n\\r\\n");
  }
  /** The link let go of this connection: EOF or a reset, not a read that waits. */
  static boolean ended(Socket s) {
    try {
      return s.getInputStream().read() == -1;
    } catch (SocketTimeoutException e) {
      return false;
    } catch (IOException e) {
      return true;
    }
  }
  static int free() throws Exception {
    try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) { return s.getLocalPort(); }
  }
  // Each PC's GET /api/link as the link's HttpURLConnection sees it: x.test's secret is "x" 64 times. a.test, a
  // slow PC, holds its answer until let go.
  static CountDownLatch asked, let, answered, bKept, writing, hold; // hold: a.test's secret waits in Store.put
  static Thread asking;
  static void answers() {
    URL.setURLStreamHandlerFactory(protocol -> !protocol.equals("https") ? null : new URLStreamHandler() {
      protected URLConnection openConnection(URL u) {
        return new HttpURLConnection(u) {
          public void connect() {}
          public void disconnect() {}
          public boolean usingProxy() { return false; }
          public int getResponseCode() { return 200; }
          public InputStream getInputStream() throws IOException {
            if (u.getHost().equals("a.test")) {
              asking = Thread.currentThread();
              asked.countDown();
              try {
                let.await();
              } catch (InterruptedException e) {
                throw new IOException(e);
              }
              answered.countDown();
            }
            return new ByteArrayInputStream(("{\\"secret\\":\\"" + u.getHost().substring(0, 1).repeat(64) + "\\"}").getBytes());
          }
        };
      }
    });
  }
  /** Lets a.test answer, then waits until the stopped link that asked is done with that answer. */
  static void lateAnswer() throws Exception {
    let.countDown();
    check(answered.await(5, TimeUnit.SECONDS), "a.test answers");
    asking.interrupt(); // out of its sleep, a stopped link's fetch loop ends
    asking.join(5000);
    check(!asking.isAlive(), "the stopped link's fetch ends");
  }
  /** A stand-in for tailscale serve on a port of its own: accept() returns once the link dials it. */
  static ServerSocket serve() throws Exception {
    ServerSocket s = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
    s.setSoTimeout(5000);
    return s;
  }
  public static void main(String[] a) throws Exception {
    if (System.getenv("LINK_LOG") != null) Link.log = System.err::println;
    Map<String, String> m = new ConcurrentHashMap<>(Map.of("secret", SECRET));
    Link.Store store = new Link.Store() {
      public String get(String k) { return m.get(k); }
      public void put(String k, String v) { m.put(k, v); }
    };
    int page = free(), pc = free();
    ServerSocket first = serve(), second = serve();
    Link.start("localhost", store, new Link.App[] { new Link.App("overlay", page, first.getLocalPort()) }, pc);
    Link one = Link.running;
    first.accept().close(); // its secret's fetch: the address's own port, whatever it is
    first.close(); // Tailscale refuses from here on, so pages go over the hotspot
    Link.start("localhost", store, new Link.App[] { new Link.App("overlay", page, first.getLocalPort()) }, pc);
    check(Link.running == one, "the same address keeps its link");
    Socket[] old = piped(one, page, pc);
    Link.start("localhost", store, new Link.App[] { new Link.App("overlay", page, second.getLocalPort()) }, pc);
    check(Link.running != one && one.stopped, "a new port alone starts the link over");
    check(ended(old[0]) && ended(old[1]), "the old link's live page and PC connections end with it");
    second.accept().close();
    second.close();
    Socket[] live = piped(Link.running, page, pc);
    Link.end();
    check(Link.running == null, "Link.end leaves no link");
    check(ended(live[0]) && ended(live[1]), "Link.end ends the live page and PC connections too");

    // A link stopped while its PC was still answering never keeps that answer.
    answers();
    Map<String, String> keys = new ConcurrentHashMap<>();
    Link.Store kept = new Link.Store() {
      public String get(String k) { return keys.get(k); }
      public void put(String k, String v) {
        if (hold != null && v.startsWith("a")) {
          writing.countDown();
          try {
            hold.await();
          } catch (InterruptedException e) {
            throw new IllegalStateException(e);
          }
        }
        keys.put(k, v);
        if (v.startsWith("b")) bKept.countDown();
      }
    };
    Link.App[] apps = { new Link.App("overlay", page, 8443) };
    String b = "b".repeat(64);
    asked = new CountDownLatch(1);
    let = new CountDownLatch(1);
    answered = new CountDownLatch(1);
    bKept = new CountDownLatch(1);
    Link.start("a.test", kept, apps, pc);
    check(asked.await(5, TimeUnit.SECONDS), "a.test is asked for its secret");
    Link.start("b.test", kept, apps, pc);
    check(bKept.await(5, TimeUnit.SECONDS), "the replacement keeps b.test's secret");
    lateAnswer();
    check(b.equals(keys.get("secret")), "a replaced link's late answer leaves its replacement's secret");
    asked = new CountDownLatch(1);
    let = new CountDownLatch(1);
    answered = new CountDownLatch(1);
    Link.start("a.test", kept, apps, pc);
    check(asked.await(5, TimeUnit.SECONDS), "a.test is asked again");
    Link.end();
    lateAnswer();
    check(b.equals(keys.get("secret")), "a removed link's late answer leaves the secret it found");
    // A write already under way when the link is replaced: the replacement waits, so its own secret lands last.
    let = new CountDownLatch(0);
    bKept = new CountDownLatch(1);
    writing = new CountDownLatch(1);
    hold = new CountDownLatch(1);
    Link.start("a.test", kept, apps, pc);
    check(writing.await(5, TimeUnit.SECONDS), "a.test's secret is being written");
    Thread replace = new Thread(() -> Link.start("b.test", kept, apps, pc));
    replace.start();
    while (replace.isAlive() && replace.getState() != Thread.State.BLOCKED) Thread.onSpinWait();
    check(replace.getState() == Thread.State.BLOCKED, "the replacement waits for that write");
    hold.countDown();
    check(bKept.await(5, TimeUnit.SECONDS), "then keeps b.test's secret");
    replace.join(5000);
    check(b.equals(keys.get("secret")), "and that secret stays");
    Link.end();

    // The PC left the hotspot while Tailscale was down there: its waiting connection never answers GO. The
    // page's connection tries Tailscale next (the stand-in is dialled) instead of ending with nothing.
    ServerSocket back = serve();
    Link left = new Link("localhost", store, new Link.App[] { new Link.App("overlay", free(), back.getLocalPort()) }, free(), 0);
    left.open();
    Socket gone = pc(left.pcPort);
    for (int i = 0; i < 500 && left.idle.get("overlay").isEmpty(); i++) Thread.sleep(10);
    left.tailnetDown.add("overlay");
    Socket p = new Socket(InetAddress.getLoopbackAddress(), left.apps[0].port());
    send(p, "GET /api/usage", left.key, "", "");
    check("GO".equals(Link.line(gone)), "the hotspot first, while Tailscale is down there");
    long t0 = System.currentTimeMillis();
    back.accept().close(); // throws past 5 s: the link gave up on the hotspot and never tried Tailscale
    check(System.currentTimeMillis() - t0 < 3500, "Tailscale within the GO's 2 s");
    p.close();
    left.stop();

    // Another app on this phone reaches the page's port as well. Without the link's key, the first request on a
    // connection or any later one, nothing reaches the PC by either way, and the PC never sees the key itself.
    ServerSocket ts = serve(); // Tailscale's stand-in: a request that goes on dials it first
    Link guard = new Link("localhost", store, new Link.App[] { new Link.App("overlay", free(), ts.getLocalPort()) }, free(), 0);
    guard.open();
    int port = guard.apps[0].port();
    Socket waiting = pc(guard.pcPort);
    for (int i = 0; i < 500 && guard.idle.get("overlay").isEmpty(); i++) Thread.sleep(10);
    Socket spare = new Socket(InetAddress.getLoopbackAddress(), port); // a connection that never sends a request
    String[][] strangers = {
      { "GET /api/usage", null, "" },
      { "POST /api/settings", "0".repeat(64), "Content-Type: application/json\\r\\n" }, // a key, not this link's
      { "GET /api/usage", null, "Cookie: x" + Link.COOKIE + "=" + guard.key + "\\r\\n" }, // the key under another name
      { "POST /api/settings", guard.key, "Transfer-Encoding: chunked\\r\\n" }, // a body of no stated length
      { "GET /api/events", guard.key, "Upgrade: websocket\\r\\n" },
    };
    for (String[] r : strangers) {
      Socket s = new Socket(InetAddress.getLoopbackAddress(), port);
      s.setSoTimeout(5000);
      send(s, r[0], r[1], r[2], "");
      check(refused(s), "refused: " + String.join(" ", r[0], String.valueOf(r[1]), r[2]));
    }
    ts.setSoTimeout(500);
    try {
      ts.accept().close();
      check(false, "a request without the key dialled Tailscale");
    } catch (SocketTimeoutException e) {
      // nobody dialled
    }
    check(guard.idle.get("overlay").size() == 1, "nor took the PC's waiting connection on the hotspot");
    spare.close();
    // With the key: its body whole, its other cookies kept, the key taken out. The next request on the same
    // connection needs the key too: without it, both ends close and none of it reaches the PC.
    guard.tailnetDown.add("overlay"); // straight to the hotspot, where the PC's end shows what went on
    Socket web = new Socket(InetAddress.getLoopbackAddress(), port);
    web.setSoTimeout(5000);
    String body = "{\\"keepAwake\\":false}";
    send(web, "POST /api/settings", null, "Cookie: a=1; " + Link.COOKIE + "=" + guard.key + "; b=2\\r\\nContent-Type: application/json\\r\\n", body);
    check("GO".equals(Link.line(waiting)), "a request with the key goes on");
    Link.write(waiting, "OK");
    check(got(waiting, body.length()).equals("POST /api/settings HTTP/1.1\\nHost: localhost:7430\\nCookie: a=1; b=2\\nContent-Type: application/json\\nContent-Length: " + body.length() + "\\n" + body), "whole, with its other cookies, without the key");
    waiting.getOutputStream().write("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok".getBytes("ISO-8859-1"));
    check(Link.line(web).equals("HTTP/1.1 200 OK\\r") && got(web, 2).equals("Content-Length: 2\\nok"), "the PC's answer comes back untouched");
    send(web, "GET /api/events", guard.key, "", "");
    check(got(waiting, 0).equals("GET /api/events HTTP/1.1\\nHost: localhost:7430\\nContent-Length: 0\\n"), "the next request with the key goes on, on the same connection");
    send(web, "GET /api/usage", null, "", "");
    check(ended(waiting) && ended(web), "one without it ends the connection, and none of it reaches the PC");
    guard.stop();

    // An app that took one loopback address of the page port first would get the WebView's requests there, key and
    // all, to replay on the other. So then the link serves the page on neither.
    for (String taken : new String[] { "127.0.0.1", "::1" }) {
      String other = taken.equals("::1") ? "127.0.0.1" : "::1";
      try (ServerSocket squatter = new ServerSocket(0, 50, InetAddress.getByName(taken))) {
        int held = squatter.getLocalPort();
        Link squatted = new Link("localhost", store, new Link.App[] { new Link.App("overlay", held, 0) }, free(), 0);
        squatted.open();
        boolean served;
        try (Socket s = new Socket(InetAddress.getByName(other), held)) {
          served = true;
        } catch (IOException e) {
          served = false;
        }
        check(!served, "with " + taken + " taken by another app, the page isn't served on " + other);
        check(!squatted.serving, "and the link says so, so the bubble hands out no key");
        squatted.stop();
      }
    }
    // Link.start never keeps a link that couldn't take its page ports: the next start, once the app lets go, tries again.
    {
      ServerSocket squatter = new ServerSocket(0, 50, InetAddress.getByName("::1"));
      Link.App[] squatted = { new Link.App("overlay", squatter.getLocalPort(), 0) };
      int pcs = free();
      Link refused = Link.start("localhost", store, squatted, pcs);
      check(!refused.serving, "a start with the page port taken serves nothing");
      squatter.close();
      Link again = Link.start("localhost", store, squatted, pcs);
      check(again != refused && refused.stopped && again.serving, "the next start takes the port once it's free");
      Link.end();
    }

    // Any app can open the page's port. A connection that hasn't shown the key takes one of the link's places, for
    // FIRST_MS at most: past them, one is closed as it comes, and none waits on a thread. One that never sends, or
    // drips its head, is closed at that deadline, unanswered, and its place comes back. A connection that showed the
    // key keeps going past it, idle between requests as the page's event stream is.
    ServerSocket ts2 = serve();
    Link busy = new Link("localhost", store, new Link.App[] { new Link.App("overlay", free(), ts2.getLocalPort()) }, free(), 0);
    busy.open();
    int bp = busy.apps[0].port(), places = busy.unproven.availablePermits();
    Socket bpc = pc(busy.pcPort);
    for (int i = 0; i < 500 && busy.idle.get("overlay").isEmpty(); i++) Thread.sleep(10);
    busy.tailnetDown.add("overlay"); // straight to the hotspot
    Socket keyed = new Socket(InetAddress.getLoopbackAddress(), bp);
    keyed.setSoTimeout(8000);
    send(keyed, "GET /api/events", busy.key, "", "");
    check("GO".equals(Link.line(bpc)), "a request with the key goes on");
    Link.write(bpc, "OK");
    check(got(bpc, 0).startsWith("GET /api/events "), "and reaches the PC");
    long opened = System.currentTimeMillis();
    Socket[] idle = new Socket[places];
    for (int i = 0; i < places; i++) {
      idle[i] = new Socket(InetAddress.getLoopbackAddress(), bp);
      idle[i].setSoTimeout(8000);
    }
    Socket drip = idle[0];
    Thread dripping = new Thread(() -> {
      try {
        drip.getOutputStream().write("GET /api/usage HTTP/1.1\\r\\n".getBytes("ISO-8859-1"));
        for (int i = 0; i < 20; i++) {
          Thread.sleep(400);
          drip.getOutputStream().write("X: y\\r\\n".getBytes("ISO-8859-1"));
        }
      } catch (Exception e) {
        // closed by the link
      }
    });
    dripping.setDaemon(true);
    dripping.start();
    for (int i = 0; i < 500 && busy.unproven.availablePermits() > 0; i++) Thread.sleep(10);
    check(busy.unproven.availablePermits() == 0, places + " connections without the key hold every place");
    Socket over = new Socket(InetAddress.getLoopbackAddress(), bp);
    over.setSoTimeout(1000);
    check(ended(over), "one more is closed as it comes");
    check(ended(drip), "a head that drips in is closed, unanswered");
    long took = System.currentTimeMillis() - opened;
    check(took >= Link.FIRST_MS - 500 && took < Link.FIRST_MS + 2500, "at the deadline, however it drips: " + took + " ms");
    for (Socket s : idle) check(ended(s), "a connection that never sent a request is closed, unanswered");
    for (int i = 0; i < 500 && busy.unproven.availablePermits() < places; i++) Thread.sleep(10);
    check(busy.unproven.availablePermits() == places, "and every place comes back");
    send(keyed, "GET /api/usage", busy.key, "", "");
    check(got(bpc, 0).startsWith("GET /api/usage "), "the connection that showed the key takes its next request past the deadline");
    busy.stop();
    ts2.close();
  }
}`);
execFileSync('javac', ['--release', '17', '-d', classes, path.join(here, 'src', 'com', 'local', 'aiusage', 'Link.java'), main, checks], { stdio: 'inherit' });
const offline = process.argv[2] === 'offline';
try {
  execFileSync('java', ['-cp', classes, 'com.local.aiusage.LinkChecks'], { stdio: 'inherit' });
} finally {
  if (offline) fs.rmSync(classes, { recursive: true, force: true });
}
if (offline) process.exit(console.log('link-check: offline checks passed'));
let phone = null;
let pageKey = ''; // the running phone half's key, as the bubble's WebView holds it in a cookie
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
    phone.stdout.on('data', (d) => {
      const ready = /ready ([0-9a-f]{64})/.exec(String(d));
      if (!ready) return;
      pageKey = ready[1];
      resolve();
    });
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
  const req = http.request({ host: 'localhost', port, path: p, method, agent: false, headers: { cookie: `link=${pageKey}` } }, (res) => {
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
