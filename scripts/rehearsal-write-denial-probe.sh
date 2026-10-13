#!/usr/bin/env bash
# Bounded, fail-closed OS write-denial probe for a disposable migration rehearsal.
#
# Proves, with a real transient systemd sandbox (mount namespace; the host is
# never mutated), that:
#   1. every live brain root is INACCESSIBLE to the rehearsal user inside the unit;
#   2. a deliberate write to a live vault path inside that unit is DENIED;
#   3. a write to a decoy root under the same sandbox is DENIED (and the decoy
#      is byte-identical afterwards);
#   4. a write inside the disposable root SUCCEEDS;
#   5. a negative control with NO sandbox properties can reach the decoy, so
#      steps 1 and 3 are not vacuous passes.
#
# Safety: this never creates, modifies or deletes anything inside a live root.
# The write attempt in step 2 runs only AFTER step 1 proved, in the same
# property configuration, that the path cannot be read by the rehearsal user;
# if that proof is missing the driver does not run the attempt at all, and a
# host-side check afterwards fails loudly if anything appeared.
#
# The unit runs as the *rehearsal user* (`--user-name`, default: the invoking
# user), never as root: root carries CAP_DAC_OVERRIDE and would walk straight
# through an InaccessiblePaths mode-0000 mount, proving nothing.
#
# Usage:
#   rehearsal-write-denial-probe.sh --live-root <dir> [--live-root <dir>]... \
#       --decoy <dir> --disposable <dir> --out <receipt.json> \
#       [--user-name <login>] [--preserve <file>]...
#
# Exit: 0 all steps verified, 1 probe ran and failed verification,
#       3 unverified (no systemd-run / no privilege) — never 0 in that case.
set -uo pipefail

LIVE_ROOTS=()
PRESERVE=()
DECOY=""
DISPOSABLE=""
OUT=""
USER_NAME="$(id -un)"
while [ $# -gt 0 ]; do
  case "$1" in
    --live-root) LIVE_ROOTS+=("$2"); shift 2 ;;
    --preserve) PRESERVE+=("$2"); shift 2 ;;
    --decoy) DECOY="$2"; shift 2 ;;
    --disposable) DISPOSABLE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --user-name) USER_NAME="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ "${#LIVE_ROOTS[@]}" -eq 0 ] || [ -z "$DECOY" ] || [ -z "$DISPOSABLE" ] || [ -z "$OUT" ]; then
  echo "usage: $0 --live-root <dir> [--live-root <dir>]... --decoy <dir> --disposable <dir> --out <receipt.json> [--user-name <login>] [--preserve <file>]..." >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/isolation-probe.XXXXXXXX")"
RECEIPT_STEPS="$WORK/steps.jsonl"
: > "$RECEIPT_STEPS"
mkdir -p "$DISPOSABLE" "$DECOY"

# unverified when the host cannot run a transient sandbox unit at all.
RUNNER=()
if sudo -n systemd-run --version >/dev/null 2>&1; then
  RUNNER=(sudo -n systemd-run)
elif systemd-run --version >/dev/null 2>&1; then
  RUNNER=(systemd-run --user)
fi
if [ "${#RUNNER[@]}" -eq 0 ]; then
  printf '{"probe":"rehearsal-write-denial-probe","verdict":"unverified","verified":false,"reason":"no usable systemd-run (or privilege) on this host","evidence":{}}\n' > "$OUT"
  cat "$OUT"
  exit 3
fi

cat > "$WORK/probe.py" <<'PY'
"""Read or write one path and report the outcome as a single token.

Runs unprivileged inside the sandbox unit, so a mode-0000 InaccessiblePaths
mount denies read and write for real (no CAP_DAC_OVERRIDE to bypass it).
"""
import os, sys
mode, path = sys.argv[1], sys.argv[2]
DENY_ERRNOS = {1, 13, 30}  # EPERM, EACCES, EROFS


def probe_read():
    try:
        if os.path.isdir(path):
            with os.scandir(path) as it:
                next(it, None)
            return 'ACCESSIBLE'
        with open(path, 'rb') as fh:
            fh.read(1)
        return 'ACCESSIBLE'
    except PermissionError:
        return 'INACCESSIBLE'
    except FileNotFoundError:
        return 'ABSENT'
    except OSError as e:
        return 'INACCESSIBLE' if e.errno in DENY_ERRNOS else 'ERROR:%s' % e.errno


def probe_write():
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, b'isolation-probe\n')
        os.close(fd)
        return 'WRITTEN'
    except PermissionError:
        return 'DENIED'
    except FileNotFoundError:
        return 'DENIED'
    except OSError as e:
        return 'DENIED' if e.errno in DENY_ERRNOS else 'ERROR:%s' % e.errno


