import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { statusCardRoutes } from "../routes/status-cards.js";
import { withBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("status card compile supersede", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-status-cards-compile-supersede-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("cancels the in-flight compile task when a prompt edit supersedes it", async () => {
    const company = await db.insert(companies).values({ name: "Co", issuePrefix: `SC${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((rows) => rows[0]!);
    await instanceSettingsService(db).updateExperimental({ enableStatusCards: true });
    await db.insert(agents).values({
      companyId: company.id,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
      metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", statusCardRoutes(db, { heartbeat: { wakeup: async () => ({ queued: true }) } }));
    app.use(errorHandler);
    const created = await request(app).post(`/api/companies/${company.id}/status-cards`).send({ interestPrompt: "Blocked launch tasks" });
    const displacedIssueId = created.body.generatingIssueId as string;
    await issueService(db).update(displacedIssueId, { status: "in_progress" });

    const patched = await request(app).patch(`/api/status-cards/${created.body.id}`).send({ interestPrompt: "Done launch tasks" });

    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ state: "compiling", failureReason: null });
    expect(patched.body.generatingIssueId).not.toBe(displacedIssueId);
    expect(await db.select().from(issues).where(eq(issues.id, displacedIssueId)).then((rows) => rows[0]?.status)).toBe("cancelled");
    expect(await db.select().from(issues).where(eq(issues.id, patched.body.generatingIssueId)).then((rows) => rows[0]?.status)).toBe("todo");
  });
});
