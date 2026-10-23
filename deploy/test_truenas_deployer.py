import importlib.util
import os
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


class FakeApi:
    def __init__(self, repository, tag, fail_update=False, fail_restore=False):
        self.repository = repository
        self.tag = tag
        self.original = (repository, tag)
        self.fail_update = fail_update
        self.fail_restore = fail_restore
        self.calls = []
        self.snapshot_names = []

    def get_image_repository(self, app):
        return self.repository

    def get_image_tag(self, app):
        return self.tag

    def get_port(self, app):
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
        sleeps = []
        result = deployer.deploy(api, 'keyart', 'sha-2222222', lambda: next(reports), sleeps.append)
        self.assertEqual(result, 'deployed')
        self.assertEqual([call[0] for call in api.calls], ['snapshot', 'set_image'])
        self.assertTrue(api.calls[0][2].startswith('keyart-deploy-'))
        self.assertEqual(api.calls[1], ('set_image', 'keyart', REPO, 'sha-2222222'))
        self.assertEqual(len(sleeps), 1)

    def test_deploy_rolls_back(self):
        # Starts, but keeps reporting the commit it replaced.
        api = FakeApi('keyart', '1.0.2')
        sleeps = []
        with self.assertLogs(deployer.log, 'WARNING'):
            result = deployer.deploy(api, 'keyart', 'sha-2222222',
                                     lambda: {'ok': True, 'commit': OLD_SHA}, sleeps.append,
                                     timeout_s=30, repository=REPO)
        self.assertEqual(result, 'rolled-back')
        self.assertEqual(api.calls[1], ('set_image', 'keyart', REPO, 'sha-2222222'))
        self.assertEqual(api.calls[-1], ('set_image', 'keyart', 'keyart', '1.0.2'))
        self.assertGreaterEqual(sum(sleeps), 30)

    def test_deploy_rolls_back_when_update_fails(self):
        api = FakeApi(REPO, 'sha-1111111', fail_update=True)
        with self.assertLogs(deployer.log, 'WARNING'):
            result = deployer.deploy(api, 'keyart', 'sha-2222222', lambda: None, lambda _s: None)
        self.assertEqual(result, 'rolled-back')
        self.assertEqual(api.calls[-1], ('set_image', 'keyart', REPO, 'sha-1111111'))


class RunTest(unittest.TestCase):
    def test_rolled_back_tag_is_not_retried(self):
        api = FakeApi(REPO, 'sha-1111111')
        args = deployer.parse_args(['--app', 'keyart', '--repo', 'raold/keyart', '--image', REPO, '--go'])
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(deployer, 'STATE_DIR', tmp), \
                mock.patch.object(deployer, 'newest_main_commit', return_value=NEW_SHA), \
                mock.patch.object(deployer, 'image_exists', return_value=True), \
                self.assertLogs(deployer.log, 'INFO'):
            self.assertEqual(deployer.run(args, api, lambda _port: None, lambda _s: None), 1)
            updates = [call for call in api.calls if call[0] == 'set_image']
            self.assertEqual(api.tag, 'sha-1111111')
            self.assertEqual(deployer.run(args, api, lambda _port: None, lambda _s: None), 0)
            self.assertEqual([call for call in api.calls if call[0] == 'set_image'], updates)

    def test_failed_rollback_is_recorded_and_retried(self):
        # The new image never reports healthy and putting the old one back fails.
        api = FakeApi(REPO, 'sha-1111111', fail_restore=True)
        api.snapshot_names = [f'tank/ix-apps/app_mounts/keyart@keyart-deploy-202610{day:02d}-120000'
                              for day in range(1, 11)]
        args = deployer.parse_args(['--app', 'keyart', '--repo', 'raold/keyart', '--image', REPO, '--go'])

        def run():
            return deployer.run(args, api, lambda _port: None, lambda _s: None)

        def snapshots_taken():
            return len([call for call in api.calls if call[0] == 'snapshot'])

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(deployer, 'STATE_DIR', tmp), \
                mock.patch.object(deployer, 'newest_main_commit', return_value=NEW_SHA), \
                mock.patch.object(deployer, 'image_exists', return_value=True), \
                self.assertLogs(deployer.log, 'INFO') as logs:
            with self.assertRaises(deployer.RollbackFailed):
                run()
            self.assertEqual(api.tag, 'sha-2222222')
            self.assertTrue(os.path.exists(os.path.join(tmp, 'truenas-deployer-keyart.failed')))
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


if __name__ == '__main__':
    unittest.main()
