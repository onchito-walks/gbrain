#!/usr/bin/env python3
"""Finite Linux subreaper with a registered shared consumer lease.

Children stay in the caller's process group. Kernel ECHILD establishes causal
descendant completion, not absence of unrelated external consumers. Unknown
handoffs and shared caches are retained; completion alone is not cleanup authority.
"""
import argparse
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time


def identity(pid):
    try:
        text = Path(f'/proc/{pid}/stat').read_text()
        fields = text[text.rindex(')') + 2:].split()
        return {'pid': pid, 'state': fields[0], 'ppid': int(fields[1]),
                'pgid': int(fields[2]), 'start_ticks': fields[19]}
    except (OSError, ValueError, IndexError):
        return None


def store(path, data):
    temp = path.with_suffix('.pending')
    with temp.open('w') as stream:
        json.dump(data, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def descendants(parent, seen):
    processes = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        item = identity(int(path.parent.name))
        if item:
            processes[item['pid']] = item
    parents = {parent}
    while True:
        found = {pid for pid, item in processes.items() if item['ppid'] in parents}
        new = found - parents
        if not new:
            break
        parents.update(new)
    for pid in parents - {parent}:
        item = processes.get(pid)
        if item:
            seen[(pid, item['start_ticks'])] = item


def recover_completed(record, manifest_path, guard_path):
    """Reuse the installed guard only for retired, closed, complete scopes.

    SIGKILL WIP is retained permanently until an independent closure proof exists;
    this function never reconstructs a missing kernel completion marker.
    """
    data = json.loads(record.read_text())
    result = {'cleanup': 'retained', 'record': str(record)}
    owner = data.get('owner') or {}
    current = identity(owner.get('pid', -1))
    if current and current['start_ticks'] == owner.get('start_ticks'):
        result['reason'] = 'producer_not_retired'
    elif not data.get('kernel_descendants_complete') or data.get('completion_proof') != 'waitpid:ECHILD':
        result['reason'] = 'incomplete_kernel_completion'
    else:
        root = Path(data['root'])
        control = Path(data['control'])
        manifest = json.loads(manifest_path.read_text())
        if (record.parent != control or root.name + '.producer.json' != record.name
                or root.resolve() != root or control.resolve() != control
                or control == root or root in control.parents or control in root.parents):
            result['reason'] = 'invalid_control_or_root'
        elif manifest.get('producer_record_sha256') != hashlib.sha256(record.read_bytes()).hexdigest():
            result['reason'] = 'unbound_producer_manifest'
        elif manifest.get('consumer_scope_complete') is not True:
            result['reason'] = 'unknown_external_consumers'
        elif data.get('lease_path') != str(control / 'leases' / (root.name + '.lock')):
            result['reason'] = 'invalid_registered_lease'
        elif manifest.get('run_root') != str(root.parent) or manifest.get('run_id') != root.name:
            result['reason'] = 'invalid_manifest_scope'
        elif any(not str(e.get('path', '')).startswith(root.name + '/')
                 and e.get('path') != root.name for e in manifest.get('entries', [])):
            result['reason'] = 'entry_outside_producer'
        else:
            registered = {e.get('path') for e in manifest.get('entries', [])}
            actual = {str(p.relative_to(root.parent)) for p in root.rglob('*')} | {root.name}
            if not actual.issubset(registered):
                result['reason'] = 'incomplete_registered_manifest'
            else:
                spec = importlib.util.spec_from_file_location('gbrain_heavy', guard_path)
                if spec is None or spec.loader is None:
                    raise RuntimeError(f'guard not importable: {guard_path}')
                guard = importlib.util.module_from_spec(spec)
                import sys
                sys.modules[spec.name] = guard
                spec.loader.exec_module(guard)
                cleanup = guard.checked_cleanup(str(control), str(root.parent), root.name,
                    str(manifest_path), unverifiable_policy=guard.PROC_SCOPED)
                result.update(cleanup='cleaned' if cleanup.ok else 'retained',
                              unverified_processes_recorded=cleanup.uncertain_processes,
                              guard=cleanup.to_dict())
    store(record.with_suffix('.recovery.json'), result)
    return 0 if result['cleanup'] == 'cleaned' else 12


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--parent')
    parser.add_argument('--control')
    parser.add_argument('--label')
    parser.add_argument('--recover-record')
    parser.add_argument('--cleanup-manifest')
    parser.add_argument('--cleanup-guard')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.recover_record:
        if not args.cleanup_manifest or not args.cleanup_guard:
            parser.error('recovery requires explicit manifest and existing guard')
        return recover_completed(Path(args.recover_record).resolve(strict=True),
            Path(args.cleanup_manifest).resolve(strict=True),
            Path(args.cleanup_guard).resolve(strict=True))
    if not args.parent or not args.control or not args.label:
        parser.error('producer requires parent, control and label')
    parent, control = Path(args.parent), Path(args.control)
    if not parent.is_absolute() or not control.is_absolute():
        parser.error('producer and control parents must be absolute')
    parent, control = parent.resolve(strict=True), control.resolve(strict=True)
    if parent == control or parent in control.parents or control in parent.parents:
        parser.error('producer and control parents must be disjoint')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('command required')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER failed')
    root = Path(tempfile.mkdtemp(prefix='p-', dir=parent))
    record = control / (root.name + '.producer.json')
    lease_dir = control / 'leases'
    lease_dir.mkdir(mode=0o700, exist_ok=True)
    lease_path = lease_dir / (root.name + '.lock')
    lease_fd = os.open(lease_path, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(lease_fd, fcntl.LOCK_SH)
    data = {'schema': 'gbrain.test-producer.v1', 'label': args.label,
            'root': str(root), 'control': str(control), 'owner': identity(os.getpid()),
            'allocated': time.time(), 'state': 'allocated', 'cleanup': 'retained',
            'retention_reason': 'external/unknown consumers not closed; strict cleanup required',
            'lease_path': str(lease_path), 'lease_held': True,
            'subreaper': True, 'kernel_descendants_complete': False,
            'descendant_observation_complete': False}
    store(record, data)  # Durable allocation BEFORE spawning; SIGKILL retains WIP.
    env = dict(os.environ, TMPDIR=str(root), TEST_PRODUCER_LEASE=str(lease_path),
               TEST_PRODUCER_LEASE_FD=str(lease_fd))
    process = None
    caught = []
    seen = {}
    free_start = os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize
    free_min = free_start

    def interrupt(signum, _frame):
        caught.append(signum)
        data['state'] = 'interrupted'
        data['signal'] = signum
        store(record, data)
        # Never create a new session/group that escapes the outer heavy guard.
        descendants(os.getpid(), seen)
        for (pid, start) in list(seen):
            current = identity(pid)
            if current and current['start_ticks'] == start:
                try:
                    os.kill(pid, signum)
                except ProcessLookupError:
                    pass

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    process = subprocess.Popen(command, env=env, pass_fds=(lease_fd,))
    data.update(state='running', child=identity(process.pid),
                child_in_owner_group=os.getpgid(process.pid) == os.getpgrp())
    store(record, data)
    reaped = []
    while True:
        # Root-child exit is insufficient: adopted setsid orphans are children.
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid:
            code = os.waitstatus_to_exitcode(status)
            reaped.append({'pid': pid, 'exit': code})
            if pid == process.pid:
                process.returncode = code
            continue
        descendants(os.getpid(), seen)
        free_min = min(free_min, os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize)
        time.sleep(0.1)
    if process.returncode is None:
        raise RuntimeError('ECHILD without primary-child status; retain WIP')
    data.update(state='interrupted' if caught else 'exited', exit=process.returncode,
                kernel_descendants_complete=True, completion_proof='waitpid:ECHILD',
                reaped_children=reaped, descendant_observation_complete=True,
                finished=time.time(), observed_descendants=list(seen.values()),
                disk_free_start_bytes=free_start, disk_free_min_bytes=free_min,
                disk_free_end_bytes=os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize,
                measured_filesystem_growth_bytes=free_start - free_min,
                live_observed_descendants=[item for (pid, start), item in seen.items()
                    if (current := identity(pid)) and current['start_ticks'] == start
                    and current['state'] != 'Z'])
    store(record, data)
    # Close, not LOCK_UN: inherited descriptors share the open description.
    os.close(lease_fd)
    data['lease_held'] = False
    store(record, data)
    return 128 + caught[-1] if caught else (process.returncode if process.returncode >= 0 else 128 - process.returncode)


if __name__ == '__main__':
    raise SystemExit(main())
