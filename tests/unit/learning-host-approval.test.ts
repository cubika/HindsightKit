import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasCopilotLearningHookApproval, getCopilotAutomaticLearningHostCapability } from "../../packages/copilot-adapter/src/automatic-host-capability.js";

describe("repository-scoped native hook approval", () => {
  it("requires the exact verified host, repository and extension permission", async () => {
    const home = await mkdtemp(join(tmpdir(), "provenloop-hook-approval-"));
    const cwd = join(home, "repository");
    const path = join(home, "permissions-config.json");
    try {
      expect(await hasCopilotLearningHookApproval(home, cwd, "1.0.84-1")).toBe(false);
      await writeFile(path, JSON.stringify({ locations: { [cwd]: { tool_approvals: [
        { kind: "extension-permission-access", extensionName: "plugin:provenloop:event-capture" },
      ] } } }));
      expect(await hasCopilotLearningHookApproval(home, cwd, "1.0.84-1")).toBe(true);
      expect(await hasCopilotLearningHookApproval(home, join(cwd, "nested"), "1.0.84-1")).toBe(false);
      expect(await hasCopilotLearningHookApproval(home, cwd, "1.0.85-1")).toBe(false);
      await writeFile(path, JSON.stringify({ locations: { [cwd]: { tool_approvals: [
        { kind: "extension-permission-access", extensionName: "other" },
      ] } } }));
      expect(await hasCopilotLearningHookApproval(home, cwd, "1.0.84-1")).toBe(false);
      await writeFile(path, "invalid");
      expect(await hasCopilotLearningHookApproval(home, cwd, "1.0.84-1")).toBe(false);
      expect(getCopilotAutomaticLearningHostCapability("1.0.85-1").status).toBe("unverified");
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