print(probe_read() if mode == 'stat' else probe_write())
PY

# One transient unit per step. `--pipe` streams stdout/stderr back; `--wait`
# blocks; `--collect` reaps. RuntimeMaxSec bounds a hung probe.
PROBE_TIMEOUT=60
STEP_OUT=""
STEP_RC=0
run_unit() { # run_unit <name> <properties...> -- <argv...>
  local name="$1"; shift
  local props=()
  while [ "$1" != "--" ]; do props+=("$1"); shift; done
  shift
  local props_json args_json
  args_json=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")
  props_json=$(printf '%s\n' "${props[@]}" | python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
  STEP_OUT=$(timeout "$PROBE_TIMEOUT" "${RUNNER[@]}" --quiet --wait --pipe --collect \
    -p RuntimeMaxSec=30 -p "User=$USER_NAME" "${props[@]}" "$@" 2>"$WORK/$name.err")
  STEP_RC=$?
  python3 - "$name" "$STEP_RC" "$STEP_OUT" "$(cat "$WORK/$name.err")" "$props_json" "$args_json" >> "$RECEIPT_STEPS" <<'PY'
import json, sys
name, rc, stdout, stderr, props, args = sys.argv[1:7]
print(json.dumps({"name": name, "rc": int(rc), "stdout": stdout.strip(), "stderr": stderr.strip()[:400],
                  "properties": json.loads(props), "argv": json.loads(args)}))
PY
}

sandbox_props() { # ProtectSystem=strict, only the disposable copy writable, live roots inaccessible
  local denied=""
  for root in "${LIVE_ROOTS[@]}"; do denied+="${root} "; done
  printf '%s\n' -p ProtectSystem=strict -p ProtectHome=read-only -p NoNewPrivileges=yes \
    -p "ReadWritePaths=$DISPOSABLE" -p "InaccessiblePaths=${denied% }"
}

mapfile -t LIVE_P < <(sandbox_props)
verdict=0
inaccessible_all=1

# ── 1. every live root is inaccessible inside the sandbox ────────────────
for root in "${LIVE_ROOTS[@]}"; do
  [ -e "$root" ] || { echo "live root does not exist: $root" >&2; verdict=1; inaccessible_all=0; continue; }
  run_unit "live_inaccessible_$(printf '%s' "$root" | tr -c 'A-Za-z0-9' '_')" "${LIVE_P[@]}" \
    -- python3 "$WORK/probe.py" stat "$root"
  if [ "$STEP_OUT" != "INACCESSIBLE" ]; then
    echo "EXPECTED INACCESSIBLE for $root, got '${STEP_OUT}' (rc=$STEP_RC)" >&2
    inaccessible_all=0; verdict=1
  fi
done
# A path the rehearsal owns stays reachable: proves the unit is not broken
# wholesale. (Never the live tree's own parent — that parent may be
# owner-private for reasons unrelated to this sandbox.)
run_unit rehearsal_owned_path_reachable -p ProtectSystem=strict -p ReadWritePaths="$DISPOSABLE" \
  -- python3 "$WORK/probe.py" stat "$(dirname "$DISPOSABLE")"
[ "$STEP_OUT" = "ACCESSIBLE" ] || { echo "sandbox sanity failed: $(dirname "$DISPOSABLE") -> '${STEP_OUT}'" >&2; verdict=1; }

# ── 2. a deliberate write to a live vault path is denied ────────────────
live_write_denied="skipped"
if [ "$inaccessible_all" -eq 1 ]; then
  live_target="${LIVE_ROOTS[0]}/.tmp-isolation-probe-$$"
  run_unit live_write_denied "${LIVE_P[@]}" -- python3 "$WORK/probe.py" write "$live_target"
  live_write_denied="$STEP_OUT"
  case "$STEP_OUT" in
    DENIED) : ;;
    *) echo "EXPECTED DENIED writing $live_target, got '${STEP_OUT}' (rc=$STEP_RC)" >&2; verdict=1 ;;
  esac
  if [ -e "$live_target" ]; then
    echo "FAIL-CLOSED VIOLATION: probe created $live_target inside a live root" >&2; verdict=1
  fi
else
  echo "skipped live write attempt: inaccessibility was not proven" >&2
  verdict=1
fi

