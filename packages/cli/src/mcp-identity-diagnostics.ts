import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { TrustedSessionContextDiagnostic } from "@provenloop/copilot-adapter";
import { resolveWindowsProvenLoopPaths } from "@provenloop/platform-windows";

import { PROVENLOOP_CODE_VERSION } from "./release-metadata.js";

export type McpIdentityReason = TrustedSessionContextDiagnostic["reason"]
  | "session_id_missing" | "resolver_unavailable" | "resolver_failed";

export interface McpIdentityDiagnostic extends Omit<TrustedSessionContextDiagnostic, "reason"> {
  readonly reason: McpIdentityReason;
}

const details: Record<McpIdentityReason, string> = {
  session_id_missing: "No Session ID was supplied to the MCP server. Check the host's SESSION_ID environment.",
  resolver_unavailable: "The configured identity resolver returned no session context.",
  resolver_failed: "The configured identity resolver failed.",
  reader_probe_busy: "Another reader holds the session probe guard.",
  session_producer_inactive: "No active session context publisher was detected. Check extension startup and the configured data root.",
  record_missing: "The publisher is active but its session context record is missing.",
  record_session_mismatch: "The context record belongs to a different session.",
  record_expired: "The session context record is older than 60 seconds. Check the publisher heartbeat.",
  record_from_future: "The session context record is more than 5 seconds ahead of the reader's clock.",
  record_producer_inactive: "The record's publisher is no longer active; the session may have restarted.",
  record_invalid: "The session context record has invalid JSON or an invalid schema.",
  record_too_large: "The session context record exceeds 16384 bytes.",
  record_read_failed: "The session context record could not be read. Check the diagnostic errorCode and file access.",
  context_read_failed: "The session identity check failed. Check the diagnostic errorCode and extension logs.",
  repository_expired: "The repository observation is older than 60 seconds. Check workspace refresh in the extension.",
  repository_from_future: "The repository observation is more than 5 seconds ahead of the reader's clock.",
  workspace_refreshing: "The publisher is refreshing the workspace identity.",
  repository_unknown: "The publisher has not confirmed whether the workspace belongs to a repository.",
};

export const describeMcpIdentityFailure = (reason: McpIdentityReason): string =>
  `Trusted session/workspace identity unavailable [${reason}]. ${details[reason]} No context was retrieved.`;

export const appendMcpIdentityDiagnostic = async (
  dataRoot: string,
  event: {
    readonly event: "trusted_identity_unavailable" | "trusted_identity_recovered";
    readonly diagnostic?: McpIdentityDiagnostic;
    readonly previousReason?: McpIdentityReason;
    readonly previousIdentityCheckId?: string;
    readonly identityCheckId: string;
    readonly observationSequence: number;
    readonly observedAt: string;
    readonly requestId: string;
    readonly sessionId?: string;
    readonly sessionIdSource: "options" | "environment" | "resolver" | "missing";
    readonly elapsedMs: number;
  },
): Promise<void> => {
  const append = async () => {
    const paths = resolveWindowsProvenLoopPaths(dataRoot);
    // Fixed fields keep prompts, approval text, raw paths, and exception bodies out of logs.
    const entry = {
      timestamp: new Date().toISOString(),
      component: "mcp",
      codeVersion: PROVENLOOP_CODE_VERSION,
      pid: process.pid,
      event: event.event,
      requestId: event.requestId,
      identityCheckId: event.identityCheckId,
      observationSequence: event.observationSequence,
      observedAt: event.observedAt,
      sessionIdSource: event.sessionIdSource,
      ...(event.sessionId === undefined ? {} : { sessionHash: createHash("sha256").update(event.sessionId).digest("hex") }),
      elapsedMs: event.elapsedMs,
      ...event.diagnostic,
      ...(event.previousReason === undefined ? {} : { previousReason: event.previousReason }),
      ...(event.previousIdentityCheckId === undefined ? {} : { previousIdentityCheckId: event.previousIdentityCheckId }),
    };
    await mkdir(paths.logs, { recursive: true });
    await appendFile(join(paths.logs, "mcp.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    // A slow log volume must not hold up identity resolution or shutdown.
    await Promise.race([
      append().catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 25); }),
    ]);
  } finally { clearTimeout(timer); }
};
