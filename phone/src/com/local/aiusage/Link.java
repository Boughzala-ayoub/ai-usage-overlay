package com.local.aiusage;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * The phone link. A page on this phone talks to http://localhost:port, which this serves from the phone itself,
 * so the page is a secure context on any network. Each of the page's connections goes on to the PC over
 * Tailscale whenever Tailscale works: TLS to the PC's tailnet name, which `tailscale serve` hands to the app's
 * port on the PC.
 *
 * <p>The other way is for when it doesn't. With the PC on this phone's own hotspot, Tailscale between them dies
 * within minutes (tailscale/tailscale#20782), so the PC also connects here, to this link's port on its
 * gateway: this phone. Both prove they hold the secret the phone read over Tailscale from GET /api/link. The
 * connection then waits until a page needs it: "GO", and the PC pipes it to its own 127.0.0.1 port. While the
 * PC is here, Tailscale is checked every 10 s, and pages go over the hotspot only while that check fails. The
 * PC only ever connects out, so nothing new listens on it.
 *
 * <p>Every app on this phone can reach the page's port, and the link, Tailscale's or the hotspot's, speaks for this
 * app to the PC. So a request goes on only once it shows this link's key, in a cookie only the app's own WebView
 * holds (Bubble.java): every request, kept-alive connections included, and nothing past them (request()). The key is
 * new for each link, never leaves this process but for that cookie, and is taken out of the request before it goes
 * on, so the PC never sees it. The answers pass untouched either way, since the PC's apps accept Host:
 * localhost:port. Loom's phone app (loom's android/) carries a copy of this file in its own package: keep the two
 * the same, though that copy doesn't check the key yet. No Android classes, so phone/link-check.mjs runs it on the PC.
 */
public final class Link {
  public interface Store {
    String get(String key);

    void put(String key, String value);
  }

  /** An app the link carries: its name in the PC's hello, its port here and on the PC, its `tailscale serve` port (0: none). */
  public record App(String name, int port, int tailnet) {}

