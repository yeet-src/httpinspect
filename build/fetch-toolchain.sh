#!/bin/sh
# Populate a shared toolchain cache directory, downloading only missing tools.
# Every artifact comes from one immutable, version-tagged release of the
# toolchain repo (releases/download/v<TOOLCHAIN_VERSION>/) and is
# checksum-verified against the pins in the lock.
#
#   build/fetch-toolchain.sh <dest-dir> <uname-arch> <lock> [tool...]
#
# With no trailing tool names, all tools are fetched (the build's `toolchain`
# target). Pass names (e.g. `git`) to fetch only those — `postgen` uses this to
# grab just git at generation time without pulling the whole toolchain.

set -eu

DIR="${1:?usage: fetch-toolchain.sh <dest-dir> <arch> <lock> [tool...]}"
ARCH="${2:?missing arch}"
LOCK="${3:?missing lock}"
shift 3
FILTER="$*"   # empty = all tools

# shellcheck disable=SC1090
. "$LOCK"

# Apple/BSD report arm64; the release assets are named aarch64.
[ "$ARCH" = arm64 ] && ARCH=aarch64

# The binaries are Linux musl-static — they can't run on any other OS. Skip
# cleanly there (exit 0) so callers fall back to host tools instead of failing.
# Normally toolchain.mk already no-ops the fetch off-Linux; this guards direct
# invocation too.
OS="$(uname -s)"
if [ "$OS" != Linux ]; then
	echo "note: vendored toolchain is Linux-only; on $OS the build uses host tools on PATH" >&2
	exit 0
fi

case "$ARCH" in
	x86_64 | aarch64) ;;
	*) echo "error: unsupported arch '$ARCH'" >&2; exit 1 ;;
esac

mkdir -p "$DIR"

# The one immutable release every asset is fetched from.
REL="${TOOLCHAIN_BASE_URL}/v${TOOLCHAIN_VERSION}"

want() { [ -z "$FILTER" ] && return 0; case " $FILTER " in *" $1 "*) return 0 ;; esac; return 1; }

sha() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
	elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
	else echo "error: no sha256 tool (sha256sum/shasum) found" >&2; return 1; fi
}

verify() { # file want-sha label
	[ -n "$2" ] || { echo "warning: no pinned checksum for $3 — skipping verify" >&2; return 0; }
	got="$(sha "$1")"
	[ "$got" = "$2" ] || { echo "error: $3 checksum mismatch: got $got want $2" >&2; return 1; }
}

get_sha() { eval "printf '%s' \"\${${1}_SHA256_${ARCH}:-}\""; }  # get_sha CLANG

# fetch_bin <tool-name> — asset is <tool>-<arch> inside the version release.
# Atomic: download beside the target, verify, then rename.
fetch_bin() {
	name="$1"
	want "$name" || return 0
	[ -x "$DIR/$name" ] && return 0
	echo ">> fetch ${name} (${ARCH}, v${TOOLCHAIN_VERSION})"
	tmp="$DIR/.${name}.$$"
	curl -fSL --retry 3 -o "$tmp" "${REL}/${name}-${ARCH}"
	verify "$tmp" "$(get_sha "$(echo "$name" | tr a-z A-Z)")" "$name" || { rm -f "$tmp"; exit 1; }
	chmod +x "$tmp"
	mv -f "$tmp" "$DIR/$name"
}

fetch_bin make
fetch_bin clang
fetch_bin bpftool
fetch_bin veristat
fetch_bin esbuild
fetch_bin git
fetch_bin gh

# libbpf program headers: arch-independent, one copy per version, beside the
# per-arch tool dirs ($key/include/bpf/*.h).
INC="$(dirname "$DIR")/include"
if want headers && [ ! -e "$INC/bpf/bpf_helpers.h" ]; then
	echo ">> fetch libbpf headers (v${TOOLCHAIN_VERSION})"
	td="$(mktemp -d)"
	curl -fSL --retry 3 -o "$td/h.tgz" "${REL}/libbpf-headers.tar.gz"
	verify "$td/h.tgz" "${LIBBPF_HEADERS_SHA256:-}" "libbpf-headers" || { rm -rf "$td"; exit 1; }
	mkdir -p "$INC"
	tar xzf "$td/h.tgz" -C "$INC"   # tarball holds a top-level bpf/ dir
	rm -rf "$td"
fi

echo ">> toolchain ready: $DIR${FILTER:+ ($FILTER)}"
