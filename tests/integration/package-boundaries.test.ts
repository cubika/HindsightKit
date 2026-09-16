import { describe, expect, it } from "vitest";

import * as cli from "@provenloop/cli";
import * as contracts from "@provenloop/contracts";
import * as copilotAdapter from "@provenloop/copilot-adapter";
import * as domain from "@provenloop/domain";
import * as evaluation from "@provenloop/evaluation";
import * as host from "@provenloop/host";
import * as platformWindows from "@provenloop/platform-windows";
import * as retrieval from "@provenloop/retrieval";
import * as storageSqlite from "@provenloop/storage-sqlite";
import * as testkit from "@provenloop/testkit";

describe("workspace package boundaries", () => {
  it("loads every Batch 1 package entry point", () => {
    expect([
      cli,
      contracts,
      copilotAdapter,
      domain,
      evaluation,
      host,
      platformWindows,
      retrieval,
      storageSqlite,
      testkit,
    ]).toHaveLength(10);
  });
});
