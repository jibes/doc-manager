#!/usr/bin/env bash
# Emulator smoke test for the Android app (CI): install, launch, open the sample, read the screen
# through the accessibility tree, and fail on any error the web app logs (logcat tag "TesselWeb").
set -Eeuo pipefail  # -E: the failure report below also runs when a helper fails
APK="$1"
OUT="${2:-android-smoke}"
mkdir -p "$OUT"

# A failed dump must not leave the last screen's file behind to be read as this one.
ui() { adb shell rm -f /sdcard/ui.xml; adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true; adb shell cat /sdcard/ui.xml 2>/dev/null || true; }
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
# Taps $1 until at least $3 nodes match $2 (a first tap on the emulator's WebView is sometimes lost
# right after the screen changed; the browser e2e opens these dialogs on the first tap).
tap_until() {
  for _ in 1 2 3; do
    tap "$1"
    sleep 3
    [ "$(ui | sed 's/></>\n</g' | grep -Ec "(text|content-desc)=\"[^\"]*$2")" -ge "$3" ] && return 0
  done
  echo "No response to: $1"; screen | head -40
  return 1
}
# Visible texts and descriptions, for the log.
screen() { ui | sed 's/></>\n</g' | grep -Eo '(text|content-desc)="[^"]+"'; }
# Bounds of the first (or, with "last", the last) node whose text or description matches $1. A dump can fail on a
# busy screen (the camera's moving picture): it is tried again before giving up.
bounds_of() {
  local b pick="${2:-head}"
  for _ in 1 2 3; do
    b=$(ui | sed 's/></>\n</g' | grep -E "(text|content-desc)=\"[^\"]*$1" | { if [ "$pick" = last ]; then tail -1; else head -1; fi; } | grep -Eo 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -Eo '[0-9]+' | tr '\n' ' ' || true)
    [ -n "$b" ] && { echo "$b"; return 0; }
    sleep 2
  done
}
# Taps the centre of the first node whose text or description matches $1.
tap() {
  local b
  b=$(bounds_of "$1")
  [ -n "$b" ] || { echo "Nothing to tap for: $1"; screen | head -40; return 1; }
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}

# Holds a finger on the first node matching $1 (a long press: starts picking in a list).
hold() {
  local b
  b=$(bounds_of "$1")
  [ -n "$b" ] || { echo "Nothing to hold for: $1"; screen | head -40; return 1; }
  set -- $b
  adb shell input swipe $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 )) $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 )) 900
  sleep 1
}

# Waits for a path to exist on the device (file operations finish asynchronously).
on_device() {
  for _ in $(seq 1 15); do adb shell ls "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "Not on the device: $*"; adb shell ls -la /sdcard/Download; echo "--- screen ---"; screen | head -40; return 1
}

