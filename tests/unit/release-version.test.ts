import {
  readFile,
} from "node:fs/promises";

import {
  PROVENLOOP_VERSION,
} from "@provenloop/contracts";
import {
  describe,
  expect,
  it,
} from "vitest";

describe("release version", () => {
  it("keeps the root and publishable package versions aligned", async () => {
    const [
      rootPackage,
      cliPackage,
      lockfile,
      marketplace,
      plugin,
      extension,
      installer,
      mcpLauncher,
    ] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("packages/cli/package.json", "utf8"),
      readFile("package-lock.json", "utf8"),
      readFile(".github/plugin/marketplace.json", "utf8"),
      readFile("plugins/provenloop/plugin.json", "utf8"),
      readFile(
        "plugins/provenloop/extensions/event-capture/extension.mjs",
        "utf8",
      ),
      readFile("install.ps1", "utf8"),
      readFile(
        "plugins/provenloop/scripts/mcp-launcher.ps1",
        "utf8",
      ),
    ]);

    expect(JSON.parse(rootPackage)).toMatchObject({
      engines: {
        node: ">=22.16.0",
        npm: ">=11",
      },
      version: PROVENLOOP_VERSION,
    });
    expect(JSON.parse(cliPackage)).toMatchObject({
      engines: {
        node: ">=22.16.0",
        npm: ">=11",
      },
      version: PROVENLOOP_VERSION,
    });
    const lockedPackages = JSON.parse(lockfile).packages;
    for (const name of ["", "packages/cli"]) {
      expect(lockedPackages[name]).toMatchObject({
        engines: {
          node: ">=22.16.0",
          npm: ">=11",
        },
        version: PROVENLOOP_VERSION,
      });
    }
    expect(JSON.parse(marketplace)).toMatchObject({
      metadata: {
        version: PROVENLOOP_VERSION,
      },
      plugins: [
        {
          version: PROVENLOOP_VERSION,
        },
      ],
    });
    expect(JSON.parse(plugin)).toMatchObject({
      version: PROVENLOOP_VERSION,
    });
    expect(extension).toContain(
      `runtime.version !== "${PROVENLOOP_VERSION}"`,
    );
    expect(installer).toContain(
      `[string]$Version = "${PROVENLOOP_VERSION}"`,
    );
    expect(mcpLauncher).toContain(
      `$runtime.version -ne "${PROVENLOOP_VERSION}"`,
    );
  });
});
