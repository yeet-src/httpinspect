#!/bin/sh
# Boot a matrix of kernels locally and run the verifier check (build/verify-
# kernel.sh) in each — the local counterpart to .github/workflows/kernel-
# matrix.yml. This is a TEST HARNESS, not part of the build, and needs a
# Linux host (ideally with /dev/kvm; without it QEMU falls back to slow TCG).
#
#   build/kernel-matrix.sh [kernel ...]      # default: an LTS spread + bpf-next
#   make veristat-matrix                      # same, via the Makefile
#
# It uses cilium's lvh + QEMU to boot quay.io/lvh-images/kind:<kernel> images.
# Neither lvh nor qemu is part of the build toolchain (they're VM infra needing
# host KVM/root, not self-contained build tools), so both are fetched on demand:
#   - lvh:  an `lvh` on PATH, else extracted from the quay.io/lvh-images/lvh image.
#   - qemu: the vendored static qemu-<arch>.tar.gz from the toolchain release
#           (checksum-pinned in build/toolchain.lock), extracted to the toolchain
#           cache and prepended to PATH; falls back to a system qemu-system.
# veristat is the vendored static binary, resolved like the build.

set -eu

KERNELS=${*:-"5.10-main 5.15-main 6.1-main 6.6-main 6.12-main bpf-next-main"}
LVH_VERSION="${LVH_VERSION:-v0.0.30}"
SSH_PORT="${SSH_PORT:-2222}"
MON_PORT="${MON_PORT:-45454}"
OBJ="${OBJ:-bin/probe.bpf.o}"

case "$(uname -s)" in
	Linux) ;;
	*) echo "error: the kernel matrix needs a Linux host (QEMU/KVM); on $(uname -s) use the CI workflow instead." >&2; exit 1 ;;
esac

# ARCH = uname machine (toolchain asset naming); QARCH = lvh/qemu platform name.
ARCH="$(uname -m)"
case "$ARCH" in
	x86_64)  QARCH=amd64 ;;
	aarch64) QARCH=arm64 ;;
	*) echo "error: unsupported arch '$ARCH'" >&2; exit 1 ;;
esac
QEMU="qemu-system-${ARCH}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' not found — $2" >&2; exit 1; }; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
need ssh "install openssh-client"

# --- resolve qemu: prefer the vendored static qemu from the toolchain release,
# fall back to a system qemu-system on PATH. lvh finds qemu via PATH and the
# static qemu finds its firmware blobs relative to its own binary, so we just
# prepend the extracted bin dir to PATH — no -L plumbing into lvh needed.
if [ -f build/toolchain.lock ]; then
	. ./build/toolchain.lock
	qsha="$(eval "printf '%s' \"\${QEMU_SHA256_${ARCH}:-}\"")"
	QDIR="${XDG_CACHE_HOME:-$HOME/.cache}/yeet/toolchain/v${TOOLCHAIN_VERSION}/${ARCH}/qemu"
	if [ ! -x "$QDIR/bin/$QEMU" ] && [ -n "$qsha" ] && [ -n "${TOOLCHAIN_BASE_URL:-}" ]; then
		echo ">> fetching static qemu (${ARCH}, v${TOOLCHAIN_VERSION})"
		tmp="$(mktemp -d)"
		if curl -fSL --retry 3 -o "$tmp/q.tgz" "${TOOLCHAIN_BASE_URL}/v${TOOLCHAIN_VERSION}/qemu-${ARCH}.tar.gz"; then
			got="$(sha256 "$tmp/q.tgz")"
			if [ "$got" = "$qsha" ]; then
				mkdir -p "$QDIR"; tar xzf "$tmp/q.tgz" -C "$QDIR"; chmod +x "$QDIR/bin/$QEMU" 2>/dev/null || true
			else
				echo "warning: qemu checksum mismatch (got $got, want $qsha); using system qemu" >&2
			fi
		else
			echo "warning: could not download qemu; using system qemu" >&2
		fi
		rm -rf "$tmp"
	fi
	if [ -x "$QDIR/bin/$QEMU" ]; then
		PATH="$QDIR/bin:$PATH"; export PATH
		echo ">> using vendored static qemu: $QDIR/bin/$QEMU"
	fi
fi
need "$QEMU" "no vendored qemu in build/toolchain.lock and none on PATH — bump the lock to a toolchain that ships qemu, or install qemu-system"

# --- resolve lvh (PATH, else extract from the OCI image with docker) ----------
LVH="$(command -v lvh || true)"
if [ -z "$LVH" ]; then
	need docker "needed to fetch lvh (or put an 'lvh' binary on PATH)"
	echo ">> fetching lvh ${LVH_VERSION} from quay.io/lvh-images/lvh"
	docker pull "quay.io/lvh-images/lvh:${LVH_VERSION}" >/dev/null
	cid="$(docker create "quay.io/lvh-images/lvh:${LVH_VERSION}")"
	LVH="$(mktemp -d)/lvh"
	docker cp "$cid:/usr/bin/lvh" "$LVH" >/dev/null
	docker rm "$cid" >/dev/null
	chmod +x "$LVH"
