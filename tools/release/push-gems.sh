#!/usr/bin/env bash
#
# Push the built OpenReceive gems to RubyGems, one prompt at a time, and PROVE
# each one landed before moving on. This is step 2.11 of the release runbook as
# a script, and it exists because that step has three sharp edges:
#
#   1. `gem push` falls back to ~/.local/share/gem/credentials whenever
#      GEM_HOST_API_KEY is unset, so a bare shell authenticates as the wrong
#      account and RubyGems reports it as "Your OTP code is incorrect". This
#      script always sources .env.release itself, then proves the key answers,
#      so that failure mode cannot reach the push at all.
#   2. A TOTP code lives ~30 seconds, and anything slow between reading the code
#      and pushing (a gem rebuild especially) spends the window. Everything slow
#      here happens BEFORE the first prompt.
#   3. `npm run release:gem:publish` asserts every gem is unpublished and aborts
#      on the one that already landed, which is exactly the state a half-finished
#      push leaves behind. This script skips what is published (after checking
#      the checksum matches what we built) and pushes only the rest, so it is
#      safe to re-run.
#
# RubyGems CONSUMES a TOTP code, so one code cannot cover all three pushes: the
# second use is rejected as a replay. The script reuses the code you gave it and
# reprompts only when the server actually refuses, which is the fewest codes the
# server will accept.
#
# Usage:
#   tools/release/push-gems.sh [--otp 123456] [--version 0.2.2] [--dry-run]
#
# With no --otp it prompts for the first one.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

OTP=""
VERSION=""
DRY_RUN=false
MAX_OTP_ATTEMPTS=5

# Dependency order: a gem's siblings are exact-pinned, so pushing openreceive
# last would leave a window where openreceive-rails names a version RubyGems
# does not have yet.
GEM_ORDER=(openreceive openreceive-server openreceive-rails)

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --otp) OTP="${2:-}"; shift 2 ;;
    --otp=*) OTP="${1#*=}"; shift ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# Identity. Sourced here, never assumed from the caller's shell.
# ---------------------------------------------------------------------------
step "Identity"

[ -f .env.release ] || die ".env.release not found in $ROOT (see runbook PART 0)."
# shellcheck disable=SC1091
set -a; . ./.env.release; set +a

[ -n "${GEM_HOST_API_KEY:-}" ] || die "GEM_HOST_API_KEY is empty after sourcing .env.release."

# The key is push-scoped, so it cannot read the gem index: 403 is the CORRECT
# answer and proves the key authenticates. 401 means it is dead or mis-pasted —
# which is precisely what the stale credentials-file key returns.
key_status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: $GEM_HOST_API_KEY" https://rubygems.org/api/v1/gems.json || true)"
case "$key_status" in
  403) note "  gem key: authenticates, push-scoped (403) — correct" ;;
  200) note "  gem key: authenticates but is OVER-SCOPED (200). Works; re-issue as push-only when convenient." ;;
  401) die "gem key: 401 Access Denied. The key in .env.release is revoked or mis-pasted. Re-copy it from https://rubygems.org/profile/api_keys" ;;
  *)   die "gem key: unexpected status '$key_status' from rubygems.org. Check connectivity before pushing." ;;
esac

if [ -f "$HOME/.local/share/gem/credentials" ]; then
  note "  note: ~/.local/share/gem/credentials exists (a stale key gem push would fall back to)."
  note "        This script exports GEM_HOST_API_KEY, which takes precedence, so it is inert here."
fi

# ---------------------------------------------------------------------------
# Artifacts. Built BEFORE any OTP is read, so no code expires waiting on a build.
# ---------------------------------------------------------------------------
step "Artifacts"

if [ -z "$VERSION" ]; then
  VERSION="$(node -p "require('./package.json').version")"
fi
note "  workspace version: $VERSION"

