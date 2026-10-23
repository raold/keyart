/**
 * Icon asset generator - renders the SVG masters in resources/ into every
 * raster the app needs. Run with: npm run icons
 *
 * Sources:
 *   resources/icon.svg        master app tile (used at >= 48px)
 *   resources/icon-small.svg  simplified tile (used at <= 32px ICO entries)
 *   resources/tray.svg        transparent tray glyph (>= 32px)
 *   resources/tray-small.svg  tray glyph for native tray sizes (<= 24px)
 *   src/public/favicon.svg    browser tab icon (served as-is)
 *   .github/assets/logo.svg   README logo, also the home-screen icon
 *
 * Outputs:
 *   resources/icon.ico        app/installer icon (16,20,24,32,48,64,128,256)
 *   resources/icon.png        512px (electron-builder linux icon)
 *   resources/icons/app-256.png      window + notification icon (runtime)
 *   resources/icons/tray.ico         Windows tray (16,20,24,32,40,48,64)
 *   resources/icons/tray-{16,24,32,48,64}.png  Linux/mac tray fallbacks
 *   src/public/favicon.ico           fallback for browsers without SVG favicons (16,32,48)
 *   src/public/apple-touch-icon.png  iOS home screen (180, logo on an opaque background)
 */
import { Resvg } from '@resvg/resvg-js'
import { Buffer } from 'node:buffer'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const res = (...p) => path.join(root, 'resources', ...p)

const master = readFileSync(res('icon.svg'), 'utf8')
const small = readFileSync(res('icon-small.svg'), 'utf8')
const tray = readFileSync(res('tray.svg'), 'utf8')
const traySmall = readFileSync(res('tray-small.svg'), 'utf8')

/**
 * Renders an SVG string to a PNG buffer of the given size. The SVG is scaled
 * to fit the size, preserving aspect ratio. The viewBox of the SVG is used as
 * the reference for scaling.
 *
 * @param svg - The SVG string to render.
 * @param size - The desired size of the output PNG.
 * @returns A buffer containing the PNG data.
 */
function renderPng(svg, size)
{
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    font: { loadSystemFonts: false },
  })
  return r.render().asPng()
}

/**
 * Packs PNGs into an ICO container: ICONDIR header + ICONDIRENTRY per image +
 * PNG payloads. PNG-compressed entries are supported from Vista onward.
 *
 * @param entries - An array of objects containing the size and PNG buffer.
 * @returns A buffer containing the ICO data.
 */
function packIco(entries)
{
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)

  let offset = 6 + 16 * entries.length
  const dirs = []
  const blobs = []
  for (const { size, png } of entries)
  {
    const dir = Buffer.alloc(16)
    dir.writeUInt8(size >= 256 ? 0 : size, 0) // width (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, 1) // height
    dir.writeUInt16LE(1, 4) // color planes
    dir.writeUInt16LE(32, 6) // bits per pixel
    dir.writeUInt32LE(png.length, 8)
    dir.writeUInt32LE(offset, 12)
    offset += png.length
    dirs.push(dir)
    blobs.push(png)
  }
  return Buffer.concat([header, ...dirs, ...blobs])
}

mkdirSync(res('icons'), { recursive: true })

// App icon: simplified tile for taskbar sizes, full detail above that.
const appEntries = [
  ...[16, 20, 24, 32].map(size => ({ size, png: renderPng(small, size) })),
  ...[48, 64, 128, 256].map(size => ({ size, png: renderPng(master, size) })),
]
writeFileSync(res('icon.ico'), packIco(appEntries))

writeFileSync(res('icon.png'), renderPng(master, 512))
writeFileSync(res('icons', 'app-256.png'), renderPng(master, 256))

// Tray: Windows picks the right entry from the .ico per DPI. Native tray
// sizes (<= 24px) come from the simplified glyph.
const trayEntries = [16, 20, 24, 32, 40, 48, 64].map(size => ({
  size,
  png: renderPng(size <= 24 ? traySmall : tray, size),
}))
writeFileSync(res('icons', 'tray.ico'), packIco(trayEntries))
for (const size of [16, 24, 32, 48, 64])
{
  writeFileSync(res('icons', `tray-${size}.png`), renderPng(size <= 24 ? traySmall : tray, size))
}

// Web: the favicon SVG is the small-size mark; iOS needs an opaque square, so
// the logo goes on the app's dark background (iOS rounds the corners itself).
const pub = (...p) => path.join(root, 'src', 'public', ...p)
const favicon = readFileSync(pub('favicon.svg'), 'utf8')
writeFileSync(pub('favicon.ico'), packIco([16, 32, 48].map(size => ({ size, png: renderPng(favicon, size) }))))
const logo = readFileSync(path.join(root, '.github', 'assets', 'logo.svg'), 'utf8')
  .replace('</defs>', '</defs>\n  <rect width="200" height="200" fill="#11141b"/>')
writeFileSync(pub('apple-touch-icon.png'), renderPng(logo, 180))

stdout.write('Icons generated into resources/, resources/icons/ and src/public/\n')
