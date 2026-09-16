import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import {
  CopilotCliAdapter,
  createDefaultCopilotAdapterState,
  TrustedSessionContextPublisher,
  writeCopilotAdapterState,
} from "@provenloop/copilot-adapter";
import { runMcpServer } from "@provenloop/cli";
import { KnowledgeControlService } from "@provenloop/host";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";
import {
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

import { contextWithDeadlineRetries } from "./context-with-deadline-retries.js";

const execute = promisify(execFile);
type Reply = Readonly<Record<string, unknown>>;

const object = (value: unknown): Reply => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an MCP response object.");
  }
  return value as Reply;
};

const text = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Expected an MCP response string.");
  }
  return value;
};

const connect = async (dataRoot: string) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<number, (reply: Reply) => void>();
  let nextId = 0;
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let end = buffered.indexOf("\n");
    while (end >= 0) {
      const message = object(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
      const id = Number(message.id);
      pending.get(id)?.(object(message.result ?? message.error));
      pending.delete(id);
      end = buffered.indexOf("\n");
    }
  });
  // No handlers, identity provider, cwd, or Session override: use the production resolver.
  const running = runMcpServer({ input, output }, { dataRoot });
  const request = async (method: string, params: Reply) => {
    const id = nextId += 1;
    const result = new Promise<Reply>((resolve) => pending.set(id, resolve));
    input.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
    const reply = await result;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return reply;
  };
  const initialized = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "registry-boundary-fixture", version: "1" },
  });
  expect(initialized.instructions).toEqual(expect.stringContaining("new coding task"));
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    call: (name: string, args: Reply) => request("tools/call", { name, arguments: args }),
    close: async () => {
      input.end();
      await running;
      output.destroy();
    },
  };
};

const contextWhenReady = async (
  client: Awaited<ReturnType<typeof connect>>,
): Promise<Reply> => contextWithDeadlineRetries(async () =>
  object((await client.call("provenloop_context", {
    prompt: "Run focused tests",
    tokenBudget: 600,
  })).structuredContent),
);

