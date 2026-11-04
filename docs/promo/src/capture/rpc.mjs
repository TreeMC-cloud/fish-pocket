// Host-side RPC to the app's local engine. usage: rpc.mjs <method> '<args json>'
import fs from 'node:fs'; import {execSync} from 'node:child_process';
const SIM=process.env.SIM;
const c=execSync(`xcrun simctl get_app_container ${SIM} com.wsw.dsh-ios data`).toString().trim();
const url=fs.readFileSync(c+'/Library/Application Support/dsh-ios/root/home/dsh/.ios/web-url','utf8').trim();
const a=await fetch(url,{redirect:'manual'}); const cookie=a.headers.get('set-cookie').split(';')[0];
const origin=new URL(url).origin;
export async function call(method,args={}){const r=await fetch(`${origin}/api/${method}`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args}})});return r.json();}
if(process.argv[2]){console.log(JSON.stringify(await call(process.argv[2],JSON.parse(process.argv[3]||'{}')),null,1));}
