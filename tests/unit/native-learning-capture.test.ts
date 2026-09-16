import { describe, expect, it } from "vitest";
import { CopilotEventMapper } from "@provenloop/copilot-adapter";
const at = (seconds: number) => new Date(Date.UTC(2026,8,7,0,0,seconds)).toISOString();
const mapper = () => new CopilotEventMapper({ adapterVersion:"1.0.84-1",copyLimits:{maxStringChars:4096},sessionId:"s",workspace:{cwd:"C:\repo",worktree:"C:\repo",repoId:"repo",repositoryState:"known_repo"} });
describe("native learning capture", () => {
  it("marks tool-request messages as running without retaining their arguments", () => {
    const m = mapper();
    const request = m.map({ id: "working", type: "assistant.message", timestamp: at(1), parentId: null,
      data: { messageId: "message-working", content: "Inspecting code.", toolRequests: [{ toolCallId: "read-1", name: "read", arguments: { privateValue: "do not retain" } }] } });
    if (request.status !== "mapped") throw new Error("Expected mapped message.");
    expect(request.value.completionStatus).toBe("running");
    expect(JSON.stringify(request.value)).not.toContain("do not retain");
    const final = m.map({ id: "final", type: "assistant.message", timestamp: at(2), parentId: "working",
      data: { messageId: "message-final", content: "The cache uses a revision key.", toolRequests: [] } });
    if (final.status !== "mapped") throw new Error("Expected mapped message.");
    expect(final.value.completionStatus).toBeUndefined();
  });
  it("preserves exact observed parent bridges without their prompt content", () => {
    const m=mapper();
    const parent=m.map({id:"u",type:"user.message",timestamp:at(0),parentId:null,data:{content:"Use the path."}});
    expect(parent.status).toBe("mapped");
    expect(m.map({id:"h",type:"hook.start",timestamp:at(1),parentId:"u",data:{secret:"never copied"}}).status).toBe("ignored");
    const next=m.map({id:"a",type:"assistant.turn_start",timestamp:at(2),parentId:"h",data:{turnId:"t"}});
    if(next.status!=="mapped"||parent.status!=="mapped")throw new Error("expected mapping");
    expect(next.value.originalParentSourceEventId).toBe("h");
    expect(next.value.parentBridge).toEqual([{schemaVersion:1,sourceEventId:"h",parentSourceEventId:"u",eventType:"hook.start",timestamp:at(1),sessionId:"s",repoId:"repo",worktree:"C:\repo",trust:"system"}]);
    expect(JSON.stringify(next.value)).not.toContain("never copied");
  });
  it("preserves empty and arbitrary MCP arguments and marks bounded truncation", () => {
    const m=mapper();
    for(const [index,args]of[{}, {customOption:"x",nested:{enabled:true}}, {values:Array.from({length:65},()=>"x")}].entries()){
      const result=m.map({id:`t${index}`,type:"tool.execution_start",timestamp:at(index),parentId:null,data:{toolCallId:`call${index}`,toolName:"mcp-tool",mcpServerName:"mcp",mcpToolName:"tool",arguments:args}});
      if(result.status!=="mapped")throw new Error("expected mapping");
      if(index<2)expect(result.value.content?.toolArguments).toEqual(args);
      else expect(result.value.captureQuality?.omittedFields).toContain("toolArguments.values");
    }
  });
});
