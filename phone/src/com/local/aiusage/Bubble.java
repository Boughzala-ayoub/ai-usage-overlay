package com.local.aiusage;

import android.accessibilityservice.AccessibilityService;
import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.net.Uri;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Display;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.WindowMetrics;
import android.view.animation.DecelerateInterpolator;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * The bubble: bubble.html in a window above every app. Collapsed, the window is just the tab, and a touch
 * on it is a drag (gliding to dock on the nearer side, as Messenger's heads do) or a tap. A tap gives the
 * window the whole screen and the page pulls the panel out of the tab. With auto-hide on, an idle tab
 * slides off the edge but for a lip, and a tap on the lip brings it back. The page reads the PC itself;
 * this moves and sizes the window, tells the page what the finger is doing, and copies the snips the page
 * marks out. Both states use screen coordinates, so the tab never jumps.
 */
public class Bubble extends Service {
  static final int MARGIN = 12; // dp the window has beyond the tab, inside the screen, for the shadow
  static final int LIP = 12; // dp of the tab left on screen while it hides
  static final int IDLE_MS = 3000;
  WindowManager wm;
  WindowManager.LayoutParams lp;
  SharedPreferences prefs;
  FrameLayout root;
  WebView web;
  ValueAnimator gliding;
  int wDp = 50, hDp = 154; // the collapsed window: the tab at its size, plus MARGIN beside it and above and below
  boolean open, autoHide, peeking;
  int restX, restY; // where the tab sits while the panel is open
  volatile String side = "right"; // the edge it docks on; the page asks as it loads
  final Runnable hide = this::peek;

  static String server(Context c) {
    String saved = c.getSharedPreferences("bubble", MODE_PRIVATE).getString("server", "");
    if (!saved.isEmpty()) return saved;
    try (InputStream in = c.getAssets().open("server.txt")) { // baked in by build.mjs from `tailscale status`
      return new String(in.readAllBytes(), StandardCharsets.UTF_8).trim();
    } catch (IOException e) {
      return "";
    }
  }

  @Override public IBinder onBind(Intent i) { return null; }

  @Override public int onStartCommand(Intent intent, int flags, int id) {
    if (intent != null && "stop".equals(intent.getAction())) {
      stopSelf();
      return START_NOT_STICKY;
    }
    NotificationManager nm = getSystemService(NotificationManager.class);
    nm.createNotificationChannel(new NotificationChannel("bubble", "Bubble", NotificationManager.IMPORTANCE_MIN));
    Intent stop = new Intent(this, Bubble.class).setAction("stop");
    Notification n = new Notification.Builder(this, "bubble")
        .setSmallIcon(android.R.drawable.ic_menu_info_details)
        .setContentTitle("AI usage bubble")
        .addAction(new Notification.Action.Builder(null, "Remove", PendingIntent.getService(this, 0, stop, PendingIntent.FLAG_IMMUTABLE)).build())
        .build();
    // The window first: from the background (a restart after Android killed us), Android 15 allows a
    // foreground service only to an app whose overlay is already showing.
    if (root == null) show();
    try {
      startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
    } catch (IllegalStateException refused) {
      // Still refused: the bubble runs on, kept alive by being on screen.
    }
    // Again on every start, so a new address from the launcher screen takes effect.
    try (InputStream in = getAssets().open("bubble.html")) {
      web.loadDataWithBaseURL(server(this) + "/", new String(in.readAllBytes(), StandardCharsets.UTF_8), "text/html", "utf-8", null);
    } catch (IOException e) {
      throw new IllegalStateException("bubble.html missing from the APK", e);
    }
    return START_STICKY;
  }

  int px(float dp) { return Math.round(dp * getResources().getDisplayMetrics().density); }

  // In px at the density of the moment, which a change of display size can move.
  int w() { return px(wDp); }

  int h() { return px(hDp); }

  void js(String call) { web.evaluateJavascript(call, null); }

  /** The screen less its bars and cutout, in the screen coordinates the window uses. */
  Rect area() {
    WindowMetrics m = wm.getCurrentWindowMetrics();
    Insets in = m.getWindowInsets().getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
    Rect r = new Rect(m.getBounds());
    r.left += in.left;
    r.top += in.top;
    r.right -= in.right;
    r.bottom -= in.bottom;
    return r;
  }

  void show() {
    wm = getSystemService(WindowManager.class);
    prefs = getSharedPreferences("bubble", MODE_PRIVATE);
    wDp = prefs.getInt("w", wDp); // the page sends its size as it loads; these are its last one
    hDp = prefs.getInt("h", hDp);
    web = new WebView(this);
    web.setBackgroundColor(Color.TRANSPARENT);
    web.getSettings().setJavaScriptEnabled(true);
    web.getSettings().setDomStorageEnabled(true); // the page keeps the last numbers for when the PC is away
    web.getSettings().setTextZoom(100); // the tab is a fixed size, and a large system font would spill it
    web.addJavascriptInterface(this, "Android");
    root = new FrameLayout(this) {
      float sx, sy;
      int ox, oy;
      boolean moved;

      // Collapsed, every touch is the bubble's: the page never sees it.
      @Override public boolean onInterceptTouchEvent(MotionEvent e) { return !open; }

      @Override public boolean onTouchEvent(MotionEvent e) {
        if (open) return super.onTouchEvent(e);
        switch (e.getActionMasked()) {
          case MotionEvent.ACTION_DOWN:
            if (gliding != null) gliding.cancel(); // caught mid-glide: carry it from here
            removeCallbacks(hide);
            js("press(true)");
            sx = e.getRawX();
            sy = e.getRawY();
            ox = lp.x;
            oy = lp.y;
            moved = false;
            break;
          case MotionEvent.ACTION_MOVE:
            float dx = e.getRawX() - sx, dy = e.getRawY() - sy;
            if (!moved && Math.hypot(dx, dy) < ViewConfiguration.get(getContext()).getScaledTouchSlop()) break;
            if (!moved) {
              if (peeking) {
                peeking = false;
                js("peek(false)");
              }
              js("lift()");
            }
            moved = true;
            lp.x = ox + Math.round(dx);
            lp.y = oy + Math.round(dy);
            wm.updateViewLayout(this, lp);
            break;
          case MotionEvent.ACTION_UP:
            js("press(false)");
            if (moved) {
              performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); // docked
              snap();
            } else if (peeking) unpeek();
            else {
              performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
              expand();
            }
            break;
          case MotionEvent.ACTION_CANCEL:
            js("press(false)");
            if (moved) snap();
            else idle();
            break;
        }
        return true;
      }

      @Override public boolean dispatchKeyEvent(KeyEvent e) {
        if (!open || e.getKeyCode() != KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(e);
        if (e.getAction() == KeyEvent.ACTION_UP) js("shut()");
        return true;
      }
    };
    root.addView(web);
    lp = new WindowManager.LayoutParams(w(), h(), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
            | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED, // a window added by hand gets no GPU unless it asks, and WebView needs one
        PixelFormat.TRANSLUCENT);
    lp.gravity = Gravity.TOP | Gravity.LEFT;
    lp.setFitInsetsTypes(0); // screen coordinates in both states: nothing shifts the window under the bars
    lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
    Rect a = area();
    lp.x = prefs.getInt("x", a.right - w());
    lp.y = prefs.getInt("y", a.top + a.height() / 3);
    wm.addView(root, lp);
    snap(); // a saved spot from another rotation or screen may be off this one
  }

  void glide(int toX, int toY) {
    if (gliding != null) gliding.cancel();
    int fromX = lp.x, fromY = lp.y;
    gliding = ValueAnimator.ofFloat(0, 1).setDuration(260);
    gliding.setInterpolator(new DecelerateInterpolator(2));
    gliding.addUpdateListener(v -> {
      if (open || !root.isAttachedToWindow()) return;
      float k = (float) v.getAnimatedValue();
      lp.x = Math.round(fromX + (toX - fromX) * k);
      lp.y = Math.round(fromY + (toY - fromY) * k);
      wm.updateViewLayout(root, lp);
    });
    gliding.start();
  }

  /** Flush with the nearer side and inside the bars, and remembered there. */
  void snap() {
    Rect a = area();
    if (peeking) {
      peeking = false;
      js("peek(false)");
    }
    side = lp.x + w() / 2 < a.centerX() ? "left" : "right";
    int toX = side.equals("left") ? a.left : a.right - w();
    int toY = Math.max(a.top, Math.min(lp.y, a.bottom - h()));
    lp.width = w(); // a new size, or the same size at a new density
    lp.height = h();
    js("dock('" + side + "')"); // its edge corners square off as it glides in
    prefs.edit().putInt("x", toX).putInt("y", toY).apply();
    glide(toX, toY);
    idle();
  }

  /** With auto-hide on, hide at the edge after a while untouched. */
  void idle() {
    root.removeCallbacks(hide);
    if (autoHide && !open && !peeking) root.postDelayed(hide, IDLE_MS);
  }

  void peek() {
    if (open || peeking) return;
    peeking = true;
    js("peek(true)");
    Rect a = area();
    int tab = w() - px(MARGIN);
    // On the right the tab starts MARGIN into the window; on the left it starts at the window's edge.
    glide(side.equals("left") ? a.left + px(LIP) - tab : a.right - px(LIP) - px(MARGIN), lp.y);
  }

  void unpeek() {
    peeking = false;
    js("peek(false)");
    Rect a = area();
    glide(side.equals("left") ? a.left : a.right - w(), lp.y);
    idle();
  }

  void expand() {
    open = true; // a tap's touch-down already stopped any glide
    root.removeCallbacks(hide);
    restX = lp.x;
    restY = lp.y;
    // The page learns where the window is and how much of the screen the bars take, then gets the screen.
    web.evaluateJavascript(place("expand", lp.x, lp.y, area()), v -> {
      lp.x = lp.y = 0;
      lp.width = lp.height = WindowManager.LayoutParams.MATCH_PARENT;
      lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE; // focusable, so Back closes the panel
      wm.updateViewLayout(root, lp);
    });
  }

  /** A call to the page with a window's place and the bars' room, in the page's px at this density. */
  String place(String fn, int x, int y, Rect a) {
    Rect screen = wm.getCurrentWindowMetrics().getBounds();
    float d = getResources().getDisplayMetrics().density;
    return String.format(java.util.Locale.ROOT, "%s(%.1f,%.1f,%.1f,%.1f)", fn, x / d, y / d, a.top / d, (screen.bottom - a.bottom) / d);
  }

  /**
   * With the panel open, after the screen turns or the size changes: where the tab goes back to on this
   * screen at this size (flush with its edge, inside the bars), and the page's anchor moved to match, so
   * the tab follows its edge and closing lands it there.
   */
  void reanchor() {
    if (!open) return;
    Rect a = area();
    restX = side.equals("left") ? a.left : a.right - w();
    restY = Math.max(a.top, Math.min(restY, a.bottom - h()));
    js(place("anchor", restX, restY, a));
  }

  // ---- the page's words. They arrive on WebView's own thread, so each hands its work to the window's.

  /** Once its closing animation has run. */
  @JavascriptInterface public void collapse() { root.post(this::fold); }

  /** The window back to the tab, from the open panel or a snip. */
  void fold() {
    if (!open || !root.isAttachedToWindow()) return;
    open = false;
    lp.x = restX;
    lp.y = restY;
    lp.width = w();
    lp.height = h();
    lp.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
    wm.updateViewLayout(root, lp);
    snap(); // the screen may have turned while the panel was open
  }

  @JavascriptInterface public String side() { return side; }

  /** The window the tab needs at this phone's bubble size, in dp. */
  @JavascriptInterface public void size(int width, int height) {
    int nw = Math.max(30, Math.min(width, 120)), nh = Math.max(60, Math.min(height, 300));
    root.post(() -> {
      if (nw == wDp && nh == hDp) return;
      wDp = nw;
      hDp = nh;
      prefs.edit().putInt("w", nw).putInt("h", nh).apply();
      if (open) reanchor(); // the open panel's tab follows its edge at the new size
      else snap(); // the window takes the new size, flush with the edge
    });
  }

  @JavascriptInterface public void autoHide(boolean on) {
    root.post(() -> {
      autoHide = on;
      if (!on && peeking) unpeek();
      else idle();
    });
  }

  /** A provider's usage page, in the phone's browser. */
  @JavascriptInterface public void open(String url) {
    if (!url.startsWith("https://")) return; // only the web pages the PC lists, nothing else the page might pass
    root.post(() -> {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      js("shut()");
    });
  }

  @JavascriptInterface public void remove() { root.post(this::stopSelf); }

  // ---- snipping. The page dims the screen and takes the rectangle; this takes the screenshot through
  // Snipper and copies that part of it.

  @JavascriptInterface public boolean canSnip() { return Snipper.on != null; }

  /** Where Snipper is switched on: Accessibility, or App info, where a sideloaded app's restricted settings are allowed. */
  @JavascriptInterface public void settings(String where) {
    Intent i = "app".equals(where)
        ? new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))
        : new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
    root.post(() -> {
      startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      js("shut()");
    });
  }

  /** The rectangle the page took, as fractions of the screen, to the clipboard as a PNG. */
  @JavascriptInterface public void snipped(double x, double y, double w, double h) {
    root.post(() -> {
      Snipper s = Snipper.on;
      if (!open) return;
      if (s == null) { // switched off since the page asked
        fold();
        return;
      }
      root.setVisibility(View.INVISIBLE); // out of its own picture
      // ponytail: a fixed wait for the hidden window to leave the screen; a frame-commit callback if the dim ever shows in a snip
      root.postDelayed(() -> s.takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new AccessibilityService.TakeScreenshotCallback() {
        @Override public void onSuccess(AccessibilityService.ScreenshotResult r) {
          fold();
          root.setVisibility(View.VISIBLE);
          new Thread(() -> copy(r, x, y, w, h)).start(); // a PNG takes a moment to write
        }

        @Override public void onFailure(int code) {
          fold();
          root.setVisibility(View.VISIBLE);
          Toast.makeText(Bubble.this, "Couldn't take the screenshot (error " + code + ")", Toast.LENGTH_SHORT).show();
        }
      }), 150);
    });
  }

  void copy(AccessibilityService.ScreenshotResult r, double x, double y, double w, double h) {
    try (HardwareBuffer buffer = r.getHardwareBuffer()) {
      Bitmap screen = Bitmap.wrapHardwareBuffer(buffer, r.getColorSpace()).copy(Bitmap.Config.ARGB_8888, false);
      int sw = screen.getWidth(), sh = screen.getHeight();
      int l = (int) Math.max(0, Math.min(Math.round(x * sw), sw - 1)), t = (int) Math.max(0, Math.min(Math.round(y * sh), sh - 1));
      int cw = (int) Math.max(1, Math.min(Math.round(w * sw), sw - l)), ch = (int) Math.max(1, Math.min(Math.round(h * sh), sh - t));
      File dir = new File(getCacheDir(), "snips");
      dir.mkdirs();
      // ponytail: a day of snips kept, for a clipboard history that still points at them; older ones go as the next is made
      File[] old = dir.listFiles();
      if (old != null) for (File f : old) if (f.lastModified() < System.currentTimeMillis() - 86_400_000L) f.delete();
      File png = new File(dir, System.currentTimeMillis() + ".png");
      try (FileOutputStream out = new FileOutputStream(png)) {
        Bitmap.createBitmap(screen, l, t, cw, ch).compress(Bitmap.CompressFormat.PNG, 100, out);
      }
      getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newUri(getContentResolver(), "Snip", Snips.uri(png)));
      root.post(() -> root.performHapticFeedback(HapticFeedbackConstants.CONFIRM));
    } catch (Exception e) {
      root.post(() -> Toast.makeText(this, "Couldn't copy the snip", Toast.LENGTH_SHORT).show());
    }
  }

  @Override public void onConfigurationChanged(Configuration c) {
    super.onConfigurationChanged(c);
    if (root == null) return;
    // Posted, so the window's metrics and insets are the turned screen's by then.
    root.post(open ? this::reanchor : this::snap);
  }

  @Override public void onDestroy() {
    if (gliding != null) gliding.cancel();
    if (root != null) {
      root.removeCallbacks(hide);
      wm.removeView(root);
    }
    if (web != null) web.destroy();
    super.onDestroy();
  }
}
