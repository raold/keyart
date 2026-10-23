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
