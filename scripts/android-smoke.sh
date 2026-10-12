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
# Waits until the screen shows at least $2 nodes matching $1.
wait_count() {
  for _ in $(seq 1 30); do
    [ "$(ui | sed 's/></>\n</g' | grep -Ec "(text|content-desc)=\"[^\"]*$1")" -ge "$2" ] && return 0
    sleep 2
  done
  echo "Timed out waiting for $2 × $1"; screen | head -40
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

# Waits for a path to exist on the device (file operations finish asynchronously).
on_device() {
  for _ in $(seq 1 15); do adb shell ls "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "Not on the device: $*"; adb shell ls -la /sdcard/Download; echo "--- screen ---"; screen | head -40; return 1
}

# Taps the last match instead (a dialog's button over the screen's own).
tap_last() {
  local b
  b=$(ui | sed 's/></>\n</g' | grep -E "(text|content-desc)=\"[^\"]*$1" | tail -1 | grep -Eo 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -Eo '[0-9]+' | tr '\n' ' ')
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
  grep -iE "tessel|AndroidRuntime|chromium|cr_|Renderer|ActivityManager: (Process|Killing)|lowmemorykiller" "$OUT/logcat.txt" | tail -60 || true
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

# Files with all files access (granted here the way the system settings switch does): internal storage is
# browsed by the app, documents are served to the WebView, and thumbnails are made from them.
adb shell appops set --uid app.tessel.viewer MANAGE_EXTERNAL_STORAGE allow
adb push e2e/fixtures/columns.pdf /sdcard/Download/smoke-columns.pdf >/dev/null
tap "Files"
wait_for "Browse your folders"
tap "Settings"
wait_for "Show every document on this device"
tap "Show every document on this device"
sleep 2
adb shell input keyevent KEYCODE_BACK
wait_for "Internal storage"
tap "Internal storage"
wait_for "Download"
tap "Download"
wait_for "smoke-columns.pdf"
sleep 5
adb exec-out screencap -p > "$OUT/4-files.png"
echo "--- screen (files) ---"; screen | head -25
tap "smoke-columns.pdf"
wait_for "Text view"
adb exec-out screencap -p > "$OUT/5-from-folder.png"

# File operations on real storage: new folder, rename, move, delete.
adb shell input keyevent KEYCODE_BACK
wait_for "smoke-columns.pdf"
tap "New folder"
wait_for "Cancel"
adb shell input text Smoke
sleep 1
tap_last "New folder"
on_device -d /sdcard/Download/Smoke
tap "Select"
tap "smoke-columns.pdf"
tap "Rename"
# The selection bar has its own "Cancel": wait for the dialog's as well.
wait_count "Cancel\"" 2
adb shell input keyevent KEYCODE_MOVE_END
for _ in $(seq 1 30); do adb shell input keyevent KEYCODE_DEL; done
adb shell input text smoke-renamed.pdf
sleep 1
echo "--- screen (rename) ---"; screen | head -30
tap_last "Rename"
on_device /sdcard/Download/smoke-renamed.pdf
wait_for "smoke-renamed.pdf\""
tap "Select"
tap "smoke-renamed.pdf"
tap "Move"
wait_for "Open the folder to move to"
tap "Smoke\""
tap "item here"
on_device /sdcard/Download/Smoke/smoke-renamed.pdf
wait_for "smoke-renamed.pdf\""
adb exec-out screencap -p > "$OUT/6-moved.png"
tap "Select"
tap "smoke-renamed.pdf"
tap "Delete"
wait_for "Delete this item"
tap_last "Delete"
sleep 2
if adb shell ls /sdcard/Download/Smoke/smoke-renamed.pdf 2>/dev/null; then echo "Not deleted"; exit 1; fi
echo "--- file operations passed ---"

# Light sensor theme: dark room → Black, bright room → Light (the emulator's light sensor drives it).
# Brightness of a background pixel, from a raw screenshot (16-byte header, then RGBA).
px() { adb exec-out screencap | python3 -c "import sys; d = sys.stdin.buffer.read(); w = int.from_bytes(d[0:4], 'little'); o = 16 + (300 * w + 6) * 4; print(sum(d[o:o + 3]) // 3)"; }
for _ in 1 2 3 4; do adb shell input keyevent KEYCODE_BACK; sleep 1; done
adb shell am start -n app.tessel.viewer/.MainActivity >/dev/null
wait_for "Settings"
tap "Settings"
wait_for "Light sensor"
tap "Light sensor"
adb emu sensor set light 1
sleep 5
dark=$(px)
adb exec-out screencap -p > "$OUT/7-sensor-dark.png"
adb emu sensor set light 3000
sleep 5
bright=$(px)
adb exec-out screencap -p > "$OUT/8-sensor-bright.png"
echo "light sensor theme: background $dark in the dark, $bright in bright light"
if [ "$dark" -ge 60 ] || [ "$bright" -le 150 ]; then echo "The light sensor theme didn't follow the light"; exit 1; fi

adb logcat -d -s TesselWeb:* > "$OUT/web-console.txt" || true
echo "--- web console ---"; cat "$OUT/web-console.txt"
if grep -q '^E/TesselWeb\|^E TesselWeb\| E TesselWeb' "$OUT/web-console.txt"; then echo "The web app logged errors"; exit 1; fi
echo "Android smoke test passed"
