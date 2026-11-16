import type { Pool } from 'pg';
import { makeId } from '@weft/protocol';

export interface World {
  orgId: string;
  teamId: string;
  projectA: string;
  projectB: string;
  adminUser: string;
  memberUser: string;
  viewerUser: string;
  deviceId: string;
}

/**
 * Seed a minimal identity graph directly (project/user provisioning is out of
 * M2.3 scope): one org/team, two projects, three users with distinct roles in
 * project A, and a device owned by the member. adminUser is also admin of B so
 * tests can prove a token bound to A cannot reach B even for a shared admin.
 */
export async function seedWorld(pool: Pool): Promise<World> {
  const orgId = makeId('organization');
  const teamId = makeId('team');
  const projectA = makeId('project');
  const projectB = makeId('project');
  const adminUser = makeId('user');
  const memberUser = makeId('user');
  const viewerUser = makeId('user');
  const deviceId = makeId('device');

  await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    orgId, 'Test Org', `org-${orgId}`,
  ]);
  await pool.query('INSERT INTO teams (id, org_id, name, slug) VALUES ($1, $2, $3, $4)', [
    teamId, orgId, 'Test Team', `team-${teamId}`,
  ]);
  for (const p of [projectA, projectB]) {
    await pool.query('INSERT INTO projects (id, team_id, name, slug) VALUES ($1, $2, $3, $4)', [
      p, teamId, 'Project', `proj-${p}`,
    ]);
  }
  for (const u of [adminUser, memberUser, viewerUser]) {
    await pool.query('INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)', [
      u, orgId, `${u}@test.local`,
    ]);
  }
  const members: [string, string][] = [
    [adminUser, 'admin'],
    [memberUser, 'member'],
    [viewerUser, 'viewer'],
  ];
  for (const [u, role] of members) {
    await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
      projectA, u, role,
    ]);
  }
  await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
    projectB, adminUser, 'admin',
  ]);
  await pool.query('INSERT INTO devices (id, user_id, hostname, os) VALUES ($1, $2, $3, $4)', [
    deviceId, memberUser, 'test-host', 'linux',
  ]);

  return { orgId, teamId, projectA, projectB, adminUser, memberUser, viewerUser, deviceId };
}