# ── 3. decoy root: writes denied by the sandbox, decoy unchanged ─────────
decoy_before=$(cd "$DECOY" && find . -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum)
run_unit decoy_write_denied "${LIVE_P[@]}" -- python3 "$WORK/probe.py" write "$DECOY/probe.tmp"
decoy_out="$STEP_OUT"
decoy_after=$(cd "$DECOY" && find . -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum)
[ "$decoy_out" = "DENIED" ] || { echo "EXPECTED DENIED writing decoy, got '${decoy_out}'" >&2; verdict=1; }
[ "$decoy_before" = "$decoy_after" ] || { echo "decoy contents changed during the probe" >&2; verdict=1; }

# ProtectSystem=strict alone must also deny a write outside ReadWritePaths.
run_unit decoy_write_ro -p ProtectSystem=strict -p ProtectHome=read-only -p "ReadWritePaths=$DISPOSABLE" \
  -- python3 "$WORK/probe.py" write "$DECOY/probe-ro.tmp"
decoy_ro_out="$STEP_OUT"
[ "$decoy_ro_out" = "DENIED" ] || { echo "EXPECTED DENIED (read-only fs) writing decoy, got '${decoy_ro_out}'" >&2; verdict=1; }

# ── 4. disposable root: the same sandbox must ALLOW the write ────────────
disposable_target="$DISPOSABLE/probe.tmp"
rm -f "$disposable_target"
run_unit disposable_write_allowed "${LIVE_P[@]}" -- python3 "$WORK/probe.py" write "$disposable_target"
disposable_out="$STEP_OUT"
[ "$disposable_out" = "WRITTEN" ] || { echo "EXPECTED WRITTEN in disposable root, got '${disposable_out}'" >&2; verdict=1; }
[ -f "$disposable_target" ] || { echo "disposable write reported WRITTEN but no file exists" >&2; verdict=1; }
rm -f "$disposable_target"

# ── 5. negative control: without sandbox properties the decoy is reachable ─
run_unit control_decoy_reachable -- python3 "$WORK/probe.py" stat "$DECOY"
control_out="$STEP_OUT"
[ "$control_out" = "ACCESSIBLE" ] || { echo "control failed: unsandboxed stat of decoy -> '${control_out}' (probe cannot detect reachability)" >&2; verdict=1; }

# ── 6. preservation manifest of the caller-named live files ──────────────
preserve_json='{}'
if [ "${#PRESERVE[@]}" -gt 0 ]; then
  preserve_json=$(python3 - "${PRESERVE[@]}" <<'PY'
import hashlib, json, os, sys
out = {}
for path in sys.argv[1:]:
    if not os.path.exists(path):
        out[path] = {'present': False}
        continue
    data = open(path, 'rb').read()
    out[path] = {'present': True, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}
print(json.dumps(out))
PY
)
fi

python3 - "$OUT" "$verdict" "$inaccessible_all" "$decoy_out" "$decoy_ro_out" "$disposable_out" \
  "$control_out" "$live_write_denied" "$RECEIPT_STEPS" "$preserve_json" "$USER_NAME" <<'PY'
import json, sys
(out_path, verdict, inaccessible, decoy_out, decoy_ro_out, disposable_out, control_out,
 live_write_denied, steps_path, preserve, user_name) = sys.argv[1:12]
steps = [json.loads(l) for l in open(steps_path) if l.strip()]
receipt = {
    'probe': 'rehearsal-write-denial-probe',
    'rehearsal_user': user_name,
    'verified': int(verdict) == 0,
    'live_root_inaccessible_inside_unit': bool(int(inaccessible)),
    'write_denied_on_live_root': live_write_denied == 'DENIED',
    'write_denied_on_decoy_paths': [decoy_out, decoy_ro_out],
    'write_allowed_on_disposable': disposable_out == 'WRITTEN',
    'control_decoy_reachable': control_out == 'ACCESSIBLE',
    'preserved_files': json.loads(preserve),
    'steps': steps,
}
receipt['evidence'] = {
    'liveRootInaccessibleInsideUnit': receipt['live_root_inaccessible_inside_unit'],
    'writeDeniedOnLiveRoot': receipt['write_denied_on_live_root'],
    'writeAllowedOnDisposable': receipt['write_allowed_on_disposable'],
    'probePath': out_path,
}
receipt['verdict'] = 'isolated' if receipt['verified'] else 'failed'
open(out_path, 'w').write(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({k: receipt[k] for k in ('probe', 'rehearsal_user', 'verified', 'verdict',
                                          'live_root_inaccessible_inside_unit', 'write_denied_on_live_root',
                                          'write_allowed_on_disposable', 'control_decoy_reachable')}, indent=2))
PY
rc=$?
[ $rc -eq 0 ] || verdict=1
rm -rf "$WORK"
exit "$verdict"
