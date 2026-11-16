import { z } from 'zod';
import { ulid, ULID_REGEX } from './ulid.js';

/** Canonical id prefixes used across the data model. */
export const ID_PREFIXES = {
  organization: 'org',
  team: 'team',
  user: 'user',
  device: 'dev',
  project: 'proj',
  repo: 'repo',
  workspace: 'ws',
  session: 'ses',
  task: 'task',
  provider: 'prov',
  validation: 'val',
  conflict: 'conf',
  merge: 'mq',
  reservation: 'res',
  notification: 'ntf',
  baseline: 'base',
  regression: 'reg',
  comment: 'cmt',
  audit: 'aud',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** A bare ULID (used for event_id). */
export const UlidSchema = z.string().regex(ULID_REGEX, 'expected a ULID');

export function prefixedIdSchema(kind: IdKind): z.ZodString {
  const prefix = ID_PREFIXES[kind];
  return z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, 'i'));
}

export function makeId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

export const OrganizationIdSchema = prefixedIdSchema('organization');
export const TeamIdSchema = prefixedIdSchema('team');
export const UserIdSchema = prefixedIdSchema('user');
export const DeviceIdSchema = prefixedIdSchema('device');
export const ProjectIdSchema = prefixedIdSchema('project');
export const RepoIdSchema = prefixedIdSchema('repo');
export const WorkspaceIdSchema = prefixedIdSchema('workspace');
export const SessionIdSchema = prefixedIdSchema('session');
export const TaskIdSchema = prefixedIdSchema('task');
export const ValidationRunIdSchema = prefixedIdSchema('validation');
export const ConflictIdSchema = prefixedIdSchema('conflict');
export const MergeEntryIdSchema = prefixedIdSchema('merge');

export type OrganizationId = z.infer<typeof OrganizationIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;
export type DeviceId = z.infer<typeof DeviceIdSchema>;
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type RepoId = z.infer<typeof RepoIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