# Taps the last match instead (a dialog's button over the screen's own).
tap_last() {
  local b
  b=$(bounds_of "$1" last)
  [ -n "$b" ] || { echo "Nothing to tap for: $1"; screen | head -40; return 1; }
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
# AI reading needs the network: without this permission every request fails ("Failed to fetch").
adb shell dumpsys package app.tessel.viewer | grep -q "android.permission.INTERNET: granted=true" || { echo "No internet permission"; exit 1; }
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
wait_for "Everything comes in one way"
adb exec-out screencap -p > "$OUT/2b-text-view.png"
echo "--- screen (text view) ---"; screen | head -25
tap "Text view"
sleep 2
adb shell input keyevent KEYCODE_BACK
wait_for "Welcome to Tessel"
adb exec-out screencap -p > "$OUT/3-library.png"

# The Tessel folder (Documents/Tessel) as Documents lists it: a file put there by another app (adb here, with the
# access the system settings switch gives) is found, served to the WebView, opened, and deleted from the list.
adb shell appops set --uid app.tessel.viewer MANAGE_EXTERNAL_STORAGE allow
adb shell mkdir -p /sdcard/Documents/Tessel
adb push e2e/fixtures/columns.pdf /sdcard/Documents/Tessel/smoke-columns.pdf >/dev/null
adb shell am force-stop app.tessel.viewer
adb shell am start -W -n app.tessel.viewer/.MainActivity >/dev/null
wait_for "Orderly Notes"
sleep 3
adb exec-out screencap -p > "$OUT/4-documents.png"
echo "--- screen (documents) ---"; screen | head -25
if ui | grep -q 'text="Folders"'; then echo "Documents still has a Folders view"; exit 1; fi
tap "Orderly Notes"
wait_for "Appearance"
adb exec-out screencap -p > "$OUT/5-from-tessel-folder.png"
adb shell input keyevent KEYCODE_BACK
wait_for "Orderly Notes"
hold "Orderly Notes"
tap_until "Delete" "Delete this item" 1
tap_last "Delete"
sleep 2
if adb shell ls /sdcard/Documents/Tessel/smoke-columns.pdf 2>/dev/null; then echo "Not deleted"; exit 1; fi
echo "--- Tessel folder passed ---"

# Auto appearance: in the app it follows the light sensor (the switching itself is covered by the web e2e
# with a simulated sensor). Light stops listening; Auto starts again. Screenshots in a dark and a bright room.
for _ in 1 2 3 4; do adb shell input keyevent KEYCODE_BACK; sleep 1; done
adb shell am start -n app.tessel.viewer/.MainActivity >/dev/null
wait_for "Settings"
tap "Settings"
wait_for "Auto: follows dark mode and the light around you"
tap "Light"
sleep 2
# Connections to the light sensor with Light and with Auto (the report doesn't name apps).
light_users() { { adb shell dumpsys sensorservice | grep -Eo 'Light sensor \(handle=[^,]+, connections=[0-9]+' | grep -Eo '[0-9]+$' | head -1; } || true; }
before=$(light_users); before=${before:-0}
tap "Auto: follows dark mode and the light around you"
sleep 3
after=$(light_users); after=${after:-0}
echo "light sensor connections: $before with Light, $after with Auto"
if [ "$after" -le "$before" ]; then echo "Auto didn't start the light sensor"; exit 1; fi
adb emu sensor set light 1
sleep 5
adb exec-out screencap -p > "$OUT/7-sensor-dark.png"
adb emu sensor set light 3000
sleep 5
adb exec-out screencap -p > "$OUT/8-sensor-bright.png"
echo "--- Auto appearance: listening to the light sensor ---"

# Scanner: Android's camera permission, the live camera with the page detector (ONNX Runtime) loaded in the
# WebView, a photo taken by hand (the emulated camera shows no page: cropped by hand), and a searchable PDF
# saved to the library and opened.
for _ in 1 2 3 4; do adb shell input keyevent KEYCODE_BACK; sleep 1; done
adb shell am start -n app.tessel.viewer/.MainActivity >/dev/null
# The app opens on Documents: Add → Camera is the scanner.
wait_for "Add\""
tap "Add\""
wait_for "Camera\""
tap "Camera\""
wait_for "While using the app|Only this time|Allow"
tap "While using the app" || tap "Allow"
wait_for "Point at a page|Move closer|Hold steady|Too dark"
sleep 2
adb exec-out screencap -p > "$OUT/9-camera.png"
echo "--- screen (camera) ---"; screen | head -20
if ui | grep -q "Unable to play media"; then echo "The camera picture is announced as broken media"; exit 1; fi
tap "Take photo"
# Auto-capture may take pages by itself too (the emulated picture can look like a page): any page will do.
wait_for "Done, review|Full photo"
sleep 2
adb exec-out screencap -p > "$OUT/10-captured.png"
if ui | grep -q "Full photo"; then tap "Cancel"; sleep 2; fi
wait_for "Done, review"
# Auto-capture may still be adding pages (each with a flash and a message): tap again if the first one is lost.
for _ in 1 2 3; do
  ui | grep -q 'Recognise text' && break
  tap "Done, review" || true
  sleep 4
done
wait_for "Recognise text"
adb exec-out screencap -p > "$OUT/11-review.png"
tap_last "Save"  # not "Save to" above it
for _ in $(seq 1 60); do ui | grep -q 'Reading text\|Preparing page' || break; sleep 3; done
wait_for "Scan 2"
sleep 3
adb exec-out screencap -p > "$OUT/12-saved.png"
echo "--- screen (saved scan) ---"; screen | head -20
# Saved as a real file in Documents/Tessel (visible to other apps, kept after uninstall), not a hidden copy.
adb shell ls -la /sdcard/Documents/Tessel/
adb shell ls /sdcard/Documents/Tessel/ | grep -q '^Scan .*\.pdf' || { echo "The scan is not in Documents/Tessel"; exit 1; }
adb logcat -d -s TesselWeb:* | grep -Eo 'Scanner: (cross-origin isolated [a-z]+|text recognition with [0-9]+ thread)' | sort -u || true
echo "--- scanner passed ---"

adb logcat -d -s TesselWeb:* > "$OUT/web-console.txt" || true
echo "--- web console ---"; cat "$OUT/web-console.txt"
if grep -q '^E/TesselWeb\|^E TesselWeb\| E TesselWeb' "$OUT/web-console.txt"; then echo "The web app logged errors"; exit 1; fi
echo "Android smoke test passed"
