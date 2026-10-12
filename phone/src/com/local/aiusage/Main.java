package com.local.aiusage;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** The launcher screen: which PC to read, and the switch for the bubble. */
public class Main extends Activity {
  SharedPreferences prefs;
  EditText server;
  TextView link; // the phone link's state (Link.java)
  boolean asked; // sent to the overlay permission screen; start once it comes back granted

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    prefs = getSharedPreferences("bubble", MODE_PRIVATE);
    int pad = Math.round(24 * getResources().getDisplayMetrics().density);
    LinearLayout col = new LinearLayout(this);
    col.setOrientation(LinearLayout.VERTICAL);
    col.setPadding(pad, pad * 2, pad, pad);
    TextView title = new TextView(this);
    title.setText("AI usage bubble");
    title.setTextSize(22);
    TextView hint = new TextView(this);
    hint.setText("The PC's address on your tailnet. The overlay must be running on it, and Tailscale on both.");
    hint.setPadding(0, pad / 2, 0, pad / 2);
    server = new EditText(this);
    server.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
    server.setSingleLine();
    server.setText(Bubble.server(this));
    Button show = new Button(this);
    show.setText("Show bubble");
    show.setOnClickListener(v -> {
      prefs.edit().putString("server", server.getText().toString().trim().replaceAll("/+$", "")).apply();
      start();
    });
    Button stop = new Button(this);
    stop.setText("Remove bubble");
    stop.setOnClickListener(v -> {
      stopService(new Intent(this, Bubble.class));
      showLink(null); // the link goes with the bubble
    });
    col.addView(title);
    col.addView(hint);
    col.addView(server);
    col.addView(show);
    col.addView(stop);
    link = new TextView(this);
    link.setPadding(0, pad / 2, 0, 0);
    col.addView(link);
    setContentView(col);
  }

  void start() {
    if (!Settings.canDrawOverlays(this)) {
      asked = true;
      startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
      return;
    }
    startForegroundService(new Intent(this, Bubble.class));
    moveTaskToBack(true); // out of the way, so the bubble is what you see
  }

  /** The bubble runs the link, so with no bubble there is none. */
  void showLink(Link running) {
    link.setText("Link: " + (running == null ? "off until the bubble shows." : running.status()));
  }

  @Override protected void onResume() {
    super.onResume();
    showLink(Link.running);
    if (asked && Settings.canDrawOverlays(this)) {
      asked = false;
      start();
    }
  }
}
