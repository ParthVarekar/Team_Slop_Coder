import { describe, expect, it } from 'vitest';
import {
  parseGitVersion,
  versionAtLeast,
  capabilitiesFor,
  detectGitCapabilities,
  FSMONITOR_FLOORS,
} from '@weft/core';

describe('parseGitVersion', () => {
  it('parses standard and platform-suffixed versions', () => {
    expect(parseGitVersion('git version 2.53.0.windows.2')).toMatchObject({
      major: 2,
      minor: 53,
      patch: 0,
    });
    expect(parseGitVersion('git version 2.40.1')).toMatchObject({ major: 2, minor: 40, patch: 1 });
    expect(parseGitVersion('git version 2.39')).toMatchObject({ major: 2, minor: 39, patch: 0 });
  });
  it('throws on unparseable output', () => {
    expect(() => parseGitVersion('not git')).toThrow();
  });
});

describe('versionAtLeast', () => {
  const v = parseGitVersion('git version 2.38.1');
  it('compares major/minor/patch', () => {
    expect(versionAtLeast(v, 2, 38)).toBe(true);
    expect(versionAtLeast(v, 2, 38, 1)).toBe(true);
    expect(versionAtLeast(v, 2, 38, 2)).toBe(false);
    expect(versionAtLeast(v, 2, 40)).toBe(false);
    expect(versionAtLeast(v, 3, 0)).toBe(false);
    expect(versionAtLeast(v, 1, 99)).toBe(true);
  });
});

describe('capabilitiesFor', () => {
  it('gates merge-tree at 2.38', () => {
    expect(capabilitiesFor(parseGitVersion('git version 2.37.0'), 'linux').mergeTreeWriteTree).toBe(
      false,
    );
    expect(capabilitiesFor(parseGitVersion('git version 2.38.0'), 'linux').mergeTreeWriteTree).toBe(
      true,
    );
  });

  it('detects fsmonitor per platform floor', () => {
    const v = parseGitVersion('git version 2.40.0');
    expect(capabilitiesFor(v, 'win32').fsmonitor).toBe(true);
    expect(capabilitiesFor(v, 'darwin').fsmonitor).toBe(true);
    expect(capabilitiesFor(v, 'linux').fsmonitor).toBe(false);
    expect(capabilitiesFor(parseGitVersion('git version 2.55.0'), 'linux').fsmonitor).toBe(true);
    expect(capabilitiesFor(v, 'aix').fsmonitor).toBe(false);
    expect(FSMONITOR_FLOORS.linux).toEqual([2, 55]);
  });

  it('flags unsupported git below 2.38', () => {
    expect(capabilitiesFor(parseGitVersion('git version 2.30.0'), 'linux').supported).toBe(false);
    expect(capabilitiesFor(parseGitVersion('git version 2.53.0'), 'win32').supported).toBe(true);
  });
});

describe('detectGitCapabilities (real git)', () => {
  it('detects the installed git', async () => {
    const caps = await detectGitCapabilities();
    expect(caps.version.major).toBeGreaterThanOrEqual(2);
    expect(caps.mergeTreeWriteTree).toBe(true);
    expect(caps.supported).toBe(true);
  });
});
