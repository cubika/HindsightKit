import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { INFERENCE_SUPERVISOR_PROGRAM } from "../../packages/copilot-adapter/src/inference-supervisor-program.js";
import { SupervisedInferenceRunner, cancelLearningScratch } from "../../packages/copilot-adapter/src/inference-supervisor.js";
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
const setup=async()=>{const root=await mkdtemp(join(tmpdir(),"provenloop-supervisor-"));roots.push(root);const directory=join(root,"learning-owned123");return{root,directory};};
const waitFor=async(check:()=>Promise<boolean>)=>{const until=Date.now()+6000;while(!await check()){if(Date.now()>until)throw Error("Timed out waiting for process fixture.");await new Promise<void>(r=>setTimeout(r,30));}};
describe("independent inference scratch owner",()=>{
 it("uses the installed Node locator when the host executable embeds Copilot",async()=>{
  const{root,directory}=await setup();const node=process.execPath;const previous=Object.getOwnPropertyDescriptor(process,"execPath");
  await mkdir(join(root,"temp"));await mkdir(join(root,"integration"));await writeFile(join(root,"integration","runtime.json"),JSON.stringify({product:"ProvenLoopRuntime",dataRoot:root,nodeExecutable:node}));
  try{Object.defineProperty(process,"execPath",{value:join(root,"copilot.exe"),configurable:true});
    const result=await new SupervisedInferenceRunner(join(root,"temp")).run(node,["-e","process.stdout.write('NODE_OK')"],{cwd:join(root,"temp","learning-host"),timeoutMs:5000});expect(result.exitCode).toBe(0);expect(result.stdout).toBe("NODE_OK");
  }finally{if(previous)Object.defineProperty(process,"execPath",previous);}
  void directory;
 },15000);
 it("does not inherit host extension loaders or session identity",async()=>{
  const{root,directory}=await setup();vi.stubEnv("NODE_OPTIONS","--require C:/missing-host-bootstrap.cjs");vi.stubEnv("COPILOT_EXTENSION_PARENT_PID","999999");vi.stubEnv("SESSION_ID","foreground");
  const result=await new SupervisedInferenceRunner(root).run(process.execPath,["-e","process.stdout.write(JSON.stringify({loader:process.env.NODE_OPTIONS,parent:process.env.COPILOT_EXTENSION_PARENT_PID,session:process.env.SESSION_ID}))"],{cwd:directory,timeoutMs:5000});
  expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout)).toEqual({});expect(await readdir(root)).toEqual([]);
 },15000);
 it("cleans the launched child scratch after its owning process is forcibly terminated",async()=>{
  const{root,directory}=await setup();
  const program="const {spawn}=require('node:child_process');const s=spawn(process.execPath,['--input-type=module','--eval',"+JSON.stringify(INFERENCE_SUPERVISOR_PROGRAM)+"],{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});s.send("+JSON.stringify({type:"start",root,directory,nonce:"test-owner",executable:process.execPath,args:["-e","require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"],timeoutMs:10000})+");setInterval(()=>{},1000);";
  const owner=spawn(process.execPath,["-e",program],{windowsHide:true,stdio:"ignore"});
  await waitFor(async()=>{try{await readFile(join(directory,"started"));return true;}catch{return false;}});
  owner.kill("SIGKILL");
  await waitFor(async()=>{try{return(await readdir(root)).length===0;}catch{return false;}});
  expect(await readdir(root)).toEqual([]);
 },15000);
 it("reports success only after deleting child-created content",async()=>{
  const{root,directory}=await setup();
  const result=await new SupervisedInferenceRunner(root).run(process.execPath,["-e","require('fs').writeFileSync('private.txt','private');process.stdout.write('OK')"],{cwd:directory,timeoutMs:5000});
  expect(result).toEqual({exitCode:0,stdout:"OK",stderr:""});expect(await readdir(root)).toEqual([]);
 },15000);
 it("kills the owned child and confirms cleanup on abort",async()=>{
  const{root,directory}=await setup();const controller=new AbortController();
  const running=new SupervisedInferenceRunner(root).run(process.execPath,["-e","require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"],{cwd:directory,timeoutMs:10000,signal:controller.signal});
  await waitFor(async()=>{try{return await readFile(join(directory,"started"),"utf8")==="yes";}catch{return false;}});controller.abort();
  expect((await running).exitCode).toBe(130);expect(await readdir(root)).toEqual([]);
 },15000);
 it("deletion cancellation waits until supervised scratch is gone",async()=>{
  const{root,directory}=await setup();
  const running=new SupervisedInferenceRunner(root).run(process.execPath,["-e","require('fs').writeFileSync('started','yes');setInterval(()=>{},1000)"],{cwd:directory,timeoutMs:10000});
  await waitFor(async()=>{try{await readFile(join(directory,"started"));return true;}catch{return false;}});
  await cancelLearningScratch(root);expect((await running).exitCode).toBe(130);expect(await readdir(root)).toEqual([]);
 },15000);
 it("fails closed for unowned directories without deleting them",async()=>{
  const{root,directory}=await setup();await mkdir(directory);await writeFile(join(directory,"private"),"keep");await mkdir(join(root,"unrelated"));
  await expect(cancelLearningScratch(root)).rejects.toThrow("ownership");expect(await readFile(join(directory,"private"),"utf8")).toBe("keep");
 });
});
