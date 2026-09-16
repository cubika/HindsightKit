import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep, basename, dirname, isAbsolute } from "node:path";
import type { CommandRunner, CommandRunOptions, CommandResult } from "./command-runner.js";
import { SpawnCommandRunner } from "./command-runner.js";

import { INFERENCE_SUPERVISOR_PROGRAM } from "./inference-supervisor-program.js";
export class SupervisedInferenceRunner implements CommandRunner {
  public constructor(private readonly root: string) {}
  public async run(executable:string,args:readonly string[],options:CommandRunOptions={}):Promise<CommandResult>{
    let nodeExecutable=process.execPath;
    if(basename(nodeExecutable).toLowerCase()!=="node.exe"&&basename(nodeExecutable)!=="node"){
      const root=dirname(resolve(this.root));
      const locations=[join(root,"integration","runtime.json"),...(process.env.LOCALAPPDATA?[join(process.env.LOCALAPPDATA,"ProvenLoopIntegration","runtime.json")]:[])];
      let found:string|undefined;
      for(const location of locations){try{const record=JSON.parse(await readFile(location,"utf8")) as {product?:string;dataRoot?:string;nodeExecutable?:string};if(record.product==="ProvenLoopRuntime"&&record.dataRoot&&resolve(record.dataRoot)===root&&record.nodeExecutable&&isAbsolute(record.nodeExecutable)&&basename(record.nodeExecutable).toLowerCase()==="node.exe"){found=record.nodeExecutable;break;}}catch{/* Try another owned runtime locator. */}}
      if(!found)return{exitCode:127,stdout:"",stderr:"Installed Node executable is unavailable for the inference supervisor."};
      nodeExecutable=found;
      const version=await new SpawnCommandRunner().run(nodeExecutable,["--version"],{timeoutMs:5000,environment:{NODE_OPTIONS:""}});
      const match=version.stdout.trim().match(/^v([0-9]+).([0-9]+)/u);if(version.exitCode!==0||!match||Number(match[1])<22||(Number(match[1])===22&&Number(match[2])<16))return{exitCode:127,stdout:"",stderr:"Installed inference Node runtime is unsupported."};
    }
    return new Promise((done)=>{
      const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("COPILOT_EXTENSION_")&&!["NODE_OPTIONS","NODE_CHANNEL_FD","NODE_UNIQUE_ID","SESSION_ID","EXTENSION_PATH","COPILOT_SDK_PATH"].includes(key)));
      const supervisor=spawn(nodeExecutable,["--input-type=module","--eval",INFERENCE_SUPERVISOR_PROGRAM],{env:environment,detached:true,windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]});
      let result:CommandResult|undefined;
      const abort=():void=>{if(supervisor.connected)supervisor.send({type:"cancel"});};
      options.signal?.addEventListener("abort",abort,{once:true});
      supervisor.once("error",()=>{result={exitCode:127,stdout:"",stderr:"Inference supervisor could not start."};});
      supervisor.on("message",(input:unknown)=>{
        const message=input as {type?:string;exitCode?:number;stdout?:string;stderr?:string};
        if(message.type==="result"&&typeof message.exitCode==="number")result={exitCode:message.exitCode,stdout:message.stdout??"",stderr:message.stderr??""};
      });
      supervisor.once("close",()=>{options.signal?.removeEventListener("abort",abort);done(result??{exitCode:125,stdout:"",stderr:"Inference supervisor exited before confirming cleanup."});});
      supervisor.send({type:"start",root:resolve(this.root),directory:options.cwd,nonce:randomUUID(),executable,args,environment:options.environment,timeoutMs:options.timeoutMs});
      if(options.signal?.aborted)abort();
    });
  }
}

export async function cancelLearningScratch(temporaryRoot:string,timeoutMs=8000):Promise<void>{
  const root=resolve(temporaryRoot);
  try{if((await lstat(root)).isSymbolicLink())throw new Error("Linked inference scratch root.");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  const targets:string[]=[];
  if(entries.length>256)throw new Error("Inference scratch scan exceeds its deletion budget; deletion remains pending.");
  for(const entry of entries.slice(0,256)){
    if(!/^learning-[A-Za-z0-9]+$/u.test(entry.name))continue;
    if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error("Linked or invalid inference scratch directory.");
    const target=resolve(root,entry.name);if(!target.startsWith(root+sep)||(await lstat(target)).isSymbolicLink())throw new Error("Invalid inference scratch ownership.");
    let marker;try{marker=JSON.parse(await readFile(join(target,".provenloop-inference.json"),"utf8")) as {product?:string;root?:string;directory?:string;nonce?:string;supervisorPid?:number};}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"){try{await lstat(target);}catch{continue;}}throw new Error("Inference scratch ownership cannot be verified; deletion remains pending.",{cause:error});}
    if(marker.product!=="ProvenLoop"||marker.root!==root||marker.directory!==target||!marker.nonce)throw new Error("Inference scratch ownership mismatch.");
    if(!Number.isSafeInteger(marker.supervisorPid)||Number(marker.supervisorPid)<=0)throw new Error("Inference supervisor identity is unavailable.");
    let alive=true;try{process.kill(Number(marker.supervisorPid),0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")alive=false;else throw error;}
    if(!alive){await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});continue;}
    await writeFile(join(target,".cancel-inference"),marker.nonce,"utf8");targets.push(target);
  }
  const deadline=Date.now()+timeoutMs;
  for(const target of targets){
    while(true){try{await lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")break;throw error;}
      if(Date.now()>=deadline)throw new Error("Inference scratch cleanup has not completed; deletion remains pending.");
      await new Promise<void>((done)=>setTimeout(done,50));
    }
  }
}
