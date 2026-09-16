import { type LearningToolContract } from "@provenloop/contracts";
import { sha256 } from "@provenloop/domain";

export interface CopilotToolMetadata {
  readonly name: string;
  readonly mcpServerName?: string;
  readonly mcpToolName?: string;
  readonly input_schema?: Readonly<Record<string, unknown>>;
}

export class CopilotLearningToolRegistry {
  readonly #tools = new Map<string, LearningToolContract>();
  public replace(tools: readonly CopilotToolMetadata[], version: string): void {
    this.#tools.clear();
    for (const tool of tools.slice(0, 512)) {
      if (!tool.mcpServerName || !tool.mcpToolName || tool.input_schema?.type !== "object") continue;
      const required = tool.input_schema.required;
      if (!Array.isArray(required) || required.length > 64 || required.some((item: unknown) =>
        typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(item))) continue;
      const contract = { schemaVersion: 1 as const, serverName: tool.mcpServerName, toolName: tool.mcpToolName,
        sourceSchemaDigest: sha256(tool.input_schema),
        version, requiredArguments: [...new Set(required as string[])].sort(), absolutePathArguments: [] as string[] };
      this.#tools.set(tool.name, { ...contract, digest: sha256(contract) });
    }
  }
  public find(name: string): LearningToolContract | undefined { return this.#tools.get(name); }
  public contracts(): readonly LearningToolContract[] { return [...this.#tools.values()]; }
}
