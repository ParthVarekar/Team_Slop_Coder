import type { z } from 'zod';
import type {
  ConflictKindSchema,
  ConflictSeveritySchema,
  ConflictStateSchema,
} from './catalog.js';

export type ConflictKind = z.infer<typeof ConflictKindSchema>;
export type ConflictSeverity = z.infer<typeof ConflictSeveritySchema>;
export type ConflictState = z.infer<typeof ConflictStateSchema>;

/**
 * Normalize a repo-relative path for canonical identity: forward slashes, no
 * leading/trailing separators. Two daemons on different OSes must agree on the
 * same logical path so their conflict cards dedup.
 */
export function normalizeConflictPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Deterministic, collision-free identity for a logical conflict: kind + the
 * sorted unique task set + the sorted unique normalized path set. Independent of
 * detection order, duplicate entries, path separators, or which daemon observed
 * it. The server mints one card per key and unions evidence across detections.
 * Severity and branches are deliberately excluded — they are card properties,
 * not identity, so a warning escalating to blocking stays the same conflict.
 */
export function canonicalConflictKey(
  kind: ConflictKind,
  taskIds: readonly string[],
  paths: readonly string[],
): string {
  const tasks = [...new Set(taskIds)].sort();
  const normalized = [...new Set(paths.map(normalizeConflictPath))].sort();
  return JSON.stringify([kind, tasks, normalized]);
}