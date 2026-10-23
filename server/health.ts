import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

/** The scheduler heartbeat is written every 30 s, so three missed writes mean it is stuck. */
const HEARTBEAT_MAX_AGE_SEC = 90

export interface HealthReport {
  ok: boolean
  version: string
  commit: string
  configWritable: boolean
  heartbeatAgeSec: number | null
  browserInstalled: boolean
}

export interface HealthInput {
  version: string
  commit: string
  configWritable: boolean
  /** ISO time of the last successful scheduler heartbeat write, or null when there has been none. */
  heartbeatAt: string | null
  browserInstalled: boolean
  /** Current time in epoch milliseconds. */
  now: number
}

/**
 * Builds the `/api/health` report. The app is healthy when the config
 * directory is writable and the scheduler heartbeat is at most 90 s old; a
 * missing browser is reported but does not make it unhealthy.
 *
 * @param input - The probed facts and the current time.
 * @returns The report, with `ok` set from the rules above.
 */
export function buildHealthReport(input: HealthInput): HealthReport {
  const { version, commit, configWritable, heartbeatAt, browserInstalled, now } = input
  const at = heartbeatAt === null ? NaN : Date.parse(heartbeatAt)
  const heartbeatAgeSec = Number.isNaN(at) ? null : Math.max(0, Math.round((now - at) / 1000))
  return {
    ok: configWritable && heartbeatAgeSec !== null && heartbeatAgeSec <= HEARTBEAT_MAX_AGE_SEC,
    version,
    commit,
    configWritable,
    heartbeatAgeSec,
    browserInstalled,
  }
}

/**
 * Checks that files can be created in a directory by writing and deleting a
 * probe file.
 *
 * @param dir - The directory to probe.
 * @returns True when the probe was written and removed; false on any error.
 */
export function isDirWritable(dir: string): boolean {
  const probe = path.join(dir, `.health-${randomUUID()}`)
  try {
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}
