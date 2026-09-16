import { describe, expect, it } from "vitest";
import { createFrozenLearningCorpus } from "@provenloop/evaluation";
import type { LearningComparisonCandidate, RuleProposalInput } from "@provenloop/contracts";
import { prepareLearningReviewInput } from "../../packages/copilot-adapter/src/learning-review-input.js";

describe("bounded full-context lesson review input", () => {
  it("includes comparison snapshots and full anchors once while preserving cited spans", () => {
    const window = createFrozenLearningCorpus().cases[0]?.window;
    if (!window) throw new Error("Missing fixture window.");
    const user = window.events.find((entry) => entry.event.trust === "user");
    if (!user?.content?.message) throw new Error("Missing user message.");
    const proposal: RuleProposalInput = { rule: "Supply the required argument.", trigger: "Calling the captured tool",
      exclusions: ["Other tools"], userSource: { eventId: user.event.eventId, quote: user.content.message },
      supportingSources: [{ eventId: user.event.eventId, quote: user.content.message }],
      relations: [{ kind: "supersedes", knowledgeId: "old", targetDigest: "a".repeat(64), reason: "A stated change" }] };
    const prior: LearningComparisonCandidate = { knowledgeId: "old", targetDigest: "a".repeat(64), rule: "The previous rule.",
      trigger: ["Calling the captured tool"], exclusions: ["Other tools"], state: "candidate", evidenceTier: "inferred", mutable: true };
    const prompt = prepareLearningReviewInput(window, [proposal, proposal], [prior], "Review: ");
    const data = JSON.parse(prompt.slice("Review: ".length));
    expect(data.sourceContext).toHaveLength(1);
    expect(data.sourceContext[0].text).toBe(user.content.message);
    expect(data.citations).toHaveLength(1);
    expect(data.priorKnowledge).toEqual([prior]);
    expect(data.proposals[0].proposal.relations).toEqual(proposal.relations);
    expect(data.proposals[0].proposal).not.toHaveProperty("userSource");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(32 * 1024);
  });
});
