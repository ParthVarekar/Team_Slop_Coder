import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/** Parse `git version 2.53.0.windows.2` → { major: 2, minor: 53, patch: 0 }. */
export function parseGitVersion(output: string): GitVersion {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) {
    throw new Error(`git: unable to parse version from: ${output.trim()}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
    raw: output.trim(),
  };
}

export function versionAtLeast(v: GitVersion, major: number, minor: number, patch = 0): boolean {
  if (v.major !== major) return v.major > major;
  if (v.minor !== minor) return v.minor > minor;
  return v.patch >= patch;
}

/** Built-in fsmonitor daemon floors by platform (documented in the perf plan). */
export const FSMONITOR_FLOORS: Partial<Record<NodeJS.Platform, [number, number]>> = {
  win32: [2, 36],
  darwin: [2, 37],
  linux: [2, 55],
};

export interface GitCapabilities {
  version: GitVersion;
  platform: NodeJS.Platform;
  /** `git merge-tree --write-tree` (ort, in-core merge) — floor 2.38. */
  mergeTreeWriteTree: boolean;
  /** Built-in fsmonitor daemon available on this platform/version. */
  fsmonitor: boolean;
  worktree: boolean;
  rerere: boolean;
  /** `--force-with-lease=<ref>:<old>` compare-and-swap push. */
  forceWithLease: boolean;
  /** Minimum git version we support at all. */
  supported: boolean;
}

export const MIN_SUPPORTED_GIT: [number, number] = [2, 38];

export function capabilitiesFor(version: GitVersion, platform: NodeJS.Platform): GitCapabilities {
  const floor = FSMONITOR_FLOORS[platform];
  const fsmonitor = floor ? versionAtLeast(version, floor[0], floor[1]) : false;
  return {
    version,
    platform,
    mergeTreeWriteTree: versionAtLeast(version, 2, 38),
    fsmonitor,
    worktree: versionAtLeast(version, 2, 5),
    rerere: versionAtLeast(version, 2, 0),
    forceWithLease: versionAtLeast(version, 1, 8, 5),
    supported: versionAtLeast(version, MIN_SUPPORTED_GIT[0], MIN_SUPPORTED_GIT[1]),
  };
}

export interface DetectGitOptions {
  binary?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
}

/** Run `git --version` and derive the capability matrix. */
export async function detectGitCapabilities(
  options: DetectGitOptions = {},
): Promise<GitCapabilities> {
  const binary = options.binary ?? 'git';
  const platform = options.platform ?? process.platform;
  const { stdout } = await execFileAsync(binary, ['--version'], {
    cwd: options.cwd,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return capabilitiesFor(parseGitVersion(stdout), platform);
}
