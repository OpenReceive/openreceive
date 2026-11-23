#!/usr/bin/env bash
# Boots the lab AVD headless and keeps it in the foreground.
#
# The container runs on the host network, so:
#  - the adb server listens on 127.0.0.1:$ADB_PORT of the HOST, where
#    Playwright's `_android.devices({ port })` finds it;
#  - `adb reverse tcp:$DEVICE_PORT tcp:$DEMO_PORT` lands on the host's
#    127.0.0.1:$DEMO_PORT, where the testkit demo listens. On the device the
#    shop is then http://localhost:$DEVICE_PORT, a secure context like an
#    https shop (the Clipboard API needs one).
set -euo pipefail

ADB_PORT="${ADB_PORT:-15037}"
EMU_PORT="${EMU_PORT:-5654}"
DEMO_PORT="${DEMO_PORT:-4273}"
DEVICE_PORT="${DEVICE_PORT:-4173}"
CDP_PORT="${CDP_PORT:-15222}"
export ANDROID_ADB_SERVER_PORT="$ADB_PORT"
SERIAL="emulator-$EMU_PORT"

started=$(date +%s)
adb start-server

emulator -avd lab -port "$EMU_PORT" -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -no-snapshot -camera-back none -camera-front none \
  -netdelay none -netspeed full -accel on &
emu_pid=$!
trap 'kill "$emu_pid" 2>/dev/null || true' TERM INT

adb -s "$SERIAL" wait-for-device
until [ "$(adb -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  sleep 2
done
echo "android-lab: booted in $(( $(date +%s) - started ))s"

dsh() { adb -s "$SERIAL" shell "$@"; }
# Animations off: taps land on settled layouts, screenshots are stable.
dsh settings put global window_animation_scale 0
dsh settings put global transition_animation_scale 0
dsh settings put global animator_duration_scale 0
# Portrait, rotation under our control.
dsh settings put system accelerometer_rotation 0
dsh settings put system user_rotation 0
# Keep the screen on and unlocked for the whole run.
dsh svc power stayon true
dsh input keyevent KEYCODE_WAKEUP
dsh wm dismiss-keyguard || true
# Chrome opens with a "Chrome notifications make things easier" promo when it
# may not post notifications yet; granting the permission skips the promo.
dsh pm grant com.android.chrome android.permission.POST_NOTIFICATIONS || true
adb -s "$SERIAL" reverse "tcp:$DEVICE_PORT" "tcp:$DEMO_PORT"
# Chrome's DevTools socket, named on Chrome's command line by run-journeys.mjs.
# The forward stands even before Chrome opens the socket.
adb -s "$SERIAL" forward "tcp:$CDP_PORT" localabstract:lab_devtools_remote

chrome=$(dsh dumpsys package com.android.chrome | tr -d '\r' | sed -n 's/^ *versionName=//p' | head -1)
echo "android-lab: Chrome ${chrome:-NOT INSTALLED}; Android $(dsh getprop ro.build.version.release | tr -d '\r') (API $(dsh getprop ro.build.version.sdk | tr -d '\r'))"
echo "android-lab: READY serial=$SERIAL adb=127.0.0.1:$ADB_PORT cdp=127.0.0.1:$CDP_PORT device http://localhost:$DEVICE_PORT -> host 127.0.0.1:$DEMO_PORT"

wait "$emu_pid"
