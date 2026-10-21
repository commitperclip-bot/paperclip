import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaceRepositoryAccess,
  executionWorkspaces, heartbeatRuns, issues, projects, projectAccessMembers, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let cwd: string;
const companyId = randomUUID(), agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID(), projectId = randomUUID();
const runIds = Array.from({ length: 64 }, () => randomUUID());
let workspaceId: string;

beforeAll(async () => {
  vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
  database = await startEmbeddedPostgresTestDatabase("root-reader-query-");
  db = createDb(database.connectionString);
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "root-reader-query-")));
  await db.insert(companies).values({ id: companyId, name: "Retained readers", issuePrefix: "RRQ" });
  await db.insert(authUsers).values({ id: userId, name: "Sponsor", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process" });
  await db.insert(companyMemberships).values([
    { companyId, principalType: "user", principalId: userId, membershipRole: "operator", status: "active" },
    { companyId, principalType: "agent", principalId: agentId, membershipRole: "member", status: "active" },
  ]);
  await db.insert(projects).values({ id: projectId, companyId, name: "Source" });
  const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId, cwd, name: "Task source", mode: "shared_workspace", strategyType: "operator_directory" }).returning();
  workspaceId = workspace.id;
  await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Task", assigneeAgentId: agentId, executionWorkspaceId: workspaceId });
  await db.insert(heartbeatRuns).values(runIds.map(id => ({ id, companyId, agentId, responsibleUserId: userId,
    status: "succeeded", contextSnapshot: { issueId }, resultJson: { unusedPayload: "x".repeat(65536) } })));
  const rootKey = createHash("sha256").update(cwd).digest("hex");
  await db.insert(executionWorkspaceRepositoryAccess).values(runIds.map(scopeId => ({ companyId, rootKey,
    canonicalCwd: cwd, kind: "reader", scopeId, issueId, agentId, responsibleUserId: userId })));
}, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.$client.end({ timeout: 0 });
  await database?.cleanup();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const input = () => ({ companyId, issueId, workspaceId, cwd, agentId, runId: runIds[0] });

it("bounds repeated-principal queries without loading retained run payloads", async () => {
  const queries: string[] = [];
  const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => queries.push(query) } }) as unknown as typeof db;
  await executionWorkspaceRepositoryService(recorded).guardForPublication(input());
  expect(queries.length).toBeLessThan(800);
  const runs = queries.filter(query => query.includes('from "heartbeat_runs"'));
  expect(runs.length).toBeGreaterThan(0);
  expect(runs.every(query => !query.includes('"result_json"') && !query.includes('"runner_profile_json"'))).toBe(true);
});

it("keeps each retained run identity and policy distinct for the same principals", async () => {
  const service = executionWorkspaceRepositoryService(db);
  const invalidId = runIds[31];
  try {
    await db.update(executionWorkspaceRepositoryAccess).set({ responsibleUserId: randomUUID() }).where(eq(executionWorkspaceRepositoryAccess.scopeId, invalidId));
    await expect(service.guardForPublication(input())).rejects.toThrow("identity");
    await db.update(executionWorkspaceRepositoryAccess).set({ responsibleUserId: userId }).where(eq(executionWorkspaceRepositoryAccess.scopeId, invalidId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, executionPolicy: { trustPreset: "unsupported" } } }).where(eq(heartbeatRuns.id, invalidId));
    await expect(service.guardForPublication(input())).rejects.toThrow();
  } finally {
    await db.update(executionWorkspaceRepositoryAccess).set({ responsibleUserId: userId }).where(eq(executionWorkspaceRepositoryAccess.scopeId, invalidId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId } }).where(eq(heartbeatRuns.id, invalidId));
  }
  await expect(service.guardForPublication(input())).resolves.toBeUndefined();
});

it("reloads project grants on every publication attempt", async () => {
  const service = executionWorkspaceRepositoryService(db);
  await db.update(projects).set({ visibility: "private" }).where(eq(projects.id, projectId));
  const grants = await db.insert(projectAccessMembers).values([
    { companyId, projectId, subjectType: "agent", subjectId: agentId },
    { companyId, projectId, subjectType: "user", subjectId: userId },
  ]).returning();
  try {
    await expect(service.guardForPublication(input())).resolves.toBeUndefined();
    await db.delete(projectAccessMembers).where(and(eq(projectAccessMembers.projectId, projectId), eq(projectAccessMembers.subjectType, "user")));
    await expect(service.guardForPublication(input())).rejects.toThrow();
  } finally {
    await db.delete(projectAccessMembers).where(inArray(projectAccessMembers.id, grants.map(grant => grant.id)));
    await db.update(projects).set({ visibility: "open" }).where(eq(projects.id, projectId));
  }
});

it("keeps supplied membership snapshots separate from fresh database snapshots", async () => {
  const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId, agentId,
    runId: runIds[0], onBehalfOfUserId: userId };
  const supplied = { ...actor, onBehalfOfMemberships: [{ companyId, membershipRole: "operator", status: "active" }] };
  const service = authorizationService(db);
  const resource = { type: "company" as const, companyId };
  await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
  try {
    for (const candidates of [[supplied, actor], [actor, supplied]]) {
      const decisions = await service.decideReadsForActors(candidates, [resource]);
      for (let index = 0; index < candidates.length; index++) {
        expect(decisions[index][0]).toEqual(await service.decide({ actor: { ...candidates[index] }, action: "company_scope:read", resource }));
        expect(decisions[index][0].code).toBe(candidates[index] === supplied
          ? "RESPONSIBLE_USER_UNAUTHORIZED" : "RESPONSIBLE_USER_UNAVAILABLE");
      }
    }
  } finally {
    await db.update(companyMemberships).set({ status: "active" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
  }
});

it("batches source retention and duplicate path reads without losing owners", async () => {
  const sourceIds = Array.from({ length: 501 }, () => randomUUID());
  await db.insert(executionWorkspaces).values(sourceIds.map(id => ({ id, companyId, projectId, cwd,
    sourceIssueId: issueId, name: "Shared source", mode: "shared_workspace", strategyType: "operator_directory" })));
  const queries: string[] = [];
  const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => queries.push(query) } }) as unknown as typeof db;
  const paths = vi.spyOn(fs, "realpath");
  try {
    await executionWorkspaceRepositoryService(recorded).guardForPublication(input());
    expect(queries.filter(query => query.startsWith('insert into "execution_workspace_repository_access"')).length).toBeLessThanOrEqual(2);
    expect(paths.mock.calls.length).toBeLessThanOrEqual(8);
  } finally {
    paths.mockRestore();
  }
  const retained = await db.select({ scopeId: executionWorkspaceRepositoryAccess.scopeId }).from(executionWorkspaceRepositoryAccess)
    .where(and(eq(executionWorkspaceRepositoryAccess.companyId, companyId),
      eq(executionWorkspaceRepositoryAccess.rootKey, createHash("sha256").update(cwd).digest("hex")),
      eq(executionWorkspaceRepositoryAccess.kind, "source")));
  expect(new Set(retained.map(row => row.scopeId))).toEqual(new Set([workspaceId, ...sourceIds]));
});
