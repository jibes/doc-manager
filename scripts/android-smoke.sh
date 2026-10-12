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
# Taps the centre of the first node whose text or description matches $1.
tap() {
  local b
  b=$(ui | sed 's/></>\n</g' | grep -E "(text|content-desc)=\"[^\"]*$1" | head -1 | grep -Eo 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -Eo '[0-9]+' | tr '\n' ' ')
  [ -n "$b" ] || { echo "Nothing to tap for: $1"; return 1; }
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}

adb install -r "$APK"
adb logcat -c
adb shell am start -W -n app.tessel.viewer/.MainActivity
wait_for "Every document"
adb exec-out screencap -p > "$OUT/1-home.png"
tap "Open sample"
wait_for "Welcome to Tessel"
sleep 4
adb exec-out screencap -p > "$OUT/2-sample.png"
adb shell input keyevent KEYCODE_BACK
wait_for "Welcome to Tessel"
adb exec-out screencap -p > "$OUT/3-library.png"

adb logcat -d -s TesselWeb:* > "$OUT/web-console.txt" || true
echo "--- web console ---"; cat "$OUT/web-console.txt"
if grep -q '^E/TesselWeb\|^E TesselWeb\| E TesselWeb' "$OUT/web-console.txt"; then echo "The web app logged errors"; exit 1; fi
echo "Android smoke test passed"
