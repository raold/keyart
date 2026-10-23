import { describe, it, expect } from 'vitest'
import { displayVersion } from './version'

describe('displayVersion', () =>
{
  it('drops the patch when it is zero', () =>
  {
    expect(displayVersion('1.1.0')).toBe('1.1')
  })

  it('strips a leading v as well', () =>
  {
    expect(displayVersion('v2.0.0')).toBe('2.0')
  })

  it('keeps a real patch number', () =>
  {
    expect(displayVersion('1.1.2')).toBe('1.1.2')
  })

  it('leaves a major.minor version alone', () =>
  {
    expect(displayVersion('1.0')).toBe('1.0')
  })

  it('returns an empty string for an empty version', () =>
  {
    expect(displayVersion('')).toBe('')
  })
})
