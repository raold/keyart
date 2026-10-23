#!/usr/bin/env python3
"""Keeps a TrueNAS SCALE app on the image of the newest commit on `main`.

Run by cron as root on the server. Each run looks up the newest `main` commit
and, once CI has published `<image>:sha-<7 hex>` for it, snapshots the app's
data dataset, points the app at that tag and waits for `/api/health` to report
the commit. If it doesn't, the previous image is put back and that tag is not
tried again. Older commits are never deployed. Without --go nothing changes.

    truenas-deployer.py --app keyart --repo raold/keyart --image ghcr.io/raold/keyart [--go]
"""
from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Callable

SNAPSHOT_PREFIX = 'keyart-deploy-'
POLL_INTERVAL_S = 5
# Lock and the last rolled-back tag; cleared on reboot, which allows one retry.
STATE_DIR = '/run/lock'
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


def deploy(api, app: str, target_tag: str, probe: Callable[[], dict | None],
           sleep: Callable[[float], None], timeout_s: float = 180,
           repository: str | None = None) -> str:
    """Snapshots the app's data, switches it to `repository:target_tag` (default:
    its current repository) and polls `probe` until the app reports the tag's
    commit. Puts the previous image back when the update fails or `timeout_s`
    passes. Returns 'deployed' or 'rolled-back'."""
    previous = (api.get_image_repository(app), api.get_image_tag(app))
    commit = target_tag.removeprefix('sha-')
    api.snapshot(app, SNAPSHOT_PREFIX + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S'))
    try:
        api.set_image(app, repository or previous[0], target_tag)
    except Exception as err:
        log.warning('%s: update to %s failed (%s), restoring %s:%s', app, target_tag, err, *previous)
        api.set_image(app, *previous)
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
    api.set_image(app, *previous)
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


def _read(path: str) -> str:
    try:
        with open(path) as handle:
            return handle.read().strip()
    except FileNotFoundError:
        return ''


def run(args: argparse.Namespace, api, probe: Callable[[int], dict | None],
        sleep: Callable[[float], None]) -> int:
    """One pass: decide, then (with --go) deploy and prune. Returns the exit code."""
    app = args.app
    commit = newest_main_commit(args.repo)
    tag = f'sha-{short_sha(commit)}'
    target = tag if image_exists(args.image, tag) else None
    repository, current = api.get_image_repository(app), api.get_image_tag(app)
    running = f'{repository}:{current}'
    decision = decide(current if repository == args.image else running, target)
    if decision == 'wait':
        log.info('%s: wait, no image for the newest main commit %s yet (running %s)', app, tag, running)
        return 0
    if decision == 'current':
        log.info('%s: current, running %s', app, running)
        return 0
    failed_path = os.path.join(STATE_DIR, f'truenas-deployer-{app}.failed')
    if _read(failed_path) == target:
        log.info('%s: wait, %s was rolled back; waiting for a newer main commit (running %s)', app, target, running)
        return 0
    port = api.get_port(app)
    if not args.go:
        log.info('%s: deploy %s:%s (running %s); dry run, would snapshot %s and check port %d, nothing changed',
                 app, args.image, target, running, api.dataset(app), port)
        return 0
    log.info('%s: deploy %s:%s (running %s)', app, args.image, target, running)
    result = deploy(api, app, target, lambda: probe(port), sleep, repository=args.image)
    if result == 'rolled-back':
        with open(failed_path, 'w') as handle:
            handle.write(target + '\n')
    log.info('%s: %s %s', app, result, target)
    for name in snapshots_to_prune(api.snapshots(app), SNAPSHOT_PREFIX, args.keep_snapshots):
        api.destroy_snapshot(name)
        log.info('%s: pruned snapshot %s', app, name)
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
    parser.add_argument('--go', action='store_true', help='make changes (default: dry run)')
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    formatter = logging.Formatter('%(asctime)s %(message)s', '%Y-%m-%dT%H:%M:%SZ')
    formatter.converter = time.gmtime
    handlers = [logging.StreamHandler(sys.stdout)]
    if args.log:
        handlers.append(logging.FileHandler(args.log, encoding='utf-8'))
    for handler in handlers:
        handler.setFormatter(formatter)
        log.addHandler(handler)
    log.setLevel(logging.INFO)

    try:
        if args.go and not acquire_lock(os.path.join(STATE_DIR, f'truenas-deployer-{args.app}.lock')):
            log.info('%s: another deployer run is still going, exiting', args.app)
            return 0
        return run(args, TrueNASApi(), probe_health, time.sleep)
    except RegistryAccessDenied as err:
        log.error('%s: %s', args.app, err)
    except Exception as err:
        log.error('%s: failed: %s: %s', args.app, type(err).__name__, err)
    return 1


if __name__ == '__main__':
    sys.exit(main())