GEM_DIR=".release/gems/$VERSION"
if [ ! -d "$GEM_DIR" ] || [ -z "$(ls -A "$GEM_DIR"/*.gem 2>/dev/null || true)" ]; then
  note "  no built gems in $GEM_DIR — building now (before any OTP is read)"
  npm run release:gem:build >/dev/null
fi

# Resolve each gem's file and its RubyGems version from the artifact itself:
# a prerelease's filename carries the normalized form ("0.2.0.pre.alpha.1"),
# and that is also the form the RubyGems API wants.
declare -a GEM_FILES=() GEM_VERSIONS=()
for name in "${GEM_ORDER[@]}"; do
  # `openreceive-*.gem` also matches openreceive-server and openreceive-rails,
  # so the basename's name half has to match EXACTLY. A gem version never
  # contains a dash (a prerelease normalizes to "0.2.0.pre.alpha.1"), so the
  # last dash is the name/version boundary.
  file=""; gem_version=""
  for candidate in "$GEM_DIR/$name"-*.gem; do
    [ -e "$candidate" ] || continue
    base="$(basename "$candidate" .gem)"
    [ "${base%-*}" = "$name" ] || continue
    file="$candidate"
    gem_version="${base##*-}"
    break
  done
  [ -n "$file" ] || die "no built gem for $name in $GEM_DIR. Run: npm run release:gem:build"
  GEM_FILES+=("$file")
  GEM_VERSIONS+=("$gem_version")
  note "  $name $gem_version  ($file)"
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# published <name> <version> -> 0 when RubyGems already has that exact version.
published() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' \
      "https://rubygems.org/api/v2/rubygems/$1/versions/$2.json")" = "200" ]
}

# remote_sha <name> <version> -> the sha256 RubyGems holds for that version.
remote_sha() {
  curl -s "https://rubygems.org/api/v2/rubygems/$1/versions/$2.json" \
    | python3 -c "import json,sys; print(json.load(sys.stdin).get('sha',''))" 2>/dev/null || true
}

local_sha() { shasum -a 256 "$1" | awk '{print $1}'; }

# Prompt on the terminal even when stdin is a pipe, so this works under `| tee`.
read_otp() {
  local prompt="$1" value=""
  if [ -r /dev/tty ]; then
    printf '%s' "$prompt" > /dev/tty
    read -r value < /dev/tty
  else
    printf '%s' "$prompt"
    read -r value
  fi
  printf '%s' "$value" | tr -cd '0-9'
}

# confirm_landed <name> <version> <file> — RubyGems indexes asynchronously, so
# poll briefly rather than declaring failure on the first miss. Also proves the
# bytes RubyGems holds are the bytes we built.
confirm_landed() {
  local name="$1" version="$2" file="$3" want got
  want="$(local_sha "$file")"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if published "$name" "$version"; then
      got="$(remote_sha "$name" "$version")"
      if [ -z "$got" ]; then
        note "    verified: $name $version is on RubyGems (checksum not reported)"
        return 0
      fi
      if [ "$got" = "$want" ]; then
        note "    verified: $name $version on RubyGems, checksum matches our build"
        return 0
      fi
      die "$name $version is on RubyGems but its checksum does NOT match the gem we built.
       ours:   $want
       theirs: $got
       Someone else published this version. Do not yank; investigate first."
    fi
    sleep 3
  done
  return 1
}

# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------
step "Push"

pushed=() skipped=()

