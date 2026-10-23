#!/usr/bin/env python3
"""Keeps a TrueNAS SCALE app on the image of the newest commit on `main`.

Run by cron as root on the server. A run leaves an app that is not RUNNING
alone. Otherwise it looks up the newest `main` commit and, once CI has
published `<image>:sha-<7 hex>` for it, snapshots the app's data dataset,
points the app at that tag and waits for `/api/health` to report the
commit. If it doesn't, the previous image is put back and the failed deploy
is recorded in --state-dir, so that tag is not tried again; if putting it back
fails, every later run retries that and exits non-zero. Older commits are never
deployed. Without --go nothing changes. Decisions go to stdout, warnings and
errors to stderr.

    truenas-deployer.py --app keyart --repo raold/keyart --image ghcr.io/raold/keyart [--go]
"""
from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Callable

SNAPSHOT_PREFIX = 'keyart-deploy-'
POLL_INTERVAL_S = 5
# The run lock: a directory only root can write, on tmpfs, so a reboot clears it.
LOCK_DIR = '/run/truenas-deployer'
# The failed-deploy record lives here by default (see --state-dir) and survives reboots.
DEFAULT_STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.truenas-deployer-state')
USER_AGENT = 'keyart-truenas-deployer'
# CI attaches provenance, so a tag is usually an index rather than a single manifest.
MANIFEST_TYPES = ', '.join([
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
])

log = logging.getLogger('truenas-deployer')
_held_locks = {}


class RegistryAccessDenied(Exception):
    """The registry refused an anonymous pull: the package is private or not published."""


class RollbackFailed(Exception):
    """Putting the previous image back failed; the app may still run the new one."""


class UnsafeDir(Exception):
    """A lock or state directory someone other than the current user could change."""


def short_sha(sha: str) -> str:
    """Returns the 7-character form of a commit SHA used in `sha-` image tags."""
    return sha[:7]


def decide(current_tag: str, target_tag: str | None) -> str:
    """Returns 'wait' when the newest main commit has no image yet, 'current' when
    the app already runs it, else 'deploy'."""
    if target_tag is None:
        return 'wait'
    if current_tag == target_tag:
        return 'current'
    return 'deploy'


def health_ok(report: dict | None, commit: str) -> bool:
    """True when a `/api/health` report says ok and was built from `commit`."""
    if not isinstance(report, dict) or report.get('ok') is not True:
        return False
    reported = report.get('commit')
    return isinstance(reported, str) and reported.startswith(short_sha(commit))


def snapshots_to_prune(names: list[str], prefix: str, keep: int) -> list[str]:
    """Returns the snapshots to destroy so only the newest `keep` whose snapshot
    part starts with `prefix` remain; `names` and the result are oldest first."""
    ours = [name for name in names if name.partition('@')[2].startswith(prefix)]
    return ours[:max(len(ours) - keep, 0)]


def _restore(api, app: str, previous: tuple[str, str]) -> None:
    try:
        api.set_image(app, *previous)
    except Exception as err:
        log.error('%s: restoring %s:%s failed: %s', app, *previous, err)
        raise RollbackFailed(f'restoring {previous[0]}:{previous[1]} failed: {err}') from err


