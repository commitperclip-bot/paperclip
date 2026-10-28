import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

class FakeRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

async function runWithEnsureSessionError(error: Error, env: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-request-error-"));
  tempRoots.push(root);
  const logs: Array<{ stream: string; text: string }> = [];
  const execute = createAcpxEngineExecutor({
    createRuntime: () =>
      ({
        ensureSession: async () => {
          throw error;
        },
        startTurn: () => ({
          events: (async function* () {})(),
          result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
          cancel: async () => {},
        }),
        close: async () => {},
      }) as never,
  });
  const result = await execute({
    runId: "run-request-error",
    agent: { id: "agent-1", companyId: "company-1" },
    runtime: {},
    config: { agent: "custom", agentCommand: "node ./fake-acp.js", stateDir: path.join(root, "state"), env },
    context: {},
    onLog: async (stream: "stdout" | "stderr", text: string) => {
      logs.push({ stream, text });
    },
    onMeta: async () => {},
  } as never);
  return { result, logs };
}

describe("ACP request error details", () => {
  it("keeps data.details and the numeric JSON-RPC code in the error, summary, and acpx.error log", async () => {
    const { result, logs } = await runWithEnsureSessionError(
      new FakeRequestError(-32603, "Internal error", { details: "Invalid session configuration" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("acpx_session_init_failed");
    expect(result.errorMessage).toBe("Internal error\nInvalid session configuration");
    expect(result.summary).toBe("Internal error\nInvalid session configuration");
    expect(result.errorMeta?.rpcCode).toBe(-32603);
    const errorLogLine = logs.find((entry) => entry.stream === "stdout" && entry.text.includes("\"type\":\"acpx.error\""));
    expect(errorLogLine).toBeTruthy();
    const errorPayload = JSON.parse(errorLogLine!.text.trim());
    expect(errorPayload.message).toBe("Internal error\nInvalid session configuration");
    expect(errorPayload.rpcCode).toBe(-32603);
  });

  it("keeps data.message and string data", async () => {
    const { result: messageResult } = await runWithEnsureSessionError(
      new FakeRequestError(-32603, "Internal error", { message: "model_context_window must be a number" }),
    );
    expect(messageResult.errorMessage).toBe("Internal error\nmodel_context_window must be a number");

    const { result: stringResult } = await runWithEnsureSessionError(
      new FakeRequestError(-32602, "Invalid params", "model_context_window: invalid type"),
    );
    expect(stringResult.errorMessage).toBe("Invalid params\nmodel_context_window: invalid type");
    expect(stringResult.errorMeta?.rpcCode).toBe(-32602);
  });

  it("redacts configured secrets from the request error details", async () => {
    const { result, logs } = await runWithEnsureSessionError(
      new FakeRequestError(-32603, "Internal error", { details: "rejected value super-secret-value" }),
      { CUSTOM_TOKEN: "super-secret-value" },
    );

    expect(result.errorMessage).toContain("Internal error\nrejected value");
    expect(result.errorMessage).not.toContain("super-secret-value");
    expect(result.summary).not.toContain("super-secret-value");
    expect(logs.some((entry) => entry.text.includes("super-secret-value"))).toBe(false);
  });

  it("does not repeat details already in the message and leaves plain errors unchanged", async () => {
    const { result: repeated } = await runWithEnsureSessionError(
      new FakeRequestError(-32603, "Internal error: Invalid session configuration", { details: "Invalid session configuration" }),
    );
    expect(repeated.errorMessage).toBe("Internal error: Invalid session configuration");

    const { result: plain } = await runWithEnsureSessionError(new Error("session/new failed"));
    expect(plain.errorMessage).toBe("session/new failed");
    expect(plain.summary).toBe("session/new failed");
    expect(plain.errorMeta?.rpcCode).toBeUndefined();
  });
});
