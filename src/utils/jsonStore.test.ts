import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ConfigCorruptError, readJsonFile, writeJsonFileAtomic } from '../../electron/services/jsonStore'

let dir: string
let file: string

beforeEach(() =>
{
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pps-json-store-'))
  file = path.join(dir, 'config.json')
})

afterEach(() =>
{
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('jsonStore', () =>
{
  it('round-trips data and leaves no .tmp file', () =>
  {
    writeJsonFileAtomic(file, { a: 1, nested: { b: ['x'] } })

    expect(readJsonFile(file)).toEqual({ a: 1, nested: { b: ['x'] } })
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
  })

  it('creates the directory when it is missing', () =>
  {
    const nested = path.join(dir, 'a', 'b', 'config.json')

    writeJsonFileAtomic(nested, { a: 1 })

    expect(readJsonFile(nested)).toEqual({ a: 1 })
  })

  it('keeps the previous good file as .bak', () =>
  {
    writeJsonFileAtomic(file, { a: 1 })
    writeJsonFileAtomic(file, { a: 2 })

    expect(readJsonFile(file)).toEqual({ a: 2 })
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))).toEqual({ a: 1 })
  })

  it('does not replace a good .bak with a corrupt config.json', () =>
  {
    writeJsonFileAtomic(file, { a: 1 })
    writeJsonFileAtomic(file, { a: 2 })
    fs.writeFileSync(file, '{"a":')
    writeJsonFileAtomic(file, { a: 3 })

    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))).toEqual({ a: 1 })
  })

  it('reads the .bak when config.json is truncated', () =>
  {
    fs.writeFileSync(file, '{"a":')
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ a: 1 }))

    expect(readJsonFile(file)).toEqual({ a: 1 })
  })

  it('reports the .bak through onBackup when it is used', () =>
  {
    fs.writeFileSync(file, '{"a":')
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ a: 1 }))
    const onBackup = vi.fn()

    readJsonFile(file, onBackup)

    expect(onBackup).toHaveBeenCalledWith(`${file}.bak`)
  })

  it('does not call onBackup when config.json is good', () =>
  {
    fs.writeFileSync(file, JSON.stringify({ a: 1 }))
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ a: 0 }))
    const onBackup = vi.fn()

    expect(readJsonFile(file, onBackup)).toEqual({ a: 1 })
    expect(onBackup).not.toHaveBeenCalled()
  })

  it('reads the .bak when config.json is empty', () =>
  {
    fs.writeFileSync(file, '')
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ a: 1 }))

    expect(readJsonFile(file)).toEqual({ a: 1 })
  })

  it('reads the .bak when config.json is not an object', () =>
  {
    fs.writeFileSync(file, '[1,2]')
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ a: 1 }))

    expect(readJsonFile(file)).toEqual({ a: 1 })
  })

  it('starts empty when config.json is empty and there is no .bak', () =>
  {
    fs.writeFileSync(file, '  \n')

    expect(readJsonFile(file)).toEqual({})
  })

  it('throws ConfigCorruptError when config.json is garbage and there is no .bak', () =>
  {
    fs.writeFileSync(file, '{"a": nope')

    expect(() => readJsonFile(file)).toThrow(ConfigCorruptError)
    expect(() => readJsonFile(file)).toThrow(file)
    expect(() => readJsonFile(file)).toThrow(`${file}.bak`)
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a": nope')
  })

  it('throws ConfigCorruptError when config.json and .bak are both garbage', () =>
  {
    fs.writeFileSync(file, '{"a":')
    fs.writeFileSync(`${file}.bak`, 'nope')

    expect(() => readJsonFile(file)).toThrow(ConfigCorruptError)
  })

  it('missing file reads as empty', () =>
  {
    expect(readJsonFile(file)).toEqual({})
  })
})
