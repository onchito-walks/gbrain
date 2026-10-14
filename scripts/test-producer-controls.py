#!/usr/bin/env python3
"""Real Linux producer completion/lease controls, using private disposable roots."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = Path(__file__).parent / 'lib/test-producer.py'
GUARD = Path('/srv/minio/hermes-native/.hermes/scripts/gbrain_heavy.py')


class ProducerControls(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='producer-controls-', dir=os.environ['TMPDIR']))
        self.parent = self.base / 'scratch'
        self.control = self.base / 'control'
        self.parent.mkdir()
        self.control.mkdir()

    def launch(self, code):
        process = subprocess.Popen([sys.executable, str(HELPER), '--parent', str(self.parent),
            '--control', str(self.control), '--label', self.id(), '--', sys.executable, '-c', code],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(100):
            records = list(self.control.glob('*.producer.json'))
            if records:
                data = json.loads(records[0].read_text())
                if data['state'] == 'running' or process.poll() is not None:
                    self.record = records[0]
                    self.process = process
                    return process
            time.sleep(.02)
        process.kill()
        self.fail('no running producer receipt')

    def data(self):
        return json.loads(self.record.read_text())

    def finish(self, expected=0):
        _, stderr = self.process.communicate(timeout=8)
        self.assertEqual(self.process.returncode, expected, stderr.decode())
        data = self.data()
        self.assertTrue(data['kernel_descendants_complete'])
        self.assertEqual(data['completion_proof'], 'waitpid:ECHILD')
        self.assertFalse(data['live_observed_descendants'])
        self.assertFalse(data['lease_held'])
        self.assertTrue(data['child_in_owner_group'])
        self.assertTrue(Path(data['root']).exists())  # unknown consumer scopes retained
        return data

    def exclusive(self):
        fd = os.open(self.data()['lease_path'], os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            return None
        return fd

    def test_success_kernel_completion(self):
        self.launch("import os,pathlib;pathlib.Path(os.environ['TMPDIR'],'owned').write_text('scratch')")
        self.finish()
        fd = self.exclusive()
        self.assertIsNotNone(fd)
        assert fd is not None
        os.close(fd)

    def test_child_failure(self):
        self.launch('raise SystemExit(7)')
        self.assertEqual(self.finish(7)['exit'], 7)

    def test_detached_descendant_holds_completion_and_lease(self):
        self.launch("import subprocess;subprocess.Popen(['sleep','1.2'],start_new_session=True)")
        time.sleep(.3)
        self.assertIsNone(self.process.poll())
        self.assertFalse(self.data()['kernel_descendants_complete'])
        self.assertIsNone(self.exclusive())
        self.assertGreaterEqual(len(self.finish()['reaped_children']), 2)

    def test_external_consumer_separate_shared_lease(self):
        self.launch('import time;time.sleep(.4)')
        fd = os.open(self.data()['lease_path'], os.O_RDWR)
        fcntl.flock(fd, fcntl.LOCK_SH)
        self.finish()
        self.assertIsNone(self.exclusive())
        os.close(fd)
        fd = self.exclusive()
        self.assertIsNotNone(fd)
        assert fd is not None
        os.close(fd)

    def test_term_waits_for_kernel_completion(self):
        self.launch("import subprocess,time;subprocess.Popen(['sleep','10'],start_new_session=True);time.sleep(10)")
        time.sleep(.15)
        self.process.terminate()
        self.assertEqual(self.finish(143)['state'], 'interrupted')

    def test_stopped_parent_retains_shared_lease(self):
        self.launch('import time;time.sleep(.4)')
        os.kill(self.process.pid, signal.SIGSTOP)
        try:
            time.sleep(.6)
            self.assertFalse(self.data()['kernel_descendants_complete'])
            self.assertIsNone(self.exclusive())
            self.assertTrue(Path(self.data()['root']).exists())
        finally:
            os.kill(self.process.pid, signal.SIGCONT)
        self.finish()

    def test_sigkill_never_creates_completion_marker(self):
        self.launch('import time;time.sleep(.4)')
        self.process.kill()
        self.process.communicate(timeout=3)
        time.sleep(.6)
        data = self.data()
        self.assertFalse(data['kernel_descendants_complete'])
        self.assertNotIn('completion_proof', data)
        self.assertEqual(data['state'], 'running')
        self.assertTrue(Path(data['root']).exists())
        # Even if the kernel lease releases, stale WIP is not cleanup authority.
        self.assertEqual(data['cleanup'], 'retained')

    def test_shared_cache_outside_root_untouched(self):
        cache = self.base / 'cache'
        cache.write_text('shared')
        self.launch(f"from pathlib import Path;assert Path({str(cache)!r}).read_text()=='shared'")
        self.finish()
        self.assertEqual(cache.read_text(), 'shared')

    def test_nested_control_refused(self):
        nested = self.parent / 'control'
        nested.mkdir()
        result = subprocess.run([sys.executable, str(HELPER), '--parent', str(self.parent),
            '--control', str(nested), '--label', 'negative', '--', 'true'], capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn(b'disjoint', result.stderr)
        self.assertFalse(list(nested.glob('*.producer.json')))

    def recover(self):
        manifest = self.base / 'manifest.json'
        return subprocess.run([sys.executable, str(HELPER), '--recover-record', str(self.record),
            '--cleanup-manifest', str(manifest),
            '--cleanup-guard', str(GUARD)], capture_output=True)

    def write_manifest(self, state, complete=True, sha=None):
        root = Path(self.data()['root'])
        entries = [{'path': root.name, 'kind': 'dir', 'owner_run_id': root.name, 'created': True,
                    'disposable': True, 'class': 'disposable', 'sole_copy': False,
                    'consumer_status': 'unused'}]
        for item in root.rglob('*'):
            entries.append(dict(entries[0], path=str(item.relative_to(root.parent)),
                                kind='dir' if item.is_dir() else 'file'))
        (self.base / 'manifest.json').write_text(json.dumps({'schema': 'gbrain_heavy.manifest.v1',
            'run_id': root.name, 'run_root': str(root.parent),
            'producer_record_sha256': sha or hashlib.sha256(self.record.read_bytes()).hexdigest(),
            'consumer_scope_complete': complete, 'entries': entries}))

    def test_recovery_requires_kernel_completion(self):
        self.launch('import time;time.sleep(.4)')
        self.process.kill(); self.process.communicate(timeout=3)
        time.sleep(.5)
        self.write_manifest('killed')
        result = self.recover()
        self.assertEqual(result.returncode, 12)
        self.assertEqual(json.loads(self.record.with_suffix('.recovery.json').read_text())['reason'],
                         'incomplete_kernel_completion')
        self.assertTrue(Path(self.data()['root']).exists())

    def test_recovery_requires_bound_complete_manifest(self):
        self.launch("import os,pathlib;pathlib.Path(os.environ['TMPDIR'],'wip').write_text('x')")
        self.finish()
        self.write_manifest('complete', complete=False)
        self.assertEqual(self.recover().returncode, 12)
        self.assertEqual(json.loads(self.record.with_suffix('.recovery.json').read_text())['reason'],
                         'unknown_external_consumers')
        self.write_manifest('complete', sha='0' * 64)
        self.assertEqual(self.recover().returncode, 12)
        self.assertEqual(json.loads(self.record.with_suffix('.recovery.json').read_text())['reason'],
                         'unbound_producer_manifest')
        self.write_manifest('complete')
        self.assertEqual(self.recover().returncode, 0)
        recovery = json.loads(self.record.with_suffix('.recovery.json').read_text())
        self.assertEqual(recovery['cleanup'], 'cleaned')
        self.assertFalse(Path(self.data()['root']).exists())
        self.assertTrue(self.record.exists())  # durable record survives the reclaim

    def test_unregistered_content_blocks_reclaim(self):
        self.launch("import os,pathlib;pathlib.Path(os.environ['TMPDIR'],'a').write_text('x')")
        self.finish()
        self.write_manifest('complete')  # registered first, then post-registration content
        Path(self.data()['root'], 'unregistered').write_text('late')
        self.assertEqual(self.recover().returncode, 12)
        self.assertEqual(json.loads(self.record.with_suffix('.recovery.json').read_text())['reason'],
                         'incomplete_registered_manifest')


if __name__ == '__main__':
    unittest.main(verbosity=2)
