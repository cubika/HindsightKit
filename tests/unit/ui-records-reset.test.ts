import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureQueueItemSchema } from "@provenloop/contracts";
import { createCaptureEnvelope } from "@provenloop/domain";
import { KnowledgeControlService } from "@provenloop/host";
import { recordsResetPendingPath, resolveWindowsProvenLoopLeaseName, resolveWindowsProvenLoopPaths, WindowsNamedPipeLeaseProvider } from "@provenloop/platform-windows";
import { CanonicalSqliteStore, readInspection } from "@provenloop/storage-sqlite";
import { createDefaultCopilotAdapterState, writeCopilotAdapterState } from "@provenloop/copilot-adapter";
import { startUiServer, type UiServer } from "../../packages/cli/src/run-ui.js";

const reset = vi.hoisted(() => vi.fn());
vi.mock("../../packages/cli/src/reset-records.js", () => ({ resetAllRecords: reset }));
const roots: string[] = []; const servers: UiServer[] = [];
afterEach(async () => {
  reset.mockReset();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) {
    const workspace = resolve(process.cwd()); const absolute = resolve(root);
    assert(absolute.startsWith(workspace + "/") || absolute.startsWith(workspace + "\\"));
    await rm(absolute, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const root = await mkdtemp(join(process.cwd(), ".ui-reset-test-")); roots.push(root);
  const paths = resolveWindowsProvenLoopPaths(root); await mkdir(paths.data, { recursive: true }); await writeFile(paths.rootMarker, JSON.stringify({ schemaVersion: 1, product: "ProvenLoop", root: paths.root }));
  const store = new CanonicalSqliteStore(paths.database);
  try {
    await new KnowledgeControlService({ store, projection: { acquireLease: async () => ({ release: async () => undefined }), rebuild: async () => undefined } }).remember({ content: "Use focused package tests.", appliesWhen: ["Changing source code."], scope: "personal" });
    const timestamp = new Date().toISOString();
    const envelope = createCaptureEnvelope({ adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: "reset-ui-source", sessionId: "reset-ui-session", timestamp, eventType: "prompt.submitted", trust: "user", content: { message: "UI_RESET_CAPTURED_TEXT" } });
    store.ingestQueueItem(captureQueueItemSchema.parse({ schemaVersion: 1, queueItemId: "reset-ui-queue", state: "pending", attemptCount: 0, failureCount: 0, createdAt: timestamp, updatedAt: timestamp, envelope }));
  } finally { store.close(); }
  const state = createDefaultCopilotAdapterState(new Date()); await writeCopilotAdapterState(paths.adapterState, state);
  const server = await startUiServer({ dataRoot: root }); servers.push(server); return { root, paths, server };
};
const formFrom = async (server: UiServer) => {
  const response = await fetch(server.url); const html = await response.text(); expect(response.status, html).toBe(200);
  const csrf = html.match(/name="csrf" value="([a-f0-9]{64})"/u)?.[1]; assert(csrf);
  return { html, form: new URLSearchParams({ csrf, confirmed: "clear", confirmationText: "CLEAR" }) };
};
const post = (server: UiServer, form: URLSearchParams, headers: Record<string, string> = {}) => fetch(`${server.url}records/reset`, { method: "POST", redirect: "manual", headers: { origin: new URL(server.url).origin, "sec-fetch-site": "same-origin", ...headers }, body: form });

describe("clear all records in the local UI", () => {
  it("shows the selected data location, record counts and permanent-clear confirmation without writes on GET", async () => {
    const { paths, server } = await fixture(); const before = await readFile(paths.database); const { html, form } = await formFrom(server);
    for (const copy of ["Danger zone", "Clear all records", "Type CLEAR to confirm", "Captured events", "Knowledge cards", "Learning jobs", "Work episodes", "Usage records", "capability settings", "Copilot conversation history", "repository files", "Restart Copilot", paths.root]) expect(html).toContain(copy);
    expect(html).toContain('name="confirmed" value="clear" required');
    expect(html).toContain('name="confirmationText" required pattern="CLEAR"');
    expect((await fetch(`${server.url}records/reset?${form.toString()}`)).status).toBe(404);
    expect(reset).not.toHaveBeenCalled(); expect(await readFile(paths.database)).toEqual(before);
  });

  it("rejects missing confirmation, duplicate fields, foreign origin, invalid CSRF and oversized reset requests", async () => {
    const { paths, server } = await fixture(); const before = await readFile(paths.database); const { form } = await formFrom(server);
    for (const field of ["confirmationText", "confirmed"]) { const invalid = new URLSearchParams(form); invalid.delete(field); expect((await post(server, invalid)).status).toBe(400); }
    const wrong = new URLSearchParams(form); wrong.set("confirmationText", "clear"); expect((await post(server, wrong)).status).toBe(400);
    const duplicate = new URLSearchParams(form); duplicate.append("confirmed", "clear"); expect((await post(server, duplicate)).status).toBe(400);
    const extra = new URLSearchParams(form); extra.set("dataRoot", "C:/somewhere-else"); expect((await post(server, extra)).status).toBe(400);
    const csrf = new URLSearchParams(form); csrf.set("csrf", "a".repeat(64)); expect((await post(server, csrf)).status).toBe(403);
    expect((await fetch(`${server.url}records/reset`, { method: "POST", body: form })).status).toBe(403);
    expect((await post(server, form, { origin: "https://foreign.example" })).status).toBe(403);
    const large = new URLSearchParams(form); large.set("confirmationText", "x".repeat(33_000)); expect((await post(server, large)).status).toBe(413);
    expect(reset).not.toHaveBeenCalled(); expect(await readFile(paths.database)).toEqual(before);
  });

  it("allows a pending reset to retry before ordinary UI leases and keeps other pages unavailable", async () => {
    const { paths, server, root } = await fixture(); const { form } = await formFrom(server);
    const marker = recordsResetPendingPath(root); await mkdir(dirname(marker), { recursive: true }); await writeFile(marker, "{}");
    const page = await fetch(server.url); const html = await page.text(); expect(page.status).toBe(503); expect(html).toContain("Record cleanup pending"); expect(html).not.toContain("UI_RESET_CAPTURED_TEXT"); expect(html).toContain("records/reset");
    reset.mockRejectedValueOnce(new Error("Partial reset; retry to finish cleanup."));
    const failure = await post(server, form); expect(failure.status).toBe(409); expect(await failure.text()).toContain("Partial reset");
    reset.mockImplementationOnce(async () => {
      const leases = [];
      try {
        for (const [leaseRoot, purpose] of [[root, "knowledge-projection"], [dirname(paths.database), "canonical-restore"]] as const) {
          const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(leaseRoot, purpose)).tryAcquire(); assert(lease, "The UI must not hold reset storage leases"); leases.push(lease);
        }
        await rm(marker); return { status: "cleared" };
      } finally { for (const lease of leases.reverse()) await lease.release(); }
    });
    const response = await post(server, form); expect(response.status, await response.text()).toBe(303);
    expect(reset).toHaveBeenLastCalledWith({ dataRoot: paths.root, confirmed: true, confirmationText: "CLEAR" });
    expect(response.headers.get("location")).toBe(new URL(server.url).pathname + "?notice=cleared");
  });

  it("clears a real temporary installation through the reset service and preserves its settings", async () => {
    const { paths, server } = await fixture(); const { form } = await formFrom(server);
    const state = await readFile(paths.adapterState); const marker = await readFile(paths.rootMarker);
    const actual = await vi.importActual<typeof import("../../packages/cli/src/reset-records.js")>("../../packages/cli/src/reset-records.js");
    reset.mockImplementationOnce(actual.resetAllRecords);
    const response = await post(server, form); expect(response.status, await response.text()).toBe(303);
    expect(readInspection(paths.database, (reader) => reader.summary().counts)).toEqual({ knowledge: 0, events: 0, jobs: 0, usage: 0, episodes: 0 });
    expect(await readFile(paths.adapterState)).toEqual(state); expect(await readFile(paths.rootMarker)).toEqual(marker);
    const overview = await fetch(new URL(response.headers.get("location") ?? "", server.url)); const html = await overview.text();
    expect(overview.status, html).toBe(200); expect(html).toContain("All ProvenLoop records were cleared"); expect(html).toContain("Restart Copilot");
  });
});
