/**
 * Formats a version for display. Releases are major.minor, so a leading `v` and
 * a zero patch are dropped: `1.1.0` shows as `1.1`, `1.1.2` stays as it is.
 *
 * @param v - A version such as `1.1.0` or `v2.0.0`.
 * @returns The version without the `v` and the `.0` patch.
 */
export function displayVersion(v: string): string
{
  return v.replace(/^v/, '').replace(/^(\d+\.\d+)\.0$/, '$1')
}
