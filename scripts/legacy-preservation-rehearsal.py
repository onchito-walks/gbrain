#!/usr/bin/env python3
"""Private row-level preservation receipts for an explicitly named disposable copy.

No live connection, SQL repair, deletion, or container restart. Snapshot original
columns before a real migration, then compare their values row by row afterward.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

TABLES = ('pages', 'sources', 'links', 'takes', 'page_versions', 'raw_data', 'timeline_entries', 'tags', 'page_tags')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=('before', 'after'))
    p.add_argument('--container', required=True)
    p.add_argument('--out', required=True, type=Path)
    a = p.parse_args()
    if not a.container.startswith('stage5-preservation'):
        p.error('disposable stage5-preservation container required')
    os.umask(0o077)
    a.out.mkdir(parents=True, exist_ok=True)

    def query(sql):
        return subprocess.check_output(['docker', 'exec', a.container, 'psql', '-X', '-U', 'gbrain', '-d', 'gbrain', '-tA', '-c', sql], timeout=300).decode()

    manifest_path = a.out / 'columns.json'
    if a.mode == 'before':
        manifest = {}
        for table in TABLES:
            cols = query(f"SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}' ORDER BY ordinal_position").splitlines()
            if cols:
                manifest[table] = cols
        manifest_path.write_text(json.dumps(manifest, indent=2))
    else:
        manifest = json.loads(manifest_path.read_text())
    report = {}
    for table, columns in manifest.items():
        selected = ','.join('"' + col + '"' for col in columns)
        data = query(f'SELECT to_jsonb(t)::text FROM (SELECT {selected} FROM "{table}") t')
        path = a.out / f'{a.mode}-{table}.private.jsonl'
        path.write_text(data)
        lines = [json.loads(line) for line in data.split('\n') if line]
        report[table] = {'rows': len(lines), 'sha256': hashlib.sha256(data.encode()).hexdigest()}
        if a.mode == 'after':
            original = [json.loads(line) for line in (a.out / f'before-{table}.private.jsonl').read_text().split('\n') if line]
            # Full row equality as a multiset, not counts. Preserve duplicates.
            from collections import Counter
            canonical = lambda row: json.dumps(row, sort_keys=True, separators=(',', ':'))
            missing = Counter(map(canonical, original)) - Counter(map(canonical, lines))
            report[table]['original_rows_exactly_preserved'] = not missing
            report[table]['changed_or_missing_original_rows'] = sum(missing.values())
            if missing:
                (a.out / f'changed-{table}.private.jsonl').write_text('\n'.join(missing) + '\n')
    (a.out / f'{a.mode}-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