def deploy(api, app: str, target_tag: str, probe: Callable[[], dict | None],
           sleep: Callable[[float], None], timeout_s: float = 180,
           repository: str | None = None,
           before_switch: Callable[[], None] | None = None) -> str:
    """Snapshots the app's data, switches it to `repository:target_tag` (default:
    its current repository) and polls `probe` until the app reports the tag's
    commit. Puts the previous image back when the update fails or `timeout_s`
    passes. `before_switch` runs after the snapshot, right before the switch.
    Returns 'deployed' or 'rolled-back'; raises RollbackFailed when the
    previous image could not be put back."""
    previous = (api.get_image_repository(app), api.get_image_tag(app))
    commit = target_tag.removeprefix('sha-')
    api.snapshot(app, SNAPSHOT_PREFIX + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    if before_switch:
        before_switch()
    try:
        api.set_image(app, repository or previous[0], target_tag)
    except Exception as err:
        log.warning('%s: update to %s failed (%s), restoring %s:%s', app, target_tag, err, *previous)
        _restore(api, app, previous)
        return 'rolled-back'
    waited = 0.0
    while True:
        report = probe()
        if health_ok(report, commit):
            return 'deployed'
        if waited >= timeout_s:
            break
        sleep(POLL_INTERVAL_S)
        waited += POLL_INTERVAL_S
    log.warning('%s: %s not healthy after %ds (last report: %s), restoring %s:%s',
                app, target_tag, timeout_s, json.dumps(report), *previous)
    _restore(api, app, previous)
    return 'rolled-back'


def acquire_lock(path: str) -> bool:
    """Takes a non-blocking exclusive lock held until the process exits; False
    when another holder has it."""
    import fcntl

    handle = open(path, 'a')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return False
    _held_locks[path] = handle
    return True


def private_dir(path: str, create: bool) -> None:
    """Makes sure `path` is a directory owned by the current user that group and
    others cannot write, creating it with mode 0700 when `create` is set. A
    missing directory is fine without `create`. Raises UnsafeDir otherwise."""
    if create:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        if create:
            raise
        return
    if not stat.S_ISDIR(info.st_mode):
        problem = 'is not a directory'
    elif info.st_uid != os.getuid():
        problem = f'is owned by uid {info.st_uid}, not {os.getuid()}'
    elif info.st_mode & 0o022:
        problem = f'is writable by group or others (mode {stat.S_IMODE(info.st_mode):o})'
    else:
        return
    raise UnsafeDir(f'refusing to run: {path} {problem}; fix or remove it')


def command_error(err: subprocess.CalledProcessError) -> str:
    """Describes a failed command: its arguments, exit code and stderr."""
    stderr = err.stderr.decode(errors='replace') if isinstance(err.stderr, bytes) else err.stderr or ''
    command = ' '.join(map(str, err.cmd)) if isinstance(err.cmd, (list, tuple)) else str(err.cmd)
    return f'{command} exited {err.returncode}: {stderr.strip() or "(no error output)"}'


def _get_json(url: str, headers: dict | None = None) -> dict:
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def newest_main_commit(repo: str) -> str:
    """Returns the full SHA of the newest commit on the repo's `main` branch."""
    url = f'https://api.github.com/repos/{repo}/commits/main'
    return _get_json(url, {'Accept': 'application/vnd.github+json'})['sha']


def image_exists(image: str, tag: str) -> bool:
    """True when `image:tag` is in the registry, using an anonymous pull token.
    Raises RegistryAccessDenied when the registry refuses anonymous access."""
    registry, _, name = image.partition('/')
    try:
        token = _get_json(f'https://{registry}/token?scope=repository:{name}:pull')['token']
        request = urllib.request.Request(
            f'https://{registry}/v2/{name}/manifests/{tag}', method='HEAD',
            headers={'Authorization': f'Bearer {token}', 'Accept': MANIFEST_TYPES, 'User-Agent': USER_AGENT})
        with urllib.request.urlopen(request, timeout=20):
            return True
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return False
        if err.code in (401, 403):
            raise RegistryAccessDenied(
                f'{image} refuses anonymous pulls (HTTP {err.code}): the package is private or '
                'not published yet; make it public in its GitHub package settings') from None
        raise


def probe_health(port: int) -> dict | None:
    """Reads the app's `/api/health` report, including a 503 one; None when there
    is no JSON answer."""
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=5) as response:
            return json.load(response)
    except urllib.error.HTTPError as err:
        try:
            return json.load(err)
        except (OSError, ValueError, http.client.HTTPException):
            return None
    except (OSError, ValueError, http.client.HTTPException):
        return None


def _zfs(*args: str) -> str:
    return subprocess.run(['zfs', *args], capture_output=True, text=True, check=True).stdout


