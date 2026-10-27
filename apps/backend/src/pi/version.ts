import { compare, valid } from 'semver';

/** Compares semantic versions; undefined for an unknown/invalid version. Prereleases sort before their release. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = valid(left.trim());
  const b = valid(right.trim());
  return a && b ? compare(a, b) : undefined;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const comparison = compareVersions(candidate, current);
  // pi's own rule (utils/version-check.js): anything that is not comparable counts as newer when it differs.
  return comparison === undefined ? candidate.trim() !== current.trim() : comparison > 0;
}
