import {
  adapterCapabilitySchema,
  CURRENT_SCHEMA_VERSION,
  isSupportedCopilotCliVersion,
  MINIMUM_COPILOT_CLI_VERSION,
  type AdapterCapability,
} from "@provenloop/contracts";

export const COPILOT_SUPPORTED_SOURCE_EVENT_TYPES = [
  "assistant.message",
  "assistant.turn_start",
  "assistant.turn_end",
  "session.context_changed",
  "session.error",
  "session.idle",
  "session.shutdown",
  "session.start",
  "subagent.completed",
  "subagent.failed",
  "subagent.started",
  "tool.execution_complete",
  "tool.execution_start",
  "user.message",
] as const;

const supportedCapability = adapterCapabilitySchema.parse({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  adapter: "copilot-cli",
  adapterVersion: MINIMUM_COPILOT_CLI_VERSION,
  captureTransport: "extension-session-events",
  sessionFileParser: "events-jsonl-v1",
  sessionFileVersions: [
    1,
  ],
  sourceEventTypes: COPILOT_SUPPORTED_SOURCE_EVENT_TYPES,
  status: "supported",
});

export const COPILOT_CAPTURE_CAPABILITIES: Readonly<
  Record<string, AdapterCapability>
> = {
  [supportedCapability.adapterVersion]: supportedCapability,
};

export const getCopilotCaptureCapability = (
  adapterVersion: string,
): AdapterCapability | undefined =>
  !isSupportedCopilotCliVersion(adapterVersion)
    ? undefined
    : {
        ...supportedCapability,
        adapterVersion,
      };