class TrueNASApi:
    """The app's image through the TrueNAS middleware, and its data dataset through zfs."""

    def _config(self, app: str) -> dict:
        from truenas_api_client import Client

        with Client() as client:
            return client.call('app.config', app)

    def get_state(self, app: str) -> str:
        from truenas_api_client import Client

        with Client() as client:
            found = client.call('app.query', [['name', '=', app]])
        if not found:
            raise RuntimeError(f'there is no app named {app}')
        return found[0]['state']

    def get_image_repository(self, app: str) -> str:
        return self._config(app)['image']['repository']

    def get_image_tag(self, app: str) -> str:
        return self._config(app)['image']['tag']

    def get_port(self, app: str) -> int:
        ports = self._config(app).get('ports') or []
        if not ports:
            raise RuntimeError(f'{app} publishes no port to check health on')
        return ports[0]['port_number']

    def set_image(self, app: str, repository: str, tag: str) -> None:
        from truenas_api_client import Client

        with Client() as client:
            values = {k: v for k, v in client.call('app.config', app).items() if not k.startswith('ix_')}
            values['image'] = {**values['image'], 'repository': repository, 'tag': tag, 'pull_policy': 'missing'}
            client.call('app.update', app, {'values': values}, job=True)

    def dataset(self, app: str) -> str:
        suffix = f'/ix-apps/app_mounts/{app}'
        found = [name for name in _zfs('list', '-H', '-o', 'name').splitlines() if name.endswith(suffix)]
        if len(found) != 1:
            raise RuntimeError(f'expected one dataset ending in {suffix}, found {len(found)}')
        return found[0]

    def snapshot(self, app: str, name: str) -> None:
        _zfs('snapshot', '-r', f'{self.dataset(app)}@{name}')

    def snapshots(self, app: str) -> list[str]:
        return _zfs('list', '-H', '-t', 'snapshot', '-o', 'name', '-s', 'creation', '-d', '1',
                    self.dataset(app)).splitlines()

    def destroy_snapshot(self, name: str) -> None:
        _zfs('destroy', '-r', name)


def _read_record(path: str) -> dict:
    try:
        with open(path) as handle:
            record = json.load(handle)
    except (FileNotFoundError, ValueError):
        return {}
    return record if isinstance(record, dict) else {}


