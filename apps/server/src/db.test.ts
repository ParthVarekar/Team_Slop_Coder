import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_MIGRATIONS } from '@weft/core';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { withTransaction } from './pg.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
}, 90_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

describe('central database (real Postgres 16)', () => {
  it('applies the central migration exactly once', async () => {
    const res = await db.pool.query('SELECT id FROM schema_migrations ORDER BY id');
    expect(res.rows.map((r) => r.id)).toEqual(SERVER_MIGRATIONS.map((m) => m.id));
    // Re-opening is idempotent (no re-apply).
    const again = await openCentralDatabase(cluster.databaseUrl);
    const res2 = await again.pool.query('SELECT id FROM schema_migrations');
    expect(res2.rows).toHaveLength(SERVER_MIGRATIONS.length);
    await again.close();
  });

  it('creates the core coordination + governance tables', async () => {
    const res = await db.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = new Set(res.rows.map((r) => r.table_name as string));
    for (const t of [
      'events',
      'coordination_events',
      'project_stream_seq',
      'tasks',
      'task_events',
      'conflicts',
      'merge_queue_entries',
      'validation_runs',
      'check_results',
      'audit_records',
      'api_tokens',
      'project_members',
    ]) {
      expect(names.has(t), `missing table ${t}`).toBe(true);
    }
  });

  it('round-trips identity rows with foreign-key integrity', async () => {
    await db.pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)', [
      'org_1',
      'Org',
      'org',
    ]);
    await db.pool.query('INSERT INTO teams (id, org_id, name, slug) VALUES ($1,$2,$3,$4)', [
      'team_1',
      'org_1',
      'Team',
      'team',
    ]);
    await db.pool.query('INSERT INTO projects (id, team_id, name, slug) VALUES ($1,$2,$3,$4)', [
      'proj_1',
      'team_1',
      'Project',
      'project',
    ]);
    const res = await db.pool.query(
      'SELECT p.id, t.name AS team FROM projects p JOIN teams t ON t.id = p.team_id WHERE p.id = $1',
      ['proj_1'],
    );
    expect(res.rows[0]).toMatchObject({ id: 'proj_1', team: 'Team' });
    // FK violation is rejected.
    await expect(
      db.pool.query('INSERT INTO projects (id, team_id, name, slug) VALUES ($1,$2,$3,$4)', [
        'proj_bad',
        'team_missing',
        'Bad',
        'bad',
      ]),
    ).rejects.toThrow();
  });

  it('enforces effectively-once dedup on (device_id, event_id, received_at)', async () => {
    const sql = `INSERT INTO events
      (event_id, device_id, project_id, global_seq, ts, received_at, type, actor, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
    const args = [
      'evt_1',
      'dev_1',
      'proj_1',
      1,
      '2026-11-09T00:00:00Z',
      '2026-11-09T00:00:00Z',
      'tool.post',
      '{}',
      '{}',
    ];
    await db.pool.query(sql, args);
    await expect(db.pool.query(sql, args)).rejects.toThrow();
    const count = await db.pool.query('SELECT COUNT(*)::int AS c FROM events');
    expect(count.rows[0].c).toBe(1);
  });

  it('parses BIGINT global_seq as a number', async () => {
    await db.pool.query(
      'INSERT INTO project_stream_seq (project_id, last_seq, min_seq) VALUES ($1,$2,$3)',
      ['proj_seq', 9007199254740, 0],
    );
    const res = await db.pool.query('SELECT last_seq FROM project_stream_seq WHERE project_id=$1', [
      'proj_seq',
    ]);
    expect(typeof res.rows[0].last_seq).toBe('number');
    expect(res.rows[0].last_seq).toBe(9007199254740);
  });

  it('withTransaction commits on success and rolls back on error', async () => {
    await withTransaction(db.pool, async (client) => {
      await client.query('INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)', [
        'org_tx',
        'Tx',
        'org-tx',
      ]);
    });
    const ok = await db.pool.query("SELECT id FROM organizations WHERE id='org_tx'");
    expect(ok.rows).toHaveLength(1);

    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query('INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)', [
          'org_rb',
          'Rb',
          'org-rb',
        ]);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');
    const rb = await db.pool.query("SELECT id FROM organizations WHERE id='org_rb'");
    expect(rb.rows).toHaveLength(0);
  });
});