export const registerMcpRegistryTests = (target: string): void => {
  describe(`production MCP registry boundary (${target})`, () => {
    it("uses the live SDK publisher independently of capture and invalidates consent on user/workspace changes", async () => {
      const root = await mkdtemp(join(process.cwd(), ".r4-mcp-registry-"));
      const dataRoot = join(root, "data-root");
      const paths = resolveWindowsProvenLoopPaths(dataRoot);
      const sessionId = `sdk-session-${randomUUID()}`;
      const previousSessionId = process.env.SESSION_ID;
      const clients: Awaited<ReturnType<typeof connect>>[] = [];
      const publisherErrors: unknown[] = [];
      let publisher: TrustedSessionContextPublisher | undefined;
      let store: CanonicalSqliteStore | undefined;
      let backend: SqliteFtsKnowledgeBackend | undefined;
      try {
        await mkdir(paths.data, { recursive: true });
        await writeFile(paths.rootMarker, JSON.stringify({
          product: "ProvenLoop",
          root: paths.root,
          schemaVersion: 1,
        }), "utf8");
        const state = createDefaultCopilotAdapterState(new Date());
        await writeCopilotAdapterState(paths.adapterState, {
          ...state,
          installed: true,
          pluginInstalled: true,
          pluginEnabled: true,
          detectedCopilotVersion: "1.0.82-0",
          capabilities: { ...state.capabilities, retrieval: { enabled: true } },
        });
        const repoOne = join(root, "repo-one");
        const repoTwo = join(root, "repo-two");
        await execute("git", ["init", "--quiet", repoOne]);
        await execute("git", ["init", "--quiet", repoTwo]);
        const adapter = new CopilotCliAdapter({ dataRoot });
        const identityOne = await adapter.resolveSession({
          adapterVersion: "1.0.82-0",
          cwd: repoOne,
          sessionId,
        });
        const identityTwo = await adapter.resolveSession({
          adapterVersion: "1.0.82-0",
          cwd: repoTwo,
          sessionId,
        });
        if (identityOne.repositoryId === undefined || identityTwo.repositoryId === undefined) {
          throw new Error("The registry fixture needs two real Git repository identities.");
        }
        expect(identityOne.repositoryId).not.toBe(identityTwo.repositoryId);
        store = new CanonicalSqliteStore(paths.database);
        backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
        const projection = new KnowledgeProjectionManager({ backend, store });
        const control = new KnowledgeControlService({
          store,
          projection: {
            acquireLease: async () => ({ release: async () => undefined }),
            rebuild: () => projection.rebuild().then(() => undefined),
          },
        });
        const one = await control.remember({
          content: "Run focused tests for repository one.",
          appliesWhen: ["Changing code."],
          scope: "repository",
          scopeId: identityOne.repositoryId,
        });
        const two = await control.remember({
          content: "Run focused tests for repository two.",
          appliesWhen: ["Changing code."],
          scope: "repository",
          scopeId: identityTwo.repositoryId,
        });
        const firstId = text(one.candidate?.knowledgeId);
        const secondId = text(two.candidate?.knowledgeId);
        await backend.closeAsync();
        backend = undefined;
        store.close();
        store = undefined;

        delete process.env.SESSION_ID;
        const unidentified = await connect(dataRoot);
        clients.push(unidentified);
        const missingSession = object((await unidentified.call("provenloop_context", {
          prompt: "Run focused tests",
          tokenBudget: 600,
        })).structuredContent);
        expect(missingSession).toMatchObject({ status: "degraded", items: [], statusDetail: expect.stringContaining("[session_id_missing]") });

        process.env.SESSION_ID = sessionId;
        const client = await connect(dataRoot);
        clients.push(client);
        expect(object((await client.call("provenloop_context", {
          prompt: "Run focused tests",
          tokenBudget: 600,
        })).structuredContent)).toMatchObject({ status: "degraded", items: [], statusDetail: expect.stringContaining("[session_producer_inactive]") });
        publisher = new TrustedSessionContextPublisher({
          cwd: repoOne,
          repositoryId: identityOne.repositoryId,
          repositoryState: "known_repo",
          dataRoot,
          sessionId,
          onError: (error) => publisherErrors.push(error),
        });
        await publisher.start();
        const first = await contextWhenReady(client);
        expect(first, JSON.stringify(first)).toMatchObject({
          status: "ok",
          items: [expect.objectContaining({ id: firstId })],
        });
        const feedback = {
          action: "helpful",
          requestId: text(first.requestId),
          targetRef: { kind: "knowledge", id: firstId },
          userReportedApplied: true,
        };
        const challenge = object((await client.call("provenloop_feedback", feedback)).structuredContent);
        expect(challenge.status).toBe("confirmation_required");
        const confirmation = `确认 ${text(challenge.confirmationCode)}`;
        publisher.observeUserMessage({
          eventId: "sdk-user-approval",
          text: confirmation,
          timestamp: new Date().toISOString(),
        });
        await publisher.flush();
        publisher.beginWorkspaceRefresh();
        await publisher.flush();
        const refreshing = object((await client.call("provenloop_context", {
          prompt: "Run focused tests",
          tokenBudget: 600,
        })).structuredContent);
        expect(refreshing).toMatchObject({ status: "degraded", items: [], statusDetail: expect.stringContaining("[workspace_refreshing]") });
        expect((await client.call("provenloop_feedback", feedback)).isError).toBe(true);
        publisher.updateWorkspace({
          cwd: repoOne,
          repositoryId: identityOne.repositoryId,
          repositoryState: "known_repo",
        });
        await publisher.flush();
        const ordinaryPrompt = "An ordinary user prompt must not be copied into the registry.";
        publisher.observeUserMessage({
          eventId: "sdk-user-withdrawal",
          text: ordinaryPrompt,
          timestamp: new Date().toISOString(),
        });
        await publisher.flush();
        const registryDirectory = join(paths.data, "session-context");
        const registryFiles = await readdir(registryDirectory);
        const registryBody = (await Promise.all(registryFiles.map((file) =>
          readFile(join(registryDirectory, file), "utf8"),
        ))).join("\n");
        expect(registryBody).not.toContain(ordinaryPrompt);
        const withdrawn = object((await client.call("provenloop_feedback", feedback)).structuredContent);
        expect(withdrawn.status).toBe("confirmation_required");
        expect(withdrawn.confirmationCode).toBe(challenge.confirmationCode);

        publisher.observeUserMessage({
          eventId: "sdk-user-approved-again",
          text: confirmation,
          timestamp: new Date().toISOString(),
        });
        await publisher.flush();
        expect(object((await client.call("provenloop_feedback", feedback)).structuredContent))
          .toMatchObject({
            status: "recorded",
            adoption: "user_reported",
            outcome: "unknown",
          });
        store = new CanonicalSqliteStore(paths.database);
        expect(store.feedbackEvents(firstId)).toEqual([
          expect.objectContaining({ source: "user", evidenceRef: "sdk-user-approved-again" }),
        ]);
        expect(store.contextUseRecords(sessionId).find((record) =>
          record.requestId === first.requestId,
        )).toMatchObject({
          appliedKnowledgeIds: [`knowledge:${firstId}`],
          repoId: identityOne.repositoryId,
          retrievalStatus: "provided",
        });
        expect(store.contextUseRecords(sessionId)).toContainEqual(
          expect.objectContaining({
            retrievalStatus: "degraded",
            returnedKnowledgeIds: [],
          }),
        );
        store.close();
        store = undefined;

        publisher.updateWorkspace({
          cwd: repoTwo,
          repositoryId: identityTwo.repositoryId,
          repositoryState: "known_repo",
        });
        await publisher.flush();
        const second = await contextWhenReady(client);
        expect(second, JSON.stringify(second)).toMatchObject({
          status: "ok",
          items: [expect.objectContaining({ id: secondId })],
        });
        expect((await client.call("provenloop_context", {
          cwd: repoOne,
          sessionId: "model-invented",
          prompt: "Run focused tests",
          tokenBudget: 600,
        })).isError).toBe(true);
        publisher.updateWorkspace({ cwd: repoTwo, repositoryState: "known_outside_repo" });
        await publisher.flush();
        const outsideRepository = await contextWhenReady(client);
        expect(outsideRepository, JSON.stringify(outsideRepository))
          .toMatchObject({ status: "ok", items: [] });
        publisher.observeUserMessage({
          eventId: "sdk-user-old-workspace-code",
          text: confirmation,
          timestamp: new Date().toISOString(),
        });
        await publisher.flush();
        const movedChallenge = object((await client.call("provenloop_feedback", feedback)).structuredContent);
        expect(movedChallenge.status).toBe("confirmation_required");
        expect(movedChallenge.confirmationCode).not.toBe(challenge.confirmationCode);
        await publisher.stop();
        publisher = undefined;
        expect(object((await client.call("provenloop_context", {
          prompt: "Run focused tests",
          tokenBudget: 600,
        })).structuredContent)).toMatchObject({ status: "degraded", items: [] });
        expect(publisherErrors).toEqual([]);
        const logBody = await readFile(join(paths.logs, "mcp.jsonl"), "utf8");
        const logEntries = logBody.trim().split("\n").map((line) => object(JSON.parse(line)));
        expect(logEntries).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: "trusted_identity_unavailable", reason: "session_id_missing", requestId: missingSession.requestId }),
          expect.objectContaining({ event: "trusted_identity_unavailable", reason: "workspace_refreshing", requestId: refreshing.requestId }),
          expect.objectContaining({ event: "trusted_identity_recovered", previousReason: "session_producer_inactive" }),
          expect.objectContaining({ event: "trusted_identity_recovered", previousReason: "workspace_refreshing" }),
        ]));
        expect(new Set(logEntries.filter((entry) => entry.sessionHash !== undefined).map((entry) => entry.sessionHash)).size).toBe(1);
        for (const privateValue of [sessionId, ordinaryPrompt, confirmation, repoOne, repoTwo, "Run focused tests"]) {
          expect(logBody).not.toContain(privateValue);
        }
      } finally {
        for (const client of clients) {
          await client.close();
        }
        await publisher?.stop();
        await backend?.closeAsync();
        store?.close();
        if (previousSessionId === undefined) {
          delete process.env.SESSION_ID;
        } else {
          process.env.SESSION_ID = previousSessionId;
        }
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 50,
        });
      }
    });
  });
};
