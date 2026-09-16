import type {
  CaptureEnvelope,
  JsonValue,
} from "@provenloop/contracts";
import { trustedExecution } from "./verification-proof.js";

export interface CommitAncestryQuery {
  readonly ancestorCommit: string;
  readonly descendantCommit: string;
  readonly repoId: string;
}

export interface CommitAncestryResolver {
  isAncestor(query: CommitAncestryQuery): boolean;
}

export interface CommitAncestryEdge {
  readonly childCommit: string;
  readonly parentCommit: string;
  readonly repoId: string;
}

const commitKey = (repoId: string, commit: string): string =>
  `${repoId}\u0000${commit}`;

const normalizedKey = (key: string): string =>
  key.toLocaleLowerCase("en-US").replaceAll(/[-_.]/gu, "");

export class CommitAncestryIndex implements CommitAncestryResolver {
  readonly #parents: ReadonlyMap<string, ReadonlySet<string>>;

  public constructor(edges: readonly CommitAncestryEdge[]) {
    const parents = new Map<string, Set<string>>();
    for (const edge of edges) {
      const repoId = edge.repoId.trim();
      const parentCommit = edge.parentCommit.trim().toLowerCase();
      const childCommit = edge.childCommit.trim().toLowerCase();
      if (
        repoId.length === 0 ||
        parentCommit.length === 0 ||
        childCommit.length === 0
      ) {
        throw new Error(
          "Commit ancestry edges require non-empty repository and commit IDs.",
        );
      }
      if (parentCommit === childCommit) {
        throw new Error(
          "Commit ancestry edges cannot point a commit to itself.",
        );
      }
      const key = commitKey(repoId, childCommit);
      const current = parents.get(key) ?? new Set<string>();
      current.add(parentCommit);
      parents.set(key, current);
    }
    this.#parents = new Map(parents);
  }

  public isAncestor(query: CommitAncestryQuery): boolean {
    const ancestor = query.ancestorCommit.trim().toLowerCase();
    const descendant = query.descendantCommit.trim().toLowerCase();
    const repoId = query.repoId.trim();
    if (
      ancestor.length === 0 ||
      descendant.length === 0 ||
      repoId.length === 0 ||
      ancestor === descendant
    ) {
      return false;
    }
    const pending = [
      descendant,
    ];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) {
        continue;
      }
      visited.add(current);
      const parents = this.#parents.get(commitKey(repoId, current));
      if (parents === undefined) {
        continue;
      }
      for (const parent of parents) {
        if (parent === ancestor) {
          return true;
        }
        pending.push(parent);
      }
    }
    return false;
  }
}

const parentKeys = new Set([
  "parent",
  "parentcommit",
  "parentcommits",
  "parents",
  "parentsha",
  "parentshas",
]);

const parentCommits = (
  input: JsonValue | undefined,
  depth = 0,
): string[] => {
  if (input === undefined || depth > 4) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.flatMap((value) =>
      value !== null && typeof value === "object"
        ? parentCommits(value, depth + 1)
        : [],
    );
  }
  if (input === null || typeof input !== "object") {
    return [];
  }
  const values: string[] = [];
  for (const [
    key,
    value,
  ] of Object.entries(input)) {
    if (parentKeys.has(normalizedKey(key))) {
      if (typeof value === "string") {
        values.push(value);
      } else if (Array.isArray(value)) {
        values.push(
          ...value.filter(
            (candidate): candidate is string =>
              typeof candidate === "string",
          ),
        );
      }
    } else {
      values.push(...parentCommits(value, depth + 1));
    }
  }
  return values;
};

export const commitAncestryEdgesFromEnvelopes = (
  envelopes: readonly CaptureEnvelope[],
): readonly CommitAncestryEdge[] => {
  const edges = new Map<string, CommitAncestryEdge>();
  const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
  for (const envelope of envelopes) {
    const event = envelope.event;
    if (
      (event.eventType !== "git.commit" && event.eventType !== "git.head_changed") ||
      !trustedExecution(envelope) ||
      event.repoId === undefined ||
      event.commitSha === undefined
    ) {
      continue;
    }
    for (const parentCommit of parentCommits(event.redactedArguments)) {
      const normalizedParent = parentCommit.trim().toLowerCase();
      const normalizedChild = event.commitSha.toLowerCase();
      if (
        normalizedParent.length === 0 ||
        normalizedParent === normalizedChild ||
        !commitPattern.test(normalizedParent) ||
        !commitPattern.test(normalizedChild)
      ) {
        continue;
      }
      const edge = {
        childCommit: normalizedChild,
        parentCommit: normalizedParent,
        repoId: event.repoId,
      };
      edges.set(
        `${edge.repoId}\u0000${edge.parentCommit}\u0000${edge.childCommit}`,
        edge,
      );
    }
  }
  return [...edges.values()].sort(
    (left, right) =>
      left.repoId.localeCompare(right.repoId) ||
      left.parentCommit.localeCompare(right.parentCommit) ||
      left.childCommit.localeCompare(right.childCommit),
  );
};
