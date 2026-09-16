import {
  isSupportedCopilotCliVersion,
  isVerifiedCopilotCliVersion,
  parseCopilotCliVersion,
  SUPPORTED_COPILOT_CLI_VERSION_RANGE,
} from "@provenloop/contracts";
import { describe, expect, it } from "vitest";

describe("Copilot CLI version compatibility", () => {
  it("accepts every released version at or above the command baseline", () => {
    expect(SUPPORTED_COPILOT_CLI_VERSION_RANGE).toBe(">=1.0.71");
    expect(isSupportedCopilotCliVersion("1.0.71")).toBe(true);
    expect(isSupportedCopilotCliVersion("1.0.71-0")).toBe(true);
    expect(isSupportedCopilotCliVersion("1.0.83-4")).toBe(true);
    expect(isSupportedCopilotCliVersion("1.1.0")).toBe(true);
    expect(isSupportedCopilotCliVersion("2.0.0-1")).toBe(true);
  });

  it("rejects unsupported and malformed versions", () => {
    expect(isSupportedCopilotCliVersion("1.0.70-99")).toBe(false);
    expect(isSupportedCopilotCliVersion("0.99.99")).toBe(false);
    expect(isSupportedCopilotCliVersion("1.0.71-preview")).toBe(false);
    expect(parseCopilotCliVersion("not-a-version")).toBeUndefined();
  });

  it("keeps verified versions distinct from compatible versions", () => {
    expect(isVerifiedCopilotCliVersion("1.0.82-0")).toBe(true);
    expect(isVerifiedCopilotCliVersion("1.0.83-4")).toBe(true);
    expect(isVerifiedCopilotCliVersion("1.1.0")).toBe(false);
  });
});
