import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultCopilotAdapterState, readCopilotAdapterState, writeCopilotAdapterState,
  clearExperimentalSettingState, setPersistedCapability } from "../../packages/copilot-adapter/src/operational-state.js";
import { runCli } from "../../packages/cli/src/run-cli.js";

describe("automatic learning preferences and host approval", () => {
  it("requires explicit scoped approval before granting native host hooks", async () => {
    const messages: string[] = [];
    expect(await runCli(["learning", "approve-hooks", "--cwd", process.cwd()],
      { log: (m) => messages.push(m), error: (m) => messages.push(m) })).toBe(2);
    expect(messages.join(" ")).toContain("access to Copilot session hooks");
    expect(messages.join(" ")).toContain("--confirm");
  });
  it("preserves historical acknowledgements without fabricating consent for legacy state", async () => {
    const root = await mkdtemp(join(tmpdir(), "provenloop-consent-"));
    const path = join(root, "state.json");
    const now = new Date("2026-09-07T00:00:00Z");
    try {
      const legacy = setPersistedCapability(createDefaultCopilotAdapterState(now), "correction_learning", { enabled: true }, now);
      await writeCopilotAdapterState(path, legacy);
      expect((await readCopilotAdapterState(path, now)).automaticLearning).toBeUndefined();
      const automaticLearning = { consentedAt: now.toISOString(), disclosureVersion: 1 as const, enabled: true, notificationsEnabled: false };
      await writeCopilotAdapterState(path, { ...legacy, automaticLearning });
      const state = await readCopilotAdapterState(path, now);
      expect(clearExperimentalSettingState(state, now).automaticLearning).toEqual(automaticLearning);
      expect(setPersistedCapability(state, "capture", { enabled: false }, now).automaticLearning).toEqual(automaticLearning);
      await writeFile(path, JSON.stringify({ ...state, automaticLearning: { ...automaticLearning, disclosureVersion: 2 } }));
      await expect(readCopilotAdapterState(path, now)).rejects.toThrow("malformed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
