#!/usr/bin/env bash
# Emulator smoke test for the Android app (CI): install, launch, open the sample, read the screen
# through the accessibility tree, and fail on any error the web app logs (logcat tag "TesselWeb").
set -euo pipefail
APK="$1"
OUT="${2:-android-smoke}"
mkdir -p "$OUT"

ui() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true; adb shell cat /sdcard/ui.xml 2>/dev/null || true; }
# Waits until the screen shows a text (or content description) matching $1.
wait_for() {
  for _ in $(seq 1 30); do
    if ui | grep -Eq "(text|content-desc)=\"[^\"]*$1"; then return 0; fi
    sleep 2
  done
  echo "Timed out waiting for: $1"; ui | sed 's/></>\n</g' | grep -Eo '(text|content-desc)="[^"]+"' | head -60
  return 1
}
# Visible texts and descriptions, for the log.
screen() { ui | sed 's/></>\n</g' | grep -Eo '(text|content-desc)="[^"]+"'; }
# Taps the centre of the first node whose text or description matches $1.
tap() {
  local b
  b=$(ui | sed 's/></>\n</g' | grep -E "(text|content-desc)=\"[^\"]*$1" | head -1 | grep -Eo 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -Eo '[0-9]+' | tr '\n' ' ')
  [ -n "$b" ] || { echo "Nothing to tap for: $1"; return 1; }
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}

# On failure: what was on screen, and why the app went away (crash, WebView renderer, system).
on_fail() {
  adb exec-out screencap -p > "$OUT/failure.png" 2>/dev/null || true
  adb logcat -d > "$OUT/logcat.txt" 2>/dev/null || true
  echo "--- crashes ---"; adb logcat -d -b crash 2>/dev/null | tail -40 || true
  echo "--- app, WebView and system ---"
  grep -E "tessel|AndroidRuntime|chromium|cr_|Renderer|ActivityManager: (Process|Killing)|lowmemorykiller" "$OUT/logcat.txt" | tail -60 || true
}
trap 'on_fail' ERR

adb install -r "$APK"
adb logcat -c
adb shell am start -W -n app.tessel.viewer/.MainActivity
wait_for "Every document"
adb exec-out screencap -p > "$OUT/1-home.png"
echo "--- screen (home) ---"; screen | head -25
tap "Open sample"
wait_for "Welcome to Tessel"
sleep 4
adb exec-out screencap -p > "$OUT/2-sample.png"
# Text view: PDFium's text extraction, running as WebAssembly in a worker inside the WebView.
tap "Text view"
wait_for "Every PDF you open lands in Recent"
adb exec-out screencap -p > "$OUT/2b-text-view.png"
echo "--- screen (text view) ---"; screen | head -25
tap "Page view"
sleep 2
adb shell input keyevent KEYCODE_BACK
wait_for "Welcome to Tessel"
adb exec-out screencap -p > "$OUT/3-library.png"

adb logcat -d -s TesselWeb:* > "$OUT/web-console.txt" || true
echo "--- web console ---"; cat "$OUT/web-console.txt"
if grep -q '^E/TesselWeb\|^E TesselWeb\| E TesselWeb' "$OUT/web-console.txt"; then echo "The web app logged errors"; exit 1; fi
echo "Android smoke test passed"
