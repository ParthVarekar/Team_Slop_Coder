import { z } from 'zod';
import {
  DeviceIdSchema,
  ProjectIdSchema,
  RepoIdSchema,
  SessionIdSchema,
  TaskIdSchema,
  UlidSchema,
} from './ids.js';

export const PROTOCOL_VERSION = 1 as const;

export const PrivacySchema = z.enum(['metadata', 'full']);
export type Privacy = z.infer<typeof PrivacySchema>;

/** Adapter telemetry fidelity, declared in the capability manifest. */
export const FidelitySchema = z.enum(['high', 'medium', 'low']);
export type Fidelity = z.infer<typeof FidelitySchema>;

export const AgentInfoSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  adapter: z.string().min(1),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

/** Human-driven activity (agent may be null for watcher/git-sourced human edits). */
export const HumanActorSchema = z.object({
  user_id: z.string().min(1),
  agent: AgentInfoSchema.nullable(),
});

/** Platform-internal activity (indexer, validator, shipper, ...). */
export const SystemActorSchema = z.object({
  system: z.string().min(1),
});

export const ActorSchema = z.union([HumanActorSchema, SystemActorSchema]);
export type Actor = z.infer<typeof ActorSchema>;

export function isSystemActor(actor: Actor): actor is z.infer<typeof SystemActorSchema> {
  return 'system' in actor;
}

/**
 * Client envelope. `type` is an open string for forward compatibility; known
 * types are validated against the catalog, unknown types are stored verbatim.
 * `payload` is preserved as received (additive fields survive round-trips).
 */
export const EventEnvelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  event_id: UlidSchema,
  device_id: DeviceIdSchema,
  project_id: ProjectIdSchema,
  repo_id: RepoIdSchema.optional(),
  session_id: SessionIdSchema.optional(),
  provider_session_id: z.string().min(1).optional(),
  task_id: TaskIdSchema.optional(),
  seq: z.number().int().nonnegative().optional(),
  ts: z.string().datetime({ offset: true }),
  type: z.string().min(1),
  actor: ActorSchema,
  privacy: PrivacySchema,
  payload: z.record(z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Server-augmented event (client fields are never mutated). */
export const StoredEventSchema = EventEnvelopeSchema.extend({
  global_seq: z.number().int().nonnegative(),
  received_at: z.string().datetime({ offset: true }),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;