  static final Pattern SECRET = Pattern.compile("\"secret\"\\s*:\\s*\"([0-9a-f]{64})\"");
  /** The cookie that carries the page's key. */
  static final String COOKIE = "link";
  static final Pattern START = Pattern.compile("[A-Z]+ /\\S* HTTP/1\\.1");
  static final Pattern FIELD = Pattern.compile("([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \\t]*(.*?)[ \\t]*");
  static Link running;
  /** What the link did, for a check or the phone's log: nothing by default. */
  static Consumer<String> log = line -> {};
  /** How long a page's connection has, in all, to send its first request's head, the key with it. */
  static final int FIRST_MS = 5000;
  /** Closes the page's connections whose first request is late. */
  static final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1, r -> {
    Thread t = new Thread(r, "link");
    t.setDaemon(true);
    return t;
  });

  static {
    deadlines.setRemoveOnCancelPolicy(true); // one for every connection: those met go at once
  }

  final String host; // the PC's tailnet name
  final Store store;
  final App[] apps;
  final int pcPort; // where the PC finds this link on the hotspot: each link on the phone has its own
  final int offset; // added to the pages' ports: link-check.mjs runs this on a PC whose own apps hold them
  final Map<String, LinkedBlockingDeque<Socket>> idle = new ConcurrentHashMap<>();
  final Map<String, Long> seen = new ConcurrentHashMap<>(); // app -> ms the PC last proved itself on the hotspot
  final Set<String> tailnetDown = ConcurrentHashMap.newKeySet(); // apps whose Tailscale check failed while the PC was here
  final Map<String, Set<Socket>> overTailnet = new ConcurrentHashMap<>(); // app -> its page connections on Tailscale now
  final List<ServerSocket> servers = new CopyOnWriteArrayList<>();
  final Set<Socket> accepted = ConcurrentHashMap.newKeySet(); // the pages' and the PC's connections, for stop()
  final SecureRandom random = new SecureRandom();
  final String key = hex(32); // the page's key to this link: Bubble.java puts it in its WebView's cookie
  // The page's connections that haven't shown the key yet. Any app on the phone can open them, and each holds a thread
  // until its first request is in (FIRST_MS at most), so only this many at once: past them one is closed as it comes.
  final Semaphore unproven = new Semaphore(32);
  boolean serving; // open() holds every page port on every loopback address: only then may a page get the key
  volatile boolean stopped;

  /**
   * Runs one link for the process, and returns it; a new tailnet name or port starts it over, and so does a start
   * after one that couldn't take its page ports.
   */
  static synchronized Link start(String host, Store store, App[] apps, int pcPort) {
    if (running != null && running.serving && running.host.equals(host) && Arrays.equals(running.apps, apps)) return running;
    if (running != null) running.stop();
    running = new Link(host, store, apps, pcPort, 0);
    running.open();
    return running;
  }

  /** Stops the process's link: the service holding it ended. */
  static synchronized void end() {
    if (running != null) running.stop();
    running = null;
  }

  Link(String host, Store store, App[] apps, int pcPort, int offset) {
    this.host = host;
    this.store = store;
    this.apps = apps;
    this.pcPort = pcPort;
    this.offset = offset;
    for (App a : apps) {
      idle.put(a.name, new LinkedBlockingDeque<>());
      overTailnet.put(a.name, ConcurrentHashMap.newKeySet());
    }
  }

  void open() {
    serving = true;
    for (App a : apps) {
      // WebView can use either loopback for localhost. A failed bind on either address makes the origin unsafe.
      List<ServerSocket> bound = new ArrayList<>();
      boolean all = true;
      for (String lo : new String[] { "127.0.0.1", "::1" }) {
        ServerSocket ss = bind(a.port + offset, lo);
        if (ss != null) bound.add(ss);
        else all = false;
      }
      for (ServerSocket ss : bound) {
        if (all) serve(ss, unproven, s -> local(a, s));
        else close(ss);
      }
      if (!all) {
        serving = false;
        log.accept(a.name + ": another app holds its page port, so the page isn't served");
      }
    }
    ServerSocket pcs = bind(pcPort, null);
    if (pcs != null) serve(pcs, null, this::pc);
    thread(this::pinger);
    thread(this::checker);
    thread(this::fetchSecret);
  }

  synchronized void stop() {
    stopped = true;
    for (ServerSocket s : servers) close(s);
    // The PC's waiting connections, and both ends of every pipe: a page's Tailscale end closes with the page's.
    for (Socket s : accepted) close(s);
  }

  /** The PC proved itself on this hotspot within the last minute (pings come every 10 s). */
  boolean onHotspot(App a) {
    return System.currentTimeMillis() - seen.getOrDefault(a.name, 0L) < 60_000;
  }

  /** Which way the app's pages go now. */
  String route(App a) {
    return onHotspot(a) && tailnetDown.contains(a.name) ? "the hotspot" : "Tailscale";
  }

  /** For the app's screen: whether the link has its secret, and how each app reaches the PC. */
  String status() {
    if (store.get("secret") == null) return "waiting for its secret, which comes from the PC over Tailscale.";
    StringBuilder b = new StringBuilder("ready.");
    for (App a : apps) if (onHotspot(a)) b.append(' ').append(a.name).append(": the PC is on this hotspot, going over ").append(route(a)).append('.');
    return b.toString();
  }

  interface Serve {
    void serve(Socket s);
  }

  /** A socket listening on the port, at one address or all of them, or null where it can't. */
  ServerSocket bind(int port, String address) {
    ServerSocket ss = null;
    try {
      ss = new ServerSocket();
      ss.setReuseAddress(true);
      ss.bind(address == null ? new InetSocketAddress(port) : new InetSocketAddress(InetAddress.getByName(address), port));
      servers.add(ss);
      return ss;
    } catch (IOException e) {
      close(ss);
      return null; // ponytail: taken (another copy, another app) or not on this device; log it if a missing link ever needs explaining
    }
  }

  /** Serves each connection on a thread of its own; with places, only while one is free, and it is closed otherwise. */
  void serve(ServerSocket ss, Semaphore places, Serve serve) {
    thread(() -> {
      while (!stopped) {
        try {
          Socket s = ss.accept();
          if (places != null && !places.tryAcquire()) {
            close(s); // ponytail: an app holding them all keeps the page out, FIRST_MS at a time; it costs the phone nothing more
            continue;
          }
          accepted.removeIf(Socket::isClosed); // ponytail: pruned as new ones come, so it holds the few still open
          accepted.add(s);
          if (stopped) close(s); // taken while stop() went by
          thread(() -> serve.serve(s));
        } catch (IOException e) {
          if (stopped || ss.isClosed()) return;
        }
      }
    });
  }

  // ---- the PC's side: it connects over the hotspot, proves itself, and waits for a page's connection

  void pc(Socket s) {
    try {
      s.setSoTimeout(5000);
      s.setTcpNoDelay(true);
      String nonce = hex(16);
      write(s, "LINK1 " + nonce);
      String[] hello = line(s).split(" ");
      String secret = store.get("secret");
      if (hello.length != 3 || secret == null || !idle.containsKey(hello[0]) || !hello[1].matches("[0-9a-f]{32}")) throw new IOException("refused");
      String app = hello[0], theirs = hello[1];
      if (!same(hmac(secret, "pc|" + app + "|" + nonce + "|" + theirs), hello[2])) throw new IOException("refused");
      write(s, hmac(secret, "phone|" + app + "|" + nonce + "|" + theirs));
      s.setKeepAlive(true);
      seen.put(app, System.currentTimeMillis());
      idle.get(app).offer(s);
      log.accept("pc " + app + " proved, " + idle.get(app).size() + " waiting");
    } catch (IOException e) {
      log.accept("pc refused: " + e.getMessage());
      close(s);
    }
  }

  /** Every 10 s each waiting connection must answer, so a PC that left the hotspot drops out. */
  void pinger() {
    while (!stopped) {
      sleep(10_000);
      for (Map.Entry<String, LinkedBlockingDeque<Socket>> e : idle.entrySet()) {
        for (int n = e.getValue().size(); n > 0; n--) {
          Socket s = e.getValue().poll();
          if (s == null) break;
          try {
            s.setSoTimeout(3000);
            write(s, "P");
            if (!"P".equals(line(s))) throw new IOException("no answer");
            seen.put(e.getKey(), System.currentTimeMillis());
            e.getValue().offer(s);
          } catch (IOException x) {
            close(s);
          }
        }
      }
    }
  }

  /** Every 10 s, for each app whose PC is on this hotspot: does Tailscale still reach it? */
  void checker() {
    while (!stopped) {
      sleep(10_000);
      for (App a : apps) {
        if (a.tailnet == 0 || !onHotspot(a)) {
          tailnetDown.remove(a.name); // no other way to the PC: always try Tailscale
          continue;
        }
        Socket s = viaTailnet(a.tailnet, 3000);
        close(s);
        down(a, s == null);
      }
    }
  }

  /** Marks Tailscale up or down for an app. Down, its pages' Tailscale connections end, so they come back over the hotspot. */
  void down(App a, boolean isDown) {
    if (!(isDown ? tailnetDown.add(a.name) : tailnetDown.remove(a.name))) return;
    log.accept(a.name + ": Tailscale " + (isDown ? "down, over the hotspot" : "back"));
    if (isDown) for (Socket s : overTailnet.get(a.name)) close(s);
  }

  // ---- a page's side

  void local(App a, Socket page) {
    // The first request's head before anything else, so a connection without the key never reaches the PC. It has
    // FIRST_MS in all, however slowly it comes, and holds one of the places for connections without the key (serve())
    // until it is in. Past that the connection is just closed: a spare one the page never used, it opens another.
    AtomicBoolean settled = new AtomicBoolean(); // the head came, or its time ran out: whichever was first
    ScheduledFuture<?> late = deadlines.schedule(() -> {
      if (settled.compareAndSet(false, true)) close(page);
    }, FIRST_MS, TimeUnit.MILLISECONDS);
    InputStream in;
    Request first;
    try {
      page.setTcpNoDelay(true);
      in = new BufferedInputStream(page.getInputStream());
      first = request(in);
    } catch (IOException e) {
      if (settled.compareAndSet(false, true)) {
        log.accept(a.name + ": refused a request without the key");
        refuse(page);
      } else log.accept(a.name + ": closed a connection with no request in time");
      return;
    } finally {
      late.cancel(false);
      unproven.release();
    }
    if (!settled.compareAndSet(false, true) || first == null) {
      close(page); // out of time just as it came, or opened and closed again, as a browser's spare connection can be
      return;
    }
    boolean hotspot = onHotspot(a), skipped = hotspot && tailnetDown.contains(a.name);
    // Tailscale first. With the PC on the hotspot too, only while its check passes, and with less patience.
    Socket pc = skipped ? null : viaTailnet(a.tailnet, hotspot ? 2500 : 6000);
    if (pc == null && !skipped && hotspot && a.tailnet != 0) down(a, true);
    boolean tailnet = pc != null;
    if (pc == null && hotspot) pc = viaHotspot(a.name);
    // Nothing on the hotspot after all: the PC has just left it, for a network where Tailscale may work again.
    if (pc == null && skipped && (pc = viaTailnet(a.tailnet, 2500)) != null) {
      tailnet = true;
      down(a, false);
    }
    log.accept(a.name + ": " + (pc == null ? "no way to the PC" : tailnet ? "over Tailscale" : "over the hotspot"));
    if (pc == null) {
      close(page);
      return;
    }
    if (!tailnet) {
      pipe(page, in, first, pc);
      return;
    }
    Set<Socket> live = overTailnet.get(a.name);
    live.add(pc);
    try {
      pipe(page, in, first, pc);
    } finally {
      live.remove(pc);
    }
  }

  /** A request from the page as it goes on to the PC: its head, the key taken out, and how long its body is. */
  record Request(byte[] head, long body) {}

  /**
   * The next request on a page's connection, read through its head: null if the page closed the connection before
   * starting one. Throws for one that doesn't show this link's key, or that isn't a plain HTTP/1.1 request whose body
   * has a stated length. The page sends nothing else: no chunked uploads, no continued header lines, no upgrades
   * to WebSocket. Only what this reads goes on, so a byte the page sends can't reach the PC outside a request that
   * showed the key.
   */
  Request request(InputStream in) throws IOException {
    StringBuilder raw = new StringBuilder();
    for (int c, end = 0; end < 4;) {
      if ((c = in.read()) < 0) {
        if (raw.length() == 0) return null;
        throw new IOException("cut off");
      }
      if (raw.length() >= 16 << 10) throw new IOException("head too long");
      raw.append((char) c);
      end = c == "\r\n\r\n".charAt(end) ? end + 1 : c == '\r' ? 1 : 0;
    }
    String[] lines = raw.substring(0, raw.length() - 4).split("\r\n", -1);
    if (!START.matcher(lines[0]).matches()) throw new IOException("not a request");
    StringBuilder out = new StringBuilder(lines[0]).append("\r\n");
    boolean keyed = false;
    long body = -1;
    for (int i = 1; i < lines.length; i++) {
      Matcher f = FIELD.matcher(lines[i]);
      if (!f.matches()) throw new IOException("not a header");
      String name = f.group(1), value = f.group(2);
      if (name.equalsIgnoreCase("transfer-encoding") || name.equalsIgnoreCase("upgrade")) throw new IOException("not supported");
      if (name.equalsIgnoreCase("content-length")) {
        if (!value.matches("\\d{1,12}") || body >= 0) throw new IOException("bad length");
        body = Long.parseLong(value);
      }
      if (name.equalsIgnoreCase("cookie")) {
        StringBuilder kept = new StringBuilder();
        for (String pair : value.split(";")) {
          String p = pair.trim();
          if (p.startsWith(COOKIE + "=")) keyed |= same(p.substring(COOKIE.length() + 1), key);
          else if (!p.isEmpty()) kept.append(kept.length() == 0 ? "" : "; ").append(p);
        }
        if (kept.length() == 0) continue;
        value = kept.toString();
      }
      out.append(name).append(": ").append(value).append("\r\n");
    }
    if (!keyed) throw new IOException("no key");
    return new Request(out.append("\r\n").toString().getBytes(StandardCharsets.ISO_8859_1), Math.max(0, body));
  }

  /** Answers a connection whose first request didn't show the key, and ends it: the PC never hears of it. */
  static void refuse(Socket page) {
    try {
      page.getOutputStream().write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
      page.getOutputStream().flush();
    } catch (IOException e) {
      // gone already
    }
    close(page);
  }

  /** A waiting connection from the PC on this hotspot, or null. */
  Socket viaHotspot(String app) {
    LinkedBlockingDeque<Socket> q = idle.get(app);
    // The PC opens a new connection for each one used: a burst of the page's waits a moment for those.
    long until = System.currentTimeMillis() + 2000;
    while (true) {
      Socket s;
      try {
        s = q.poll(Math.max(0, until - System.currentTimeMillis()), TimeUnit.MILLISECONDS);
      } catch (InterruptedException e) {
        return null;
      }
      if (s == null) return null;
      try {
        s.setSoTimeout(2000);
        write(s, "GO");
        if ("OK".equals(line(s))) {
          s.setSoTimeout(0);
          return s;
        }
      } catch (SocketTimeoutException e) {
        close(s);
        return null; // no answer in 2 s: the PC has left the hotspot, and the rest would keep the page as long each
      } catch (IOException e) {
        // gone since its last ping: the next one
      }
      close(s);
    }
  }

  /** TLS to the PC's tailnet name, as `tailscale serve` expects, or null. */
  Socket viaTailnet(int port, int patience) {
    if (port == 0 || host.isEmpty()) return null;
    Socket raw = new Socket();
    try {
      raw.connect(new InetSocketAddress(host, port), patience);
      SSLSocket s = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(raw, host, port, true);
      SSLParameters p = s.getSSLParameters();
      p.setEndpointIdentificationAlgorithm("HTTPS"); // SSLSocket checks the name only when asked
      s.setSSLParameters(p);
      s.setSoTimeout(patience);
      s.startHandshake();
      s.setSoTimeout(0);
      s.setTcpNoDelay(true);
      return s;
    } catch (IOException e) {
      close(raw);
      return null;
    }
  }

  /**
   * Both ways until both ends are done: the page's requests on to the PC, each only once it shows the key, and the
   * PC's answers back untouched. An end's EOF reaches the other as a half-close; a request without the key ends both.
   */
  void pipe(Socket page, InputStream in, Request first, Socket pc) {
    AtomicInteger left = new AtomicInteger(2);
    thread(() -> copy(page, pc, left, out -> {
      byte[] buf = new byte[16 << 10];
      for (Request r = first; r != null; r = request(in)) {
        out.write(r.head());
        for (long n = r.body(), got; n > 0; n -= got) {
          if ((got = in.read(buf, 0, (int) Math.min(buf.length, n))) < 0) throw new IOException("body cut off");
          out.write(buf, 0, (int) got);
        }
        out.flush();
      }
    }));
    copy(pc, page, left, out -> {
      byte[] buf = new byte[16 << 10];
      InputStream from = pc.getInputStream();
      for (int n; (n = from.read(buf)) > 0;) {
        out.write(buf, 0, n);
        out.flush();
      }
    });
  }

  interface Pump {
    void run(OutputStream out) throws IOException;
  }

  void copy(Socket from, Socket to, AtomicInteger left, Pump pump) {
    try {
      pump.run(to.getOutputStream());
      to.shutdownOutput();
    } catch (IOException | UnsupportedOperationException e) { // TLS has no half-close: the page hung up, so end it
      close(from);
      close(to);
    }
    if (left.decrementAndGet() == 0) {
      close(from);
      close(to);
    }
  }

  // ---- the secret, from the PC over Tailscale, from whichever of its apps answers

  void fetchSecret() {
    while (!stopped) {
      String got = null;
      for (App a : apps) {
        if (got == null && a.tailnet != 0 && !host.isEmpty()) got = secretFrom("https://" + host + (a.tailnet == 443 ? "" : ":" + a.tailnet) + "/api/link");
      }
      // Under stop()'s lock: a link stopped while its PC answered never writes over its replacement's secret.
      synchronized (this) {
        if (got != null && !stopped) store.put("secret", got);
      }
      sleep(got != null ? 600_000 : 30_000);
    }
  }

  String secretFrom(String url) {
    try {
      HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
      c.setConnectTimeout(8000);
      c.setReadTimeout(8000);
      try (InputStream in = c.getInputStream()) {
        Matcher m = SECRET.matcher(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        return c.getResponseCode() == 200 && m.find() ? m.group(1) : null;
      } finally {
        c.disconnect();
      }
    } catch (IOException e) {
      return null;
    }
  }

  // ---- small things

  static String hmac(String secret, String message) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      return hex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }

  /** Compares in time that doesn't depend on where they first differ. */
  static boolean same(String a, String b) {
    if (a.length() != b.length()) return false;
    int diff = 0;
    for (int i = 0; i < a.length(); i++) diff |= a.charAt(i) ^ b.charAt(i);
    return diff == 0;
  }

  String hex(int n) {
    byte[] b = new byte[n];
    random.nextBytes(b);
    return hex(b);
  }

  static String hex(byte[] bytes) {
    StringBuilder s = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) s.append(String.format("%02x", b & 0xff));
    return s.toString();
  }

  static void write(Socket s, String line) throws IOException {
    OutputStream out = s.getOutputStream();
    out.write((line + "\n").getBytes(StandardCharsets.UTF_8));
    out.flush();
  }

  /** One line, read a byte at a time so nothing past it is taken from the stream the pipe gets next. */
  static String line(Socket s) throws IOException {
    InputStream in = s.getInputStream();
    StringBuilder b = new StringBuilder();
    for (int c; (c = in.read()) != '\n';) {
      if (c < 0 || b.length() > 300) throw new IOException("no line");
      b.append((char) c);
    }
    return b.toString();
  }

  static void close(java.io.Closeable c) {
    try {
      if (c != null) c.close();
    } catch (IOException e) {
      // closing what's already gone
    }
  }

  static void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }

  static void thread(Runnable r) {
    Thread t = new Thread(r, "link");
    t.setDaemon(true);
    t.start();
  }
}