fi

[ -e /dev/kvm ] && ACCEL="--cpu-kind host" || { ACCEL="--no-hw-accel"; echo "note: /dev/kvm absent — running under TCG emulation (slow)"; }

# --- build the object and stage the vendored static veristat ------------------
echo ">> building $OBJ"
make bpf >/dev/null
VERISTAT="${VERISTAT:-}"
if [ -z "$VERISTAT" ] && [ -f build/toolchain.lock ]; then
	. ./build/toolchain.lock
	VERISTAT="${XDG_CACHE_HOME:-$HOME/.cache}/yeet/toolchain/v${TOOLCHAIN_VERSION}/${ARCH}/veristat"
fi
[ -n "$VERISTAT" ] && [ -x "$VERISTAT" ] || VERISTAT="$(command -v veristat || true)"
[ -n "$VERISTAT" ] && [ -x "$VERISTAT" ] || { echo "error: veristat not found — bump build/toolchain.lock to a toolchain that ships it, or install veristat" >&2; exit 1; }
install -Dm755 "$VERISTAT" bin/veristat

# --- per-kernel: pull image, boot, verify, stop -------------------------------
WORK="$(mktemp -d)"
OUTDIR="$PWD/.kmatrix"; rm -rf "$OUTDIR"; mkdir -p "$OUTDIR"
overall=0

stop_vm() { printf 'quit\n' | { nc -N 127.0.0.1 "$MON_PORT" 2>/dev/null || nc 127.0.0.1 "$MON_PORT" 2>/dev/null; } || true; sleep 1; }
trap 'stop_vm' EXIT INT TERM

for k in $KERNELS; do
	echo ">> ==== kernel $k ===="
	imgdir="$WORK/img/$k"; mkdir -p "$imgdir"
	"$LVH" images pull "quay.io/lvh-images/kind:$k" --dir "$imgdir" --platform "linux/$QARCH"
	img="$(find "$imgdir" -name '*.qcow2' | head -1)"
	[ -n "$img" ] || { echo "::skip:: no image for $k" >&2; overall=1; continue; }

	sudo "$LVH" run --image "$img" --host-mount "$PWD" --daemonize \
		-p "${SSH_PORT}:22" --serial-port 0 --qemu-monitor-port "$MON_PORT" \
		--console-log-file "$WORK/console-$k.log" --qemu-arch "$QARCH" $ACCEL

	# wait for sshd
	n=0; up=0
	while [ "$n" -lt 120 ]; do
		if ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
			-o ConnectTimeout=2 root@127.0.0.1 true 2>/dev/null; then up=1; break; fi
		n=$((n+1)); sleep 1
	done
	if [ "$up" = 0 ]; then echo "::error:: $k VM never came up"; cat "$WORK/console-$k.log" 2>/dev/null | tail -20; overall=1; stop_vm; continue; fi

	# run the gate in the VM; CSV lands in the host-mounted .kmatrix via /host
	if ssh -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@127.0.0.1 \
		"cd /host && OUT_CSV=/host/.kmatrix/$k.csv sh build/verify-kernel.sh"; then :; else overall=1; fi
	stop_vm
done
trap - EXIT INT TERM

# --- render a terminal matrix from the per-kernel CSVs ------------------------
echo
KERNELS="$KERNELS" python3 - "$OUTDIR" <<'PY' || echo "(install python3 for the summary table; per-kernel CSVs are in .kmatrix/)"
import csv, glob, os, sys
outdir = sys.argv[1]
kernels = os.environ["KERNELS"].split()
data, progs = {}, []
for k in kernels:
    f = os.path.join(outdir, f"{k}.csv")
    if not os.path.exists(f):
        data[k] = None; continue
    data[k] = {r["prog_name"]: r["verdict"] for r in csv.DictReader(open(f))}
    for p in data[k]:
        if p not in progs: progs.append(p)
short = lambda k: k.replace("-main", "")
if not progs:
    print("no results — check the per-kernel output above"); raise SystemExit(0)
w = max(len(p) for p in progs) + 2
cols = [short(k) for k in kernels]
print(" " * w + "  ".join(f"{c:>9}" for c in cols))
cell = {"success": "    ok   ", "failure": "   FAIL  "}
for p in progs:
    row = [p.ljust(w)]
    for k in kernels:
        d = data[k]
        row.append("    -    " if d is None or p not in d else cell.get(d[p], "    ?    "))
    print("  ".join(row))
PY

[ "$overall" = 0 ] && echo ">> matrix: all programs loaded on every kernel" || echo ">> matrix: at least one kernel rejected a program (or failed to boot)"
exit "$overall"