for i in "${!GEM_ORDER[@]}"; do
  name="${GEM_ORDER[$i]}"
  file="${GEM_FILES[$i]}"
  gem_version="${GEM_VERSIONS[$i]}"

  printf '\n  %s %s\n' "$name" "$gem_version"

  if published "$name" "$gem_version"; then
    got="$(remote_sha "$name" "$gem_version")"
    want="$(local_sha "$file")"
    if [ -n "$got" ] && [ "$got" != "$want" ]; then
      die "$name $gem_version is already on RubyGems with a DIFFERENT checksum.
       ours:   $want
       theirs: $got"
    fi
    note "    already published (checksum matches) — skipping"
    skipped+=("$name")
    continue
  fi

  if [ "$DRY_RUN" = true ]; then
    note "    dry-run: gem push $file --otp <code>"
    continue
  fi

  attempt=1
  while : ; do
    if [ -z "$OTP" ]; then
      OTP="$(read_otp "    fresh 6-digit OTP for $name (wait for a code that just rolled over): ")"
      [ -n "$OTP" ] || die "no OTP entered; nothing pushed for $name."
    fi

    note "    pushing…"
    if out="$(gem push "$file" --otp "$OTP" 2>&1)"; then
      note "    gem push reported success"
      OTP=""   # consumed; the next gem needs its own code
      if confirm_landed "$name" "$gem_version" "$file"; then
        pushed+=("$name")
        break
      fi
      die "gem push succeeded but $name $gem_version never appeared on RubyGems.
       Check https://rubygems.org/gems/$name before re-running."
    fi

    printf '%s\n' "$out" | sed 's/^/      | /'

    case "$out" in
      *"has already been pushed"*|*"already been pushed"*)
        note "    RubyGems says this version already exists — treating as done"
        skipped+=("$name"); OTP=""; break ;;
      *"Access Denied"*|*"Unauthorized"*|*"401"*)
        die "RubyGems refused the API key while pushing $name.
       The key in .env.release is dead or belongs to another account.
       Nothing after $name was pushed." ;;
      *"OTP"*|*"otp"*|*"multifactor"*|*"two-factor"*)
        OTP=""
        attempt=$((attempt + 1))
        if [ "$attempt" -gt "$MAX_OTP_ATTEMPTS" ]; then
          die "$MAX_OTP_ATTEMPTS OTP attempts failed for $name.
       The key authenticated at startup, so this is the code, not the account:
       type the whole command first, then read a code that has just rolled over."
        fi
        note "    that code was rejected (attempt $attempt of $MAX_OTP_ATTEMPTS) — a consumed or expired code does this."
        ;;
      *)
        die "gem push failed for $name for a reason this script does not recognise (above).
       Nothing after $name was pushed." ;;
    esac
  done
done

# ---------------------------------------------------------------------------
step "Result"

# A gem in `pushed` was confirmed by checksum in confirm_landed, and one in
# `skipped` was found on RubyGems with a matching checksum before any push.
# Report those from that evidence rather than asking RubyGems again: the
# index sits behind a CDN that can answer one request with a miss seconds
# after ten polls said yes, and the 0.4.0 run printed NOT PUBLISHED for a gem
# it had verified moments earlier. Only a gem with no recorded outcome is
# re-queried, with the same patience confirm_landed has.
settled() {
  local candidate
  for candidate in "${pushed[@]}" "${skipped[@]}"; do
    [ "$candidate" = "$1" ] && return 0
  done
  return 1
}

published_eventually() {
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    published "$1" "$2" && return 0
    sleep 3
  done
  return 1
}

for i in "${!GEM_ORDER[@]}"; do
  name="${GEM_ORDER[$i]}"
  gem_version="${GEM_VERSIONS[$i]}"
  if [ "$DRY_RUN" = true ]; then
    printf '  %-20s %s (dry-run)\n' "$name" "$gem_version"
  elif settled "$name" || published_eventually "$name" "$gem_version"; then
    printf '  %-20s %s  live: https://rubygems.org/gems/%s/versions/%s\n' \
      "$name" "$gem_version" "$name" "$gem_version"
  else
    printf '  %-20s %s  NOT PUBLISHED\n' "$name" "$gem_version"
  fi
done

if [ "$DRY_RUN" = false ] && [ "${#pushed[@]}" -gt 0 ]; then
  cat <<EOF

Next:
  gem owner openreceive          # MUST list the OpenReceive account
  tools/release/gh-release.sh    # or runbook 2.12: gh release create v$VERSION …
EOF
fi
