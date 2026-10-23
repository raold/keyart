<p align="center">
  <img src=".github/assets/logo.svg" width="96" alt="Keyart" />
</p>

<h1 align="center">Keyart</h1>

<p align="center">Pick poster art from MediUX and ThePosterDB and apply it to your Plex library.</p>

---

Keyart browses the movies, shows and collections already in your Plex library, finds the poster sets made for
each one on [MediUX](https://mediux.pro) and [ThePosterDB](https://theposterdb.com), and applies the set you pick:
posters, season posters, episode title cards, backdrops and collection posters.

It runs in Docker and you use it from a browser. A built-in scheduler keeps applied sets in sync when their
creators update them.

## Features

- **Library browser.** Pick a title and every set for it from both sites appears in a large gallery, side by side,
  tagged by site and creator.
- **Collections.** Apply a franchise set to one movie, every movie of it in your library, and the collection
  poster, in one go.
- **Creators.** Follow the creators you like so their sets come first; hide the ones you don't.
- **Scheduler.** Keep a set or a creator's art up to date on a schedule.
- **Manual import.** Paste set, boxset or creator links and apply them directly.
- **Title mappings.** Point a set at the right title when names don't match.
- **Reset posters.** Put the original Plex art back for any title.

Posters are matched by TMDB ID, read from each Plex item. For titles Plex stores without one (TVDB or IMDb agents),
add a free TMDB API key in Settings.

## Run it with Docker

```bash
git clone https://github.com/raold/keyart.git
cd keyart
docker compose -f docker/docker-compose.yml up -d --build
```

Open `http://<host>:3939` and sign in with Plex. Settings, schedules and applied-art history live in the config
volume (`docker/config` with Compose).

Without Compose, `./docker/run.sh` (or `./docker/run.ps1` on Windows) builds the image and starts the container;
`--stop` removes it and keeps the config volume. Set `PORT` to use a different host port.

## Updating

```bash
git pull
docker compose -f docker/docker-compose.yml up -d --build
```

Your config volume is kept across updates.

## Auto-deploy on TrueNAS SCALE

`deploy/truenas-deployer.py` keeps a TrueNAS SCALE app on the newest `main` commit. CI publishes
`ghcr.io/raold/keyart:sha-<7 hex>` for every `main` commit that passes. Each run, the script looks up the newest
commit on `main` and, once its image is published, snapshots the app's data, points the app at that image and waits
up to 3 minutes for `/api/health` to report that commit. If it doesn't, the previous image goes back and the commit is
skipped until a newer one lands. Older commits are never deployed: while CI runs for the newest one, it waits.

It needs:

- keyart installed as a TrueNAS Custom App with `/config` on an ixVolume (that dataset is snapshotted) and a
  published port (health is checked on `127.0.0.1:<port>`).
- A public image package on GHCR, so it can be checked and pulled without signing in.
- Root on the server: it uses the TrueNAS API client and `zfs`.

Copy the script to the server and try it. Without `--go` it only prints what it would do:

```bash
python3 truenas-deployer.py --app keyart --repo raold/keyart --image ghcr.io/raold/keyart
```

Then run it every 5 minutes as root (System > Advanced Settings > Cron Jobs):

```
*/5 * * * * python3 /path/to/truenas-deployer.py --app keyart --repo raold/keyart --image ghcr.io/raold/keyart --go
```

Snapshots are named `<dataset>@keyart-deploy-<UTC time>`; the newest 10 are kept (`--keep-snapshots N`).
`--log FILE` also appends each decision to a file. A run that starts while another is still going exits at once.
The exit code is non-zero after a rollback or an error.

## Backing up and restoring /config

Everything keyart keeps is in `/config`: the Plex sign-in, settings, schedules, applied-art history and creator
choices. The image holds no state, so a copy of that folder is a full backup. With Compose it is `docker/config`,
`./docker/run.sh` uses the `keyart-config` volume, and on TrueNAS it is the app's ixVolume dataset.

To back up, snapshot the dataset or volume behind `/config`, or copy the folder while the container is stopped:

```bash
docker stop keyart
cp -a docker/config ~/keyart-config-backup
docker start keyart
```

To restore, stop keyart, replace the contents of `/config` with the backup (or roll the dataset back to a snapshot,
including the deployer's `keyart-deploy-*` ones) and start it again. To move keyart to a new host, put the backup in
place before its first start there.

## Releasing

Versions are major.minor. To cut release `X.Y`:

1. Set `version` in `package.json` (and the root entry of `package-lock.json`) to `X.Y.0` and commit.
2. Tag the commit `vX.Y` and push the tag.

CI then publishes `ghcr.io/raold/keyart:X.Y` and `:latest`, plus a GitHub Release. The app shows the version as `X.Y`.
Push only `vX.Y` tags: any tag starting with `v` moves `latest` and creates a release.

## Development

Requires Node.js 22.

```bash
npm install
npm run dev:web      # web UI with hot reload
npm run dev          # desktop (Electron) app with hot reload
npm test             # unit tests
npm run typecheck
npm run lint
npm run dist         # package the desktop app for the current OS
```

Stack: React, TypeScript and Vite in the browser; Fastify serving the web UI; Electron for the desktop build;
Playwright as a scraping fallback.

## License

[MIT](LICENSE)
