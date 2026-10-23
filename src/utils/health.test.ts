import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildHealthReport, isDirWritable } from '../../server/health'

const NOW = Date.parse('2026-10-23T12:00:00.000Z')

function input(overrides: Partial<Parameters<typeof buildHealthReport>[0]> = {})
{
  return {
    version: '1.1.0',
    commit: 'abc1234',
    configWritable: true,
    heartbeatAt: new Date(NOW - 10_000).toISOString(),
    browserInstalled: true,
    now: NOW,
    ...overrides,
  }
}

describe('buildHealthReport', () =>
{
  it('healthy with a writable config and a fresh heartbeat', () =>
  {
    expect(buildHealthReport(input())).toEqual({
      ok: true,
      version: '1.1.0',
      commit: 'abc1234',
      configWritable: true,
      heartbeatAgeSec: 10,
      browserInstalled: true,
    })
  })

  it('unhealthy when the heartbeat is older than 90 s', () =>
  {
    const report = buildHealthReport(input({ heartbeatAt: new Date(NOW - 91_000).toISOString() }))

    expect(report.heartbeatAgeSec).toBe(91)
    expect(report.ok).toBe(false)
  })

  it('unhealthy without any heartbeat', () =>
  {
    const report = buildHealthReport(input({ heartbeatAt: null }))

    expect(report.heartbeatAgeSec).toBeNull()
    expect(report.ok).toBe(false)
  })

  it('unhealthy when the config dir is not writable', () =>
  {
    const report = buildHealthReport(input({ configWritable: false }))

    expect(report.configWritable).toBe(false)
    expect(report.ok).toBe(false)
  })

  it('a missing browser does not make it unhealthy', () =>
  {
    const report = buildHealthReport(input({ browserInstalled: false }))

    expect(report.browserInstalled).toBe(false)
    expect(report.ok).toBe(true)
  })
})

describe('isDirWritable', () =>
{
  const dirs: string[] = []

  afterEach(() =>
  {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is true for a writable directory and leaves nothing behind', () =>
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pps-health-'))
    dirs.push(dir)

    expect(isDirWritable(dir)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('is false for a path that does not exist', () =>
  {
    expect(isDirWritable(path.join(os.tmpdir(), 'pps-health-missing', 'nope'))).toBe(false)
  })
})