def _write_record(path: str, record: dict) -> None:
    temp = f'{path}.tmp'
    with open(temp, 'w') as handle:
        json.dump(record, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def _clear_record(path: str) -> None:
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def run(args: argparse.Namespace, api, probe: Callable[[int], dict | None],
        sleep: Callable[[float], None]) -> int:
    """One pass: unless the app is stopped or starting, decide, then (with --go)
    deploy and prune. Returns the exit code."""
    app = args.app
    state = api.get_state(app)
    repository, current = api.get_image_repository(app), api.get_image_tag(app)
    running = f'{repository}:{current}'
    # The last deploy that did not finish: its tag and the image it replaced.
    failed_path = os.path.join(args.state_dir, f'{app}.failed')
    failed = _read_record(failed_path)
    stuck = (failed.get('image'), failed.get('tag')) == (repository, current)
    if state != 'RUNNING':
        if stuck:
            log.error('%s: wait: app is %s, on %s, whose deploy failed and was not rolled back; '
                      'not touching it while it is not running, put %s:%s back by hand',
                      app, state, running, failed['previous_repository'], failed['previous_tag'])
            return 1
        log.info('%s: wait: app is %s', app, state)
        return 0
    if stuck:
        previous = (failed['previous_repository'], failed['previous_tag'])
        log.error('%s: running %s, whose deploy failed and was not rolled back; %s %s:%s',
                  app, running, 'restoring' if args.go else 'dry run, would restore', *previous)
        if args.go:
            _restore(api, app, previous)
            log.info('%s: rolled-back %s', app, current)
        return 1

    commit = newest_main_commit(args.repo)
    tag = f'sha-{short_sha(commit)}'
    target = tag if image_exists(args.image, tag) else None
    decision = decide(current if repository == args.image else running, target)
    if decision == 'wait':
        log.info('%s: wait, no image for the newest main commit %s yet (running %s)', app, tag, running)
        return 0
    if decision == 'current':
        log.info('%s: current, running %s', app, running)
        return 0
    if failed.get('tag') == target:
        log.info('%s: wait, %s failed to deploy; waiting for a newer main commit (running %s)', app, target, running)
        return 0
    port = api.get_port(app)
    if not args.go:
        log.info('%s: deploy %s:%s (running %s); dry run, would snapshot %s and check port %d, nothing changed',
                 app, args.image, target, running, api.dataset(app), port)
        return 0
    log.info('%s: deploy %s:%s (running %s)', app, args.image, target, running)
    # Written right before the switch and cleared once deployed, so a failure
    # before the switch never marks the commit, and anything after it does.
    record = {'image': args.image, 'tag': target, 'previous_repository': repository, 'previous_tag': current}
    try:
        result = deploy(api, app, target, lambda: probe(port), sleep, repository=args.image,
                        before_switch=lambda: _write_record(failed_path, record))
    finally:
        for name in snapshots_to_prune(api.snapshots(app), SNAPSHOT_PREFIX, args.keep_snapshots):
            api.destroy_snapshot(name)
            log.info('%s: pruned snapshot %s', app, name)
    if result == 'deployed':
        _clear_record(failed_path)
    log.info('%s: %s %s', app, result, target)
    return 0 if result == 'deployed' else 1


def _positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('must be at least 1')
    return number


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Keep a TrueNAS SCALE app on the newest main commit.')
    parser.add_argument('--app', required=True, help='TrueNAS app name')
    parser.add_argument('--repo', required=True, help='GitHub repository, OWNER/REPO')
    parser.add_argument('--image', required=True, help='image repository, e.g. ghcr.io/OWNER/REPO')
    parser.add_argument('--keep-snapshots', type=_positive, default=10, help='deploy snapshots to keep (default 10)')
    parser.add_argument('--log', help='also append each decision to this file')
    parser.add_argument('--state-dir', default=DEFAULT_STATE_DIR,
                        help='where the failed-deploy record is kept (default: .truenas-deployer-state '
                             'next to this script)')
    parser.add_argument('--go', action='store_true', help='make changes (default: dry run)')
    return parser.parse_args(argv)


def setup_logging(log_file: str | None) -> None:
    """Sends decisions (INFO) to stdout, warnings and errors to stderr only, and
    everything, tracebacks included, to `log_file` when given; UTC timestamps."""
    formatter = logging.Formatter('%(asctime)s %(message)s', '%Y-%m-%dT%H:%M:%SZ')
    formatter.converter = time.gmtime
    stdout = logging.StreamHandler(sys.stdout)
    stdout.addFilter(lambda record: record.levelno < logging.WARNING)
    stderr = logging.StreamHandler(sys.stderr)
    stderr.setLevel(logging.WARNING)
    handlers = [stdout, stderr]
    if log_file:
        handlers.append(logging.FileHandler(log_file, encoding='utf-8'))
    for handler in handlers:
        handler.setFormatter(formatter)
        log.addHandler(handler)
    log.setLevel(logging.INFO)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.log)
    try:
        if args.go:
            private_dir(LOCK_DIR, create=True)
            if not acquire_lock(os.path.join(LOCK_DIR, f'{args.app}.lock')):
                log.info('%s: another deployer run is still going, exiting', args.app)
                return 0
        private_dir(args.state_dir, create=args.go)
        return run(args, TrueNASApi(), probe_health, time.sleep)
    except RollbackFailed:
        pass  # already logged
    except (RegistryAccessDenied, UnsafeDir) as err:
        log.error('%s: %s', args.app, err)
    except subprocess.CalledProcessError as err:
        log.error('%s: failed: %s', args.app, command_error(err))
    except Exception as err:
        log.exception('%s: failed: %s: %s', args.app, type(err).__name__, err)
    return 1


if __name__ == '__main__':
    sys.exit(main())
