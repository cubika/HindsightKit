import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it,expect } from "vitest";
import { recoverPermissionBridges } from "../../packages/copilot-adapter/src/permission-bridge-recovery.js";
it("reads only bounded permission metadata from the exact trusted session directory",async()=>{
 const root=await mkdtemp(join(tmpdir(),"provenloop-permission-"));const dir=join(root,"session");await mkdir(dir);
 try{await writeFile(join(dir,"events.jsonl"),[{id:"permission",parentId:"tool",type:"permission.requested",timestamp:"2026-09-07T00:00:00.000Z",data:{secret:"never propagate"}},{id:"user",parentId:"permission",type:"user.message",timestamp:"2026-09-07T00:00:01.000Z",data:{content:"never propagate"}}].map(x=>JSON.stringify(x)).join("\n"));
 const events:unknown[]=[];await recoverPermissionBridges(dir,"different",e=>events.push(e));expect(events).toEqual([]);
 await recoverPermissionBridges(dir,"session",e=>events.push(e));expect(events).toEqual([{id:"permission",parentId:"tool",type:"permission.requested",timestamp:"2026-09-07T00:00:00.000Z",data:{}}]);
 }finally{await rm(root,{recursive:true,force:true});}
});
