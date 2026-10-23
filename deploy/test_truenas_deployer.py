import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# The script's name has a hyphen, so it can't be imported by name.
spec = importlib.util.spec_from_file_location(
    'truenas_deployer', Path(__file__).with_name('truenas-deployer.py'))
deployer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployer)

REPO = 'ghcr.io/raold/keyart'
OLD_SHA = '1111111' + 'a' * 33
NEW_SHA = '2222222' + 'b' * 33


def make_args(state_dir, *extra):
    return deployer.parse_args(['--app', 'keyart', '--repo', 'raold/keyart', '--image', REPO,
                                '--state-dir', state_dir, *extra])


def run_once(args, api, report=None):
    """One deployer pass whose health probe always answers `report`, on a fake clock."""
    clock = FakeClock()
    return deployer.run(args, api, lambda _port: report, clock.sleep, clock)


def run_main(argv, api):
    """Runs main with `api` and returns (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, 'stdout', out), mock.patch.object(sys, 'stderr', err), \
            mock.patch.object(deployer, 'TrueNASApi', return_value=api):
        try:
            code = deployer.main(argv)
        finally:
            for handler in list(deployer.log.handlers):
                deployer.log.removeHandler(handler)
                handler.close()
    return code, out.getvalue(), err.getvalue()


class FakeClock:
    """A monotonic clock that moves only when the code sleeps or a probe takes time."""

    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class FakeApi:
    def __init__(self, repository, tag, fail_update=False, fail_restore=False, fail_snapshot=None,
                 fail_port=None, state='RUNNING'):
        self.repository = repository
        self.tag = tag
        self.state = state
        self.original = (repository, tag)
        self.fail_update = fail_update
        self.fail_restore = fail_restore
        self.fail_snapshot = fail_snapshot
        self.fail_port = fail_port
        self.calls = []
        self.snapshot_names = []

    def get_state(self, app):
        return self.state

    def get_image_repository(self, app):
        return self.repository

    def get_image_tag(self, app):
        return self.tag

    def get_port(self, app):
        if self.fail_port:
            raise self.fail_port
        return 30000

    def set_image(self, app, repository, tag):
        self.calls.append(('set_image', app, repository, tag))
        if self.fail_update:
            self.fail_update = False
            raise RuntimeError('image pull failed')
        if self.fail_restore and (repository, tag) == self.original:
            raise RuntimeError('middleware error')
        self.repository, self.tag = repository, tag

    def snapshot(self, app, name):
        if self.fail_snapshot:
            raise self.fail_snapshot
        self.calls.append(('snapshot', app, name))
        self.snapshot_names.append(f'tank/ix-apps/app_mounts/{app}@{name}')

    def snapshots(self, app):
        return list(self.snapshot_names)

    def destroy_snapshot(self, name):
        self.calls.append(('destroy_snapshot', name))
        self.snapshot_names.remove(name)


class DecideTest(unittest.TestCase):
    def test_decide_waits_without_image(self):
        self.assertEqual(deployer.decide('sha-1111111', None), 'wait')

    def test_decide_current(self):
        self.assertEqual(deployer.decide('sha-2222222', 'sha-2222222'), 'current')

    def test_decide_deploy(self):
        self.assertEqual(deployer.decide('sha-1111111', 'sha-2222222'), 'deploy')


class HealthTest(unittest.TestCase):
    def test_health_requires_matching_commit(self):
        self.assertFalse(deployer.health_ok({'ok': True, 'commit': OLD_SHA}, NEW_SHA))
        self.assertTrue(deployer.health_ok({'ok': True, 'commit': NEW_SHA}, NEW_SHA))
        self.assertTrue(deployer.health_ok({'ok': True, 'commit': NEW_SHA}, '2222222'))
        self.assertFalse(deployer.health_ok({'ok': False, 'commit': NEW_SHA}, NEW_SHA))
        self.assertFalse(deployer.health_ok(None, NEW_SHA))


class PruneTest(unittest.TestCase):
    def test_prune_keeps_newest(self):
        ours = [f'tank/ix-apps/app_mounts/keyart@keyart-deploy-202610{day:02d}-120000'
                for day in range(1, 13)]
        foreign = ['tank/ix-apps/app_mounts/keyart@auto-2026-10-01_00-00',
                   'tank/ix-apps/app_mounts/keyart@manual-before-upgrade']
        names = foreign[:1] + ours[:5] + foreign[1:] + ours[5:]
        self.assertEqual(deployer.snapshots_to_prune(names, 'keyart-deploy-', 10), ours[:2])
        self.assertEqual(deployer.snapshots_to_prune(names, 'keyart-deploy-', 12), [])


class DeployTest(unittest.TestCase):
    def test_deploy_success(self):
        api = FakeApi(REPO, 'sha-1111111')
        reports = iter([None, {'ok': True, 'commit': NEW_SHA}])
        clock = FakeClock()
        result = deployer.deploy(api, 'keyart', 'sha-2222222', lambda: next(reports), clock.sleep, clock=clock)
        self.assertEqual(result, 'deployed')
        self.assertEqual([call[0] for call in api.calls], ['snapshot', 'set_image'])
        self.assertTrue(api.calls[0][2].startswith('keyart-deploy-'))
        self.assertEqual(api.calls[1], ('set_image', 'keyart', REPO, 'sha-2222222'))
        self.assertEqual(clock.sleeps, [deployer.POLL_INTERVAL_S])

    def test_deploy_rolls_back(self):
        # Starts, but keeps reporting the commit it replaced.
        api = FakeApi('keyart', '1.0.2')
        clock = FakeClock()
        with self.assertLogs(deployer.log, 'WARNING'):
            result = deployer.deploy(api, 'keyart', 'sha-2222222',
                                     lambda: {'ok': True, 'commit': OLD_SHA}, clock.sleep,
                                     timeout_s=30, repository=REPO, clock=clock)
        self.assertEqual(result, 'rolled-back')
        self.assertEqual(api.calls[1], ('set_image', 'keyart', REPO, 'sha-2222222'))
        self.assertEqual(api.calls[-1], ('set_image', 'keyart', 'keyart', '1.0.2'))
        self.assertGreaterEqual(sum(clock.sleeps), 30)

    def test_health_wait_uses_a_deadline(self):
        # Each probe hangs for 5 s (its own timeout), so counting sleeps alone would wait about twice as long.
        api = FakeApi(REPO, 'sha-1111111')
        clock = FakeClock()
        start = clock.now
        probes = []

        def slow_probe():
            probes.append(clock.now - start)
            clock.now += 5
            return None

        with self.assertLogs(deployer.log, 'WARNING'):
            result = deployer.deploy(api, 'keyart', 'sha-2222222', slow_probe, clock.sleep,
                                     timeout_s=30, clock=clock)
        self.assertEqual(result, 'rolled-back')
        self.assertEqual(probes, [0, 10, 20, 30])
        self.assertLessEqual(clock.now - start, 30 + 5)

    def test_deploy_rolls_back_when_update_fails(self):
        api = FakeApi(REPO, 'sha-1111111', fail_update=True)
        clock = FakeClock()
        with self.assertLogs(deployer.log, 'WARNING'):
            result = deployer.deploy(api, 'keyart', 'sha-2222222', lambda: None, clock.sleep, clock=clock)
        self.assertEqual(result, 'rolled-back')
        self.assertEqual(api.calls[-1], ('set_image', 'keyart', REPO, 'sha-1111111'))
        self.assertEqual(clock.sleeps, [])


class RunTest(unittest.TestCase):
    def test_waits_when_app_not_running(self):
        for state in ('STOPPED', 'DEPLOYING'):
            api = FakeApi(REPO, 'sha-1111111', state=state)
            with tempfile.TemporaryDirectory() as tmp, \
                    mock.patch.object(deployer, 'newest_main_commit', return_value=NEW_SHA) as newest, \
                    mock.patch.object(deployer, 'image_exists', return_value=True), \
                    self.assertLogs(deployer.log, 'INFO') as logs:
                self.assertEqual(run_once(make_args(tmp, '--go'), api), 0)
                self.assertEqual(os.listdir(tmp), [])
            self.assertEqual(api.calls, [])
            newest.assert_not_called()
            self.assertEqual(logs.output, [f'INFO:truenas-deployer:keyart: wait: app is {state}'])

    def test_stuck_app_not_running_is_reported_not_touched(self):
        # The app is on a recorded failed image whose rollback failed, and it is not running.
        api = FakeApi(REPO, 'sha-2222222', state='CRASHED')
        with tempfile.TemporaryDirectory() as tmp, self.assertLogs(deployer.log, 'INFO') as logs:
            with open(os.path.join(tmp, 'keyart.failed'), 'w') as handle:
                json.dump({'image': REPO, 'tag': 'sha-2222222',
                           'previous_repository': REPO, 'previous_tag': 'sha-1111111'}, handle)
            self.assertEqual(run_once(make_args(tmp, '--go'), api), 1)
        self.assertEqual(api.calls, [])
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(logs.records[0].levelname, 'ERROR')
        self.assertIn('wait: app is CRASHED', logs.output[0])

    def patched_lookups(self):
        return (mock.patch.object(deployer, 'newest_main_commit', return_value=NEW_SHA),
                mock.patch.object(deployer, 'image_exists', return_value=True))

    def test_deployed_clears_record(self):
        api = FakeApi(REPO, 'sha-1111111')
        healthy = {'ok': True, 'commit': NEW_SHA}
        newest, exists = self.patched_lookups()
        with tempfile.TemporaryDirectory() as tmp, newest, exists, self.assertLogs(deployer.log, 'INFO'):
            record = os.path.join(tmp, 'keyart.failed')
            with open(record, 'w') as handle:
                json.dump({'image': REPO, 'tag': 'sha-0000000',
                           'previous_repository': REPO, 'previous_tag': 'sha-1111111'}, handle)
            self.assertEqual(run_once(make_args(tmp, '--go'), api, healthy), 0)
            self.assertEqual(api.tag, 'sha-2222222')
            self.assertFalse(os.path.exists(record))

    def test_record_is_written_before_the_switch(self):
        api = FakeApi(REPO, 'sha-1111111')
        seen = []
        set_image = api.set_image
        newest, exists = self.patched_lookups()
        with tempfile.TemporaryDirectory() as tmp, newest, exists, self.assertLogs(deployer.log, 'INFO'):
            def recording_set_image(app, repository, tag):
                with open(os.path.join(tmp, 'keyart.failed')) as handle:
                    seen.append(json.load(handle))
                set_image(app, repository, tag)

            api.set_image = recording_set_image
            healthy = {'ok': True, 'commit': NEW_SHA}
            self.assertEqual(run_once(make_args(tmp, '--go'), api, healthy), 0)
        self.assertEqual(seen,[{'image': REPO, 'tag': 'sha-2222222',
                                 'previous_repository': REPO, 'previous_tag': 'sha-1111111'}])

    def test_error_before_switch_writes_no_record(self):
        failure = subprocess.CalledProcessError(1, ['zfs', 'snapshot'], stderr='dataset is busy')
        api = FakeApi(REPO, 'sha-1111111', fail_snapshot=failure)
        healthy = {'ok': True, 'commit': NEW_SHA}
        newest, exists = self.patched_lookups()
        with tempfile.TemporaryDirectory() as tmp, newest, exists, self.assertLogs(deployer.log, 'INFO'):
            args = make_args(tmp, '--go')
            with self.assertRaises(subprocess.CalledProcessError):
                run_once(args, api, healthy)
            self.assertEqual(os.listdir(tmp), [])
            self.assertEqual(api.calls, [])

            # The commit is not poisoned: once zfs works, the next run deploys it.
            api.fail_snapshot = None
            self.assertEqual(run_once(args, api, healthy), 0)
            self.assertEqual(api.tag, 'sha-2222222')

    def test_timeout_option_bounds_the_health_wait(self):
        self.assertEqual(make_args('/state').timeout, 180)
        api = FakeApi(REPO, 'sha-1111111')
        clock = FakeClock()
        newest, exists = self.patched_lookups()
        with tempfile.TemporaryDirectory() as tmp, newest, exists, self.assertLogs(deployer.log, 'INFO'):
            args = make_args(tmp, '--go', '--timeout', '20')
            self.assertEqual(deployer.run(args, api, lambda _port: None, clock.sleep, clock), 1)
        self.assertEqual(sum(clock.sleeps), 20)
        self.assertEqual(api.tag, 'sha-1111111')

    def test_rolled_back_tag_is_not_retried(self):
        api = FakeApi(REPO, 'sha-1111111')
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(deployer, 'newest_main_commit', return_value=NEW_SHA), \
                mock.patch.object(deployer, 'image_exists', return_value=True), \
                self.assertLogs(deployer.log, 'INFO'):
            args = make_args(tmp, '--go')
            self.assertEqual(run_once(args, api), 1)
            updates = [call for call in api.calls if call[0] == 'set_image']
            self.assertEqual(api.tag, 'sha-1111111')
            self.assertEqual(run_once(args, api), 0)
            self.assertEqual([call for call in api.calls if call[0] == 'set_image'], updates)

    def test_failed_rollback_is_recorded_and_retried(self):
        # The new image never reports healthy and putting the old one back fails.
        api = FakeApi(REPO, 'sha-1111111', fail_restore=True)
        api.snapshot_names = [f'tank/ix-apps/app_mounts/keyart@keyart-deploy-202610{day:02d}-120000'
                              for day in range(1, 11)]
        state_dir = tempfile.TemporaryDirectory()
        self.addCleanup(state_dir.cleanup)
        tmp = state_dir.name
        args = make_args(tmp, '--go')

        def run():
            return run_once(args, api)

        def snapshots_taken():
            return len([call for call in api.calls if call[0] == 'snapshot'])

        with mock.patch.object(deployer, 'newest_main_commit', return_value=NEW_SHA), \
                mock.patch.object(deployer, 'image_exists', return_value=True), \
                self.assertLogs(deployer.log, 'INFO') as logs:
            with self.assertRaises(deployer.RollbackFailed):
                run()
            self.assertEqual(api.tag, 'sha-2222222')
            self.assertTrue(os.path.exists(os.path.join(tmp, 'keyart.failed')))
            self.assertEqual(len(api.snapshot_names), 10)
            self.assertNotIn('tank/ix-apps/app_mounts/keyart@keyart-deploy-20261001-120000', api.snapshot_names)

            # Still failing: the next run retries the rollback, takes no snapshot and is not "current".
            with self.assertRaises(deployer.RollbackFailed):
                run()
            self.assertEqual(snapshots_taken(), 1)
            self.assertFalse(any(': current,' in line for line in logs.output))

            # Middleware recovered: the rollback goes through, then the tag is skipped.
            api.fail_restore = False
            self.assertEqual(run(), 1)
            self.assertEqual((api.repository, api.tag), (REPO, 'sha-1111111'))
            self.assertEqual(run(), 0)
            self.assertEqual(snapshots_taken(), 1)
            self.assertEqual(api.tag, 'sha-1111111')


class LockTest(unittest.TestCase):
    def test_lock_is_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'deployer.lock')
            self.assertTrue(deployer.acquire_lock(path))
            self.assertFalse(deployer.acquire_lock(path))


class PrivateDirTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name

    def test_creates_missing_dir_0700(self):
        path = os.path.join(self.tmp, 'state')
        deployer.private_dir(path, create=True)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o700)

    def test_dry_run_creates_nothing(self):
        path = os.path.join(self.tmp, 'state')
        deployer.private_dir(path, create=False)
        self.assertFalse(os.path.exists(path))

    def test_accepts_own_dir_others_cannot_write(self):
        os.chmod(self.tmp, 0o755)
        deployer.private_dir(self.tmp, create=True)

    def test_refuses_writable_by_others(self):
        os.chmod(self.tmp, 0o777)
        with self.assertRaisesRegex(deployer.UnsafeDir, 'writable by group or others'):
            deployer.private_dir(self.tmp, create=True)
        os.chmod(self.tmp, 0o770)
        with self.assertRaises(deployer.UnsafeDir):
            deployer.private_dir(self.tmp, create=False)

    def test_refuses_other_owner(self):
        os.chmod(self.tmp, 0o700)
        with mock.patch.object(deployer.os, 'getuid', return_value=os.stat(self.tmp).st_uid + 1), \
                self.assertRaisesRegex(deployer.UnsafeDir, 'owned by uid'):
            deployer.private_dir(self.tmp, create=True)

    def test_refuses_symlink(self):
        os.chmod(self.tmp, 0o700)
        link = os.path.join(self.tmp, 'link')
        os.symlink(self.tmp, link)
        with self.assertRaisesRegex(deployer.UnsafeDir, 'not a directory'):
            deployer.private_dir(link, create=True)


class LoggingTest(unittest.TestCase):
    def test_warnings_and_errors_go_to_stderr(self):
        out, err = io.StringIO(), io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, 'deployer.log')
            with mock.patch.object(sys, 'stdout', out), mock.patch.object(sys, 'stderr', err):
                deployer.setup_logging(path)
                try:
                    deployer.log.info('decision line')
                    deployer.log.warning('warning line')
                    try:
                        raise KeyError('boom')
                    except KeyError:
                        deployer.log.exception('error line')
                finally:
                    for handler in list(deployer.log.handlers):
                        deployer.log.removeHandler(handler)
                        handler.close()
            with open(path, encoding='utf-8') as handle:
                logged = handle.read()
        self.assertIn('decision line', out.getvalue())
        self.assertNotIn('warning line', out.getvalue())
        self.assertNotIn('error line', out.getvalue())
        self.assertNotIn('decision line', err.getvalue())
        self.assertIn('warning line', err.getvalue())
        self.assertIn('error line', err.getvalue())
        for line in ('decision line', 'warning line', 'error line', 'Traceback', "KeyError: 'boom'"):
            self.assertIn(line, logged)


class MainTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.lock_dir = os.path.join(self.tmp, 'run')
        self.state_dir = os.path.join(self.tmp, 'state')
        for patch in (mock.patch.object(deployer, 'LOCK_DIR', self.lock_dir),
                      mock.patch.object(deployer, 'newest_main_commit', return_value=NEW_SHA),
                      mock.patch.object(deployer, 'image_exists', return_value=True)):
            patch.start()
            self.addCleanup(patch.stop)

    def argv(self, *extra):
        return ['--app', 'keyart', '--repo', 'raold/keyart', '--image', REPO,
                '--state-dir', self.state_dir, *extra]

    def test_go_creates_private_lock_and_state_dirs(self):
        code, out, err = run_main(self.argv('--go'), FakeApi(REPO, 'sha-2222222'))
        self.assertEqual((code, err), (0, ''))
        self.assertIn('current', out)
        for path in (self.lock_dir, self.state_dir):
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o700)
        self.assertTrue(os.path.exists(os.path.join(self.lock_dir, 'keyart.lock')))

    def test_dry_run_creates_no_dirs(self):
        code, _out, _err = run_main(self.argv(), FakeApi(REPO, 'sha-2222222'))
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(self.lock_dir))
        self.assertFalse(os.path.exists(self.state_dir))

    def test_refuses_unsafe_lock_dir(self):
        os.mkdir(self.lock_dir, 0o700)
        os.chmod(self.lock_dir, 0o777)
        with mock.patch.object(deployer, 'run') as run:
            code, out, err = run_main(self.argv('--go'), FakeApi(REPO, 'sha-1111111'))
        self.assertEqual((code, out), (1, ''))
        run.assert_not_called()
        self.assertIn(f'refusing to run: {self.lock_dir}', err)

    def test_refuses_unsafe_state_dir(self):
        os.mkdir(self.state_dir, 0o700)
        os.chmod(self.state_dir, 0o757)
        with mock.patch.object(deployer, 'run') as run:
            code, _out, err = run_main(self.argv(), FakeApi(REPO, 'sha-1111111'))
        self.assertEqual(code, 1)
        run.assert_not_called()
        self.assertIn(f'refusing to run: {self.state_dir}', err)

    def test_zfs_error_shows_its_stderr(self):
        failure = subprocess.CalledProcessError(
            1, ['zfs', 'snapshot', '-r', 'tank/apps/keyart@keyart-deploy-x'],
            stderr=b"cannot create snapshot 'tank/apps/keyart@keyart-deploy-x': out of space\n")
        api = FakeApi(REPO, 'sha-1111111', fail_snapshot=failure)
        code, out, err = run_main(self.argv('--go'), api)
        self.assertEqual(code, 1)
        self.assertIn('zfs snapshot -r tank/apps/keyart@keyart-deploy-x exited 1', err)
        self.assertIn('out of space', err)
        self.assertNotIn('out of space', out)
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, 'keyart.failed')))

    def test_unexpected_error_logs_traceback_to_file(self):
        path = os.path.join(self.tmp, 'deployer.log')
        api = FakeApi(REPO, 'sha-1111111', fail_port=KeyError('ports'))
        code, _out, err = run_main(self.argv('--log', path), api)
        self.assertEqual(code, 1)
        self.assertIn("failed: KeyError: 'ports'", err)
        with open(path, encoding='utf-8') as handle:
            logged = handle.read()
        self.assertIn('Traceback', logged)
        self.assertIn('get_port', logged)


if __name__ == '__main__':
    unittest.main()
