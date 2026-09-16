import {
  PROVENLOOP_VERSION,
} from "@provenloop/contracts";

declare const __PROVENLOOP_CODE_VERSION__: string;

export const PROVENLOOP_CODE_VERSION =
  typeof __PROVENLOOP_CODE_VERSION__ === "string"
    ? __PROVENLOOP_CODE_VERSION__
    : "source-typescript";

export const releaseMetadata = {
  codeVersion: PROVENLOOP_CODE_VERSION,
  version: PROVENLOOP_VERSION,
} as const;
