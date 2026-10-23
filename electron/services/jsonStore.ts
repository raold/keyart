import fs from 'fs'
import path from 'path'

/** Thrown when a JSON store file is unreadable and there is no usable backup to fall back on. */
export class ConfigCorruptError extends Error {
  constructor(file: string, backup: string) {
    super(`Cannot parse ${file} and the backup ${backup} is missing or unreadable. Fix or delete ${file} to start fresh.`)
    this.name = 'ConfigCorruptError'
  }
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseFile(file: string): Record<string, unknown> | null {
  try {
    return parseObject(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Reads a JSON object from `file`. A missing file reads as `{}`. If the file is unparseable, falls back
 * to `file.bak` (reported through `onBackup`), starts empty when the file is blank, and otherwise throws
 * ConfigCorruptError so the caller never overwrites data it could not read.
 */
export function readJsonFile(file: string, onBackup?: (backup: string) => void): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }

  const data = parseObject(raw)
  if (data) return data

  const backup = `${file}.bak`
  const recovered = parseFile(backup)
  if (recovered) {
    onBackup?.(backup)
    return recovered
  }

  if (raw.trim() === '') return {}
  throw new ConfigCorruptError(file, backup)
}

/**
 * Writes `data` to `file` so a crash never leaves it half-written: the JSON goes to `file.tmp` and is
 * fsynced, the previous good file is kept as `file.bak`, then the temp file is renamed over `file`.
 */
export function writeJsonFileAtomic(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const tmp = `${file}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }

  if (parseFile(file)) fs.copyFileSync(file, `${file}.bak`)
  fs.renameSync(tmp, file)
}
