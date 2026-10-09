package com.local.aiusage;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Only for the screenshot a snip is cut from. Switched on under Accessibility, it asks for no events and
 * reads nothing on screen; the bubble finds it here while it runs.
 */
public class Snipper extends AccessibilityService {
  static volatile Snipper on;

  @Override protected void onServiceConnected() { on = this; }

  @Override public boolean onUnbind(Intent i) {
    on = null;
    return super.onUnbind(i);
  }

  @Override public void onAccessibilityEvent(AccessibilityEvent e) {}

  @Override public void onInterrupt() {}
}
