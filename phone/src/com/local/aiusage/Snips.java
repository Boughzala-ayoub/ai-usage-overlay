package com.local.aiusage;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.util.ArrayList;
import java.util.List;

/**
 * The snips in cache/snips, read-only, for the app the clipboard hands one to (it grants that app the URI).
 * Not exported: no other app reads a snip it wasn't given.
 */
public class Snips extends ContentProvider {
  static Uri uri(File png) { return Uri.parse("content://com.local.aiusage.snips/" + png.getName()); }

  File file(Uri u) throws FileNotFoundException {
    String name = u.getLastPathSegment();
    if (name == null || !name.matches("\\d+\\.png")) throw new FileNotFoundException(String.valueOf(u)); // a snip's name, nothing outside the folder
    return new File(new File(getContext().getCacheDir(), "snips"), name);
  }

  @Override public boolean onCreate() { return true; }

  @Override public String getType(Uri u) { return "image/png"; }

  @Override public ParcelFileDescriptor openFile(Uri u, String mode) throws FileNotFoundException {
    return ParcelFileDescriptor.open(file(u), ParcelFileDescriptor.MODE_READ_ONLY);
  }

  /** The name and size a pasting app may ask for, as of any shared file; other columns it asks for are left out. */
  @Override public Cursor query(Uri u, String[] columns, String where, String[] args, String order) {
    File f;
    try {
      f = file(u);
    } catch (FileNotFoundException e) {
      return null;
    }
    List<String> names = new ArrayList<>();
    List<Object> row = new ArrayList<>();
    for (String c : columns != null ? columns : new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }) {
      if (OpenableColumns.DISPLAY_NAME.equals(c)) row.add(f.getName());
      else if (OpenableColumns.SIZE.equals(c)) row.add(f.length());
      else continue;
      names.add(c);
    }
    MatrixCursor cursor = new MatrixCursor(names.toArray(new String[0]), 1);
    cursor.addRow(row);
    return cursor;
  }

  @Override public Uri insert(Uri u, ContentValues v) { throw new UnsupportedOperationException(); }

  @Override public int update(Uri u, ContentValues v, String where, String[] args) { throw new UnsupportedOperationException(); }

  @Override public int delete(Uri u, String where, String[] args) { throw new UnsupportedOperationException(); }
}
