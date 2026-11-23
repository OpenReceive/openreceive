#!/usr/bin/env bash
# Start the Android Chrome lab: build the emulator image if needed, boot it in
# a container on the host network, and wait until the device is ready.
#
#   tests/android/start.sh            # API 35 (default)
#   API_LEVEL=34 tests/android/start.sh
#   tests/android/start.sh stop       # remove the container
#
# Ports (all on 127.0.0.1, override with the env vars):
#   ADB_PORT=15037   the adb server Playwright's _android API connects to
#   EMU_PORT=5654    the emulator console (and 5655, its adb port)
#   DEMO_PORT=4273   where the testkit demo listens on the host
#   DEVICE_PORT=4173 what the device calls it: http://localhost:4173
#   CDP_PORT=15222   Chrome DevTools on the device (adb forward)
set -euo pipefail

API_LEVEL="${API_LEVEL:-35}"
IMAGE="openreceive-android-lab:api${API_LEVEL}"
NAME="${ANDROID_LAB_CONTAINER:-openreceive-android-lab}"
ADB_PORT="${ADB_PORT:-15037}"
EMU_PORT="${EMU_PORT:-5654}"
DEMO_PORT="${DEMO_PORT:-4273}"
DEVICE_PORT="${DEVICE_PORT:-4173}"
CDP_PORT="${CDP_PORT:-15222}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$NAME" > /dev/null 2>&1 || true
  echo "android-lab: stopped $NAME"
  exit 0
fi

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  echo "android-lab: /dev/kvm is missing or not accessible; the x86_64 emulator needs KVM" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
  echo "android-lab: building $IMAGE (downloads about 2 GB from dl.google.com, once)"
  docker build --build-arg "API_LEVEL=$API_LEVEL" -t "$IMAGE" "$here"
fi

docker rm -f "$NAME" > /dev/null 2>&1 || true
started=$(date +%s)
docker run -d --name "$NAME" --network host --device /dev/kvm \
  -e "ADB_PORT=$ADB_PORT" -e "EMU_PORT=$EMU_PORT" \
  -e "DEMO_PORT=$DEMO_PORT" -e "DEVICE_PORT=$DEVICE_PORT" -e "CDP_PORT=$CDP_PORT" \
  "$IMAGE" > /dev/null

until docker logs "$NAME" 2>&1 | grep -q "android-lab: READY"; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then
    docker logs "$NAME" 2>&1 | tail -30 >&2
    echo "android-lab: the container exited before the device was ready" >&2
    exit 1
  fi
  if [ $(( $(date +%s) - started )) -gt 600 ]; then
    echo "android-lab: no boot after 10 minutes" >&2
    exit 1
  fi
  sleep 3
done
docker logs "$NAME" 2>&1 | grep "android-lab:"
echo "android-lab: ready in $(( $(date +%s) - started ))s (container $NAME)"
