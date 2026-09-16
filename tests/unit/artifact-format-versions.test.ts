import { describe, expect, it } from "vitest";

import { ARTIFACT_FORMAT_VERSIONS } from "@provenloop/contracts";

describe("artifact format versions", () => {
  it("starts every persisted artifact family at version 1", () => {
    expect(ARTIFACT_FORMAT_VERSIONS).toEqual({
      fixture: 1,
      migration: 1,
      report: 1,
      schema: 1,
    });
  });
});
