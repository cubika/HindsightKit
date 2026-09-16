import { z } from "zod";

import {
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  versionedSchemaShape,
} from "./common.js";

export const PROVENLOOP_CAPABILITIES = [
  "capture",
  "worker",
  "retrieval",
  "correction_learning",
  "outcome_learning",
  "retrospective",
  "playbook",
  "external_research",
] as const;

export const provenLoopCapabilitySchema = z.enum(
  PROVENLOOP_CAPABILITIES,
);

export const adapterCapabilityStatusSchema = z.enum([
  "supported",
  "incompatible",
]);

export const captureTransportSchema = z.enum([
  "extension-session-events",
]);

export const adapterCapabilitySchema = z
  .object({
    ...versionedSchemaShape,
    adapter: nonEmptyStringSchema,
    adapterVersion: nonEmptyStringSchema,
    captureTransport: captureTransportSchema,
    sessionFileParser: nonEmptyStringSchema,
    sessionFileVersions: z
      .array(nonNegativeIntegerSchema)
      .min(1),
    sourceEventTypes: z.array(nonEmptyStringSchema),
    status: adapterCapabilityStatusSchema,
  })
  .strict();

export type AdapterCapability = z.infer<
  typeof adapterCapabilitySchema
>;

export type ProvenLoopCapability = z.infer<
  typeof provenLoopCapabilitySchema
>;

export type AdapterCompatibility =
  | "incompatible"
  | "supported"
  | "unavailable";

export type AdapterCapabilityAvailability =
  | "available"
  | "incompatible"
  | "unavailable";

export interface AdapterCapabilityState {
  readonly availability: AdapterCapabilityAvailability;
  readonly capability: ProvenLoopCapability;
  readonly enabled: boolean;
  readonly lastError?: string;
}

export interface AdapterCapabilityMatrix {
  readonly adapter: string;
  readonly capabilities: readonly AdapterCapabilityState[];
  readonly capture?: AdapterCapability;
  readonly compatibility: AdapterCompatibility;
  readonly installedVersion?: string;
}

export type AdapterHealthCheckStatus = "fail" | "pass" | "warn";

export interface AdapterHealthCheck {
  readonly id: string;
  readonly message: string;
  readonly status: AdapterHealthCheckStatus;
}

export interface AdapterHealth {
  readonly adapter: string;
  readonly checkedAt: string;
  readonly checks: readonly AdapterHealthCheck[];
  readonly providerStatus?:
    | "available"
    | "incompatible"
    | "rate_limited"
    | "signed_out"
    | "unavailable"
    | "unverified";
  readonly status: "degraded" | "healthy" | "unhealthy";
}

export interface AdapterDoctorOptions {
  readonly online?: boolean;
  readonly onlineTimeoutMs?: number;
}

export interface AdapterInstallOptions {
  readonly autoCollect?: boolean;
}

export interface AdapterOperationResult {
  readonly message: string;
  readonly status: "changed" | "incompatible" | "unchanged";
}

export interface AdapterStatus {
  readonly capabilities: AdapterCapabilityMatrix;
  readonly dataRoot: string;
  readonly installed: boolean;
  readonly marketplaceRegistered: boolean;
  readonly marketplaceSource?: string;
  readonly pluginEnabled: boolean;
  readonly pluginInstalled: boolean;
  readonly pluginVersion?: string;
  readonly registrationError?: string;
}

export interface RuntimeContext {
  readonly adapterVersion: string;
  readonly cwd: string;
  readonly environment?: Readonly<
    Record<string, string | undefined>
  >;
  readonly sessionId: string;
}

export interface SessionIdentity {
  readonly branch?: string;
  readonly commitParents?: readonly string[];
  readonly commitSha?: string;
  readonly internalSession: boolean;
  readonly repositoryId?: string;
  readonly repositoryRoot?: string;
  readonly repositoryRemote?: string;
  readonly sessionId: string;
  readonly worktreePath?: string;
}

export interface AgentAdapter<TNormalizedEventResult = unknown> {
  capabilities(): Promise<AdapterCapabilityMatrix>;
  disable(
    capability: ProvenLoopCapability,
  ): Promise<AdapterOperationResult>;
  doctor(options?: AdapterDoctorOptions): Promise<AdapterHealth>;
  enable(
    capability: ProvenLoopCapability,
  ): Promise<AdapterOperationResult>;
  install(options?: AdapterInstallOptions): Promise<AdapterOperationResult>;
  normalizeEvent(
    input: unknown,
    context: RuntimeContext,
  ): TNormalizedEventResult;
  registerCaptureExtension(): Promise<AdapterOperationResult>;
  registerContextTools(): Promise<AdapterOperationResult>;
  resolveSession(context: RuntimeContext): Promise<SessionIdentity>;
  status(): Promise<AdapterStatus>;
  uninstall(
    options: {
      readonly purge: boolean;
    },
  ): Promise<AdapterOperationResult>;
  upgrade(): Promise<AdapterOperationResult>;
}
