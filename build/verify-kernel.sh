#!/bin/sh
# CI helper — runs INSIDE a per-kernel VM. Loads the built BPF object with the
# vendored static veristat and fails if the running kernel's verifier rejects
# any program. Driven by .github/workflows/kernel-matrix.yml, which boots each
# kernel with cilium's little-vm-helper and mounts the project at /host; the
# workflow stages the static veristat into bin/ before booting.
#
#   sh build/verify-kernel.sh [bpf-object]   (default: bin/probe.bpf.o)
#
# Set OUT_CSV=<path> to also write a machine-readable result (file,prog,verdict,
# insns,states) — the workflow points it at the mounted workspace so the runner
# can render a summary table from it after the VM exits.
#
# Why parse output instead of trusting the exit code: veristat returns 0 even
# when a program fails to load — a rejected program shows up as a VERDICT of
# "failure" in its table, not as a non-zero status. So the gate reads the verdict
# column. (veristat only exits non-zero on infra errors: missing file, OOM, etc.)

set -eu

OBJ="${1:-bin/probe.bpf.o}"
VERISTAT="${VERISTAT:-./bin/veristat}"
# verdict LAST so the gate below can match it at end-of-line. veristat's CSV
# header uses each stat's canonical name, so the columns come out as
# file_name,prog_name,total_insns,total_states,verdict.
COLS="file,prog,insns,states,verdict"

[ -x "$VERISTAT" ] || { echo "error: veristat not found/executable at $VERISTAT" >&2; exit 1; }
[ -f "$OBJ" ]      || { echo "error: BPF object not found at $OBJ" >&2; exit 1; }

KREL="$(uname -r)"
echo ">> kernel $KREL: loading $OBJ"

# Human-readable table for the console log (full default columns).
"$VERISTAT" "$OBJ" || true

# Machine-readable pass: the verdict column is the gate; the rest feeds the
# workflow's summary table.
csv="$("$VERISTAT" -o csv -e "$COLS" "$OBJ")"
if [ -n "${OUT_CSV:-}" ]; then
	mkdir -p "$(dirname "$OUT_CSV")"
	printf '%s\n' "$csv" > "$OUT_CSV"
fi

# Drop the header row; fail if any program's verdict is not "success".
if printf '%s\n' "$csv" | tail -n +2 | grep -q ',failure$'; then
	echo "::error::BPF verifier rejected a program on kernel $KREL" >&2
	exit 1
fi

echo ">> all programs loaded on kernel $KREL"
