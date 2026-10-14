#!/usr/bin/env python3
"""Explicit test-producer provenance. No reclamation without a consumer lease.

Children stay in the caller's process group: the outer heavy guard continues to
own interruption. Observed descendants are evidence, NOT an exhaustive no-child
proof. Even after a clean exit all bytes are retained; shared caches and detached
or unobservable children cannot be proved relinquished by polling /proc.
"""
import argparse
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--parent', required=True)
    parser.add_argument('--control', required=True)
    parser.add_argument('--label', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    parent, control = Path(args.parent), Path(args.control)
    if not parent.is_absolute() or not control.is_absolute():
        parser.error('producer and control parents must be absolute')
    parent, control = parent.resolve(strict=True), control.resolve(strict=True)
    if parent == control or parent in control.parents or control in parent.parents:
        parser.error('producer and control parents must be disjoint')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('command required')
    root = Path(tempfile.mkdtemp(prefix='p-', dir=parent))
    record = control / (root.name + '.producer.json')
    data = {'schema': 'gbrain.test-producer.v1', 'label': args.label,
            'root': str(root), 'control': str(control), 'owner': identity(os.getpid()),
            'allocated': time.time(), 'state': 'allocated', 'cleanup': 'retained',
            'retention_reason': 'no exclusive consumer lease; shared/unknown paths retained',
            'descendant_observation_complete': False}
    store(record, data)  # Durable allocation BEFORE spawning; SIGKILL retains WIP.
    env = dict(os.environ, TMPDIR=str(root))
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
        if process is not None and process.poll() is None:
            process.send_signal(signum)

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    process = subprocess.Popen(command, env=env)
    data.update(state='running', child=identity(process.pid),
                child_in_owner_group=os.getpgid(process.pid) == os.getpgrp())
    store(record, data)
    while process.poll() is None:
        descendants(process.pid, seen)
        free_min = min(free_min, os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize)
        time.sleep(0.1)
    descendants(process.pid, seen)
    data.update(state='interrupted' if caught else 'exited', exit=process.returncode,
                finished=time.time(), observed_descendants=list(seen.values()),
                disk_free_start_bytes=free_start, disk_free_min_bytes=free_min,
                disk_free_end_bytes=os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize,
                measured_filesystem_growth_bytes=free_start - free_min,
                live_observed_descendants=[item for (pid, start), item in seen.items()
                    if (current := identity(pid)) and current['start_ticks'] == start
                    and current['state'] != 'Z'])
    store(record, data)
    return 128 + caught[-1] if caught else (process.returncode if process.returncode >= 0 else 128 - process.returncode)


if __name__ == '__main__':
    raise SystemExit(main())
