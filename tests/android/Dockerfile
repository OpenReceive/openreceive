# Android emulator with Chrome, headless, for the Android Chrome payer lab.
#
# Everything Android comes from Google's own repository (dl.google.com) via
# sdkmanager: the command-line tools, platform-tools (adb), the emulator, and a
# `google_apis` x86_64 system image. `google_apis` (not `google_apis_playstore`)
# because it is a userdebug build: `adb root` works and Chrome reads
# /data/local/tmp/chrome-command-line, which Playwright's Android driver needs.
# It ships Chrome preinstalled (no Play Store, so Chrome never updates itself).
#
# Build:  docker build -t openreceive-android-lab tests/android
# Run:    tests/android/start.sh   (needs /dev/kvm)
FROM ubuntu:24.04

# cmdline-tools 19.0, the last plain sdkmanager. 20.0+ hands sdkmanager to the
# new "Android CLI", which downloads itself and sends usage metrics by default.
ARG CMDLINE_TOOLS_ZIP=commandlinetools-linux-13114758_latest.zip
ARG CMDLINE_TOOLS_SHA1=5fdcc763663eefb86a5b8879697aa6088b041e70
ARG API_LEVEL=35
ARG IMAGE_TAG=google_apis
ARG ABI=x86_64

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    ANDROID_AVD_HOME=/root/.android/avd \
    API_LEVEL=${API_LEVEL} \
    IMAGE_TAG=${IMAGE_TAG} \
    ABI=${ABI}
ENV PATH=${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/emulator:${PATH}

# The emulator binary links X11/GL/NSS/Pulse libraries even with -no-window.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openjdk-21-jre-headless curl unzip ca-certificates \
      libpulse0 libnss3 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
      libasound2t64 libgl1 libegl1 libxkbfile1 libx11-xcb1 libxkbcommon0 \
      libdbus-1-3 libfontconfig1 libgbm1 libxrandr2 libxfixes3 libxrender1 \
      libxext6 libx11-6 libdrm2 libbsd0 libtinfo6 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLo /tmp/clt.zip "https://dl.google.com/android/repository/${CMDLINE_TOOLS_ZIP}" \
 && echo "${CMDLINE_TOOLS_SHA1}  /tmp/clt.zip" | sha1sum -c - \
 && mkdir -p "${ANDROID_HOME}/cmdline-tools" \
 && unzip -q /tmp/clt.zip -d "${ANDROID_HOME}/cmdline-tools" \
 && mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" \
 && rm /tmp/clt.zip

RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platform-tools" "emulator" \
      "system-images;android-${API_LEVEL};${IMAGE_TAG};${ABI}" > /dev/null \
 && sdkmanager --list_installed

# A 360 CSS px wide phone (1080 x 2340 at 480 dpi, DPR 3): the most common
# Android Chrome viewport width, and narrower than a Pixel's 411/412.
RUN echo no | avdmanager create avd --force --name lab \
      --package "system-images;android-${API_LEVEL};${IMAGE_TAG};${ABI}" --device pixel_6 \
 && cfg="${ANDROID_AVD_HOME}/lab.avd/config.ini" \
 && sed -i -e '/^hw.lcd.width/d' -e '/^hw.lcd.height/d' -e '/^hw.lcd.density/d' \
      -e '/^hw.ramSize/d' -e '/^hw.keyboard/d' -e '/^hw.cpu.ncore/d' \
      -e '/^disk.dataPartition.size/d' -e '/^hw.gpu/d' "$cfg" \
 && printf '%s\n' 'hw.lcd.width=1080' 'hw.lcd.height=2340' 'hw.lcd.density=480' \
      'hw.ramSize=4096' 'hw.cpu.ncore=4' 'hw.keyboard=no' \
      'disk.dataPartition.size=6G' 'hw.gpu.enabled=yes' 'hw.gpu.mode=swiftshader_indirect' >> "$cfg"

COPY entrypoint.sh /usr/local/bin/android-lab-entrypoint
RUN chmod +x /usr/local/bin/android-lab-entrypoint
ENTRYPOINT ["/usr/local/bin/android-lab-entrypoint"]
