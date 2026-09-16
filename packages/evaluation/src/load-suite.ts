import {
  access,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  replaySpecSchema,
  requirementManifestSchema,
} from "@provenloop/contracts";
import { z } from "zod";

import { evaluationFixtureSchema } from "./fixture.js";
import type { LoadedEvaluationSuite } from "./types.js";
import { VERIFIER_IDS } from "./verifiers.js";

const builtInFixtureRoot = fileURLToPath(
  new URL("../fixtures", import.meta.url),
);

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

const readText = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new EvaluationInputError(`Evaluation input not found: ${path}`);
    }
    throw error;
  }
};

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readText(path)) as unknown;

export class EvaluationInputError extends Error {
  public override readonly name = "EvaluationInputError";
}

const inlineSuiteSchema = z
  .object({
    fixture: evaluationFixtureSchema,
    manifest: requirementManifestSchema,
    replaySpec: replaySpecSchema,
  })
  .strict();

const resolveSuiteRoot = async (suite: string): Promise<string> => {
  const candidate = isAbsolute(suite) ? suite : resolve(suite);
  if (await exists(candidate)) {
    const metadata = await stat(candidate);
    return metadata.isDirectory() ? candidate : dirname(candidate);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/u.test(suite)) {
    throw new EvaluationInputError(`Invalid suite path or name: ${suite}`);
  }

  const builtIn = join(builtInFixtureRoot, suite);
  if (!(await exists(builtIn))) {
    throw new EvaluationInputError(`Evaluation suite not found: ${suite}`);
  }
  return builtIn;
};

const resolveInputEventPath = (
  rootDirectory: string,
  inputEvent: string,
): string => {
  if (inputEvent.startsWith("fixture://")) {
    const reference = inputEvent.slice("fixture://".length);
    const [suiteId, ...pathParts] = reference.split("/");
    if (!suiteId || pathParts.length === 0) {
      throw new EvaluationInputError(
        `Invalid fixture URI: ${inputEvent}`,
      );
    }
    return join(builtInFixtureRoot, suiteId, ...pathParts);
  }
  return resolve(rootDirectory, inputEvent);
};

const readInputEvents = async (
  rootDirectory: string,
  inputEvents: readonly string[],
): Promise<readonly unknown[]> => {
  const loaded = await Promise.all(
    inputEvents.map(async (inputEvent) => {
      const path = resolveInputEventPath(rootDirectory, inputEvent);
      if (path.endsWith(".jsonl")) {
        const content = await readText(path);
        return content
          .split(/\r?\n/u)
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as unknown);
      }
      return [
        await readJson(path),
      ];
    }),
  );
  return loaded.flat();
};

export const loadEvaluationSuite = async (
  suite: string,
): Promise<LoadedEvaluationSuite> => {
  const rootDirectory = await resolveSuiteRoot(suite);
  const inlineSuitePath = join(rootDirectory, "suite.json");
  const inlineSuite = (await exists(inlineSuitePath))
    ? inlineSuiteSchema.parse(await readJson(inlineSuitePath))
    : undefined;
  const manifest =
    inlineSuite?.manifest ??
    requirementManifestSchema.parse(
      await readJson(join(rootDirectory, "requirement.json")),
    );
  const replaySpec =
    inlineSuite?.replaySpec ??
    replaySpecSchema.parse(
      await readJson(join(rootDirectory, "replay-spec.json")),
    );

  if (!manifest.replaySpecIds.includes(replaySpec.specId)) {
    throw new EvaluationInputError(
      `Manifest ${manifest.requirementId} does not reference ${replaySpec.specId}.`,
    );
  }
  if (manifest.requirementId !== replaySpec.requirementId) {
    throw new EvaluationInputError(
      `Replay Spec ${replaySpec.specId} targets a different requirement.`,
    );
  }
  const unknownVerifiers = manifest.verifierIds.filter(
    (verifierId) => !VERIFIER_IDS.includes(verifierId as never),
  );
  if (unknownVerifiers.length > 0) {
    throw new EvaluationInputError(
      `Unknown verifier(s): ${unknownVerifiers.join(", ")}.`,
    );
  }

  let fixture;
  if (inlineSuite !== undefined) {
    if (replaySpec.inputRef !== "inline://fixture") {
      throw new EvaluationInputError(
        "Inline suites must declare inputRef as inline://fixture.",
      );
    }
    fixture = inlineSuite.fixture;
  } else if (replaySpec.inputRef !== undefined) {
    fixture = evaluationFixtureSchema.parse(
      await readJson(resolve(rootDirectory, replaySpec.inputRef)),
    );
  } else {
    fixture = evaluationFixtureSchema.parse({
      schemaVersion: 1,
      fixtureId: replaySpec.specId,
      fixtureVersion: 1,
      events: await readInputEvents(
        rootDirectory,
        replaySpec.inputEvents ?? [],
      ),
    });
  }

  return {
    fixture,
    manifest,
    replaySpec,
    rootDirectory,
    suiteId: fixture.fixtureId,
  };
};
