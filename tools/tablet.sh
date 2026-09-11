#!/usr/bin/env bash
#
# Talk to the practice tablet over USB.
#
# Debugging this app from a description of what happened on screen is slow and
# error-prone — several bugs were mis-diagnosed that way. With USB debugging on, the
# tablet's Chrome can be driven directly: run the real app, on the real speaker and
# microphone, and read its state out.
#
# One-time setup on the tablet:
#   Settings > About tablet > Software information > tap "Build number" 7 times
#   Settings > Developer options > enable "USB debugging"
#   Reconnect the cable and accept "Allow USB debugging?" (tick "Always allow")
#
# Usage:
#   tools/tablet.sh status     what adb can see
#   tools/tablet.sh connect    forward Chrome's debug port to localhost:9222
#   tools/tablet.sh tabs       list open tabs on the tablet
#   tools/tablet.sh pull       copy any Drum Buddy recordings off the tablet
#   tools/tablet.sh open URL   open a URL in Chrome on the tablet
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

case "${1:-status}" in
  status)
    adb devices -l
    echo
    if adb get-state >/dev/null 2>&1; then
      echo "model:   $(adb shell getprop ro.product.model | tr -d '\r')"
      echo "android: $(adb shell getprop ro.build.version.release | tr -d '\r')"
      echo "chrome:  $(adb shell dumpsys package com.android.chrome | grep -m1 versionName | tr -d '\r' | xargs || echo 'not found')"
    else
      echo "No authorised device. Enable USB debugging on the tablet (see the header of this script)."
    fi
    ;;
  connect)
    adb forward --remove-all >/dev/null 2>&1 || true
    adb forward tcp:9222 localabstract:chrome_devtools_remote
    echo "Chrome on the tablet is now reachable at http://localhost:9222"
    curl -s --max-time 3 http://localhost:9222/json/version || echo "(no response — is Chrome open on the tablet?)"
    ;;
  tabs)
    curl -s --max-time 3 http://localhost:9222/json | python3 -c 'import json,sys
for t in json.load(sys.stdin):
    if t.get("type")=="page": print(f"{t[\"title\"][:50]:52} {t[\"url\"][:60]}")'
    ;;
  open)
    adb shell am start -a android.intent.action.VIEW -d "${2:?need a URL}" com.android.chrome >/dev/null
    echo "opened ${2} on the tablet"
    ;;
  pull)
    mkdir -p tools/recordings
    adb shell 'ls /sdcard/Download/take*' 2>/dev/null | tr -d '\r' | while read -r f; do
      [ -n "$f" ] && adb pull "$f" tools/recordings/ >/dev/null && echo "pulled $(basename "$f")"
    done
    echo "done"
    ;;
  *) echo "unknown command: $1"; exit 1 ;;
esac
