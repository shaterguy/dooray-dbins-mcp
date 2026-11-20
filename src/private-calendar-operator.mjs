import {validateManagedArgs} from "./private-calendar-managed.mjs";
import net from 'node:net';
import fs from 'node:fs/promises';
import {resolve,join} from 'node:path';
const methods=new Set(['private_calendar_preflight','private_calendar_version','private_calendar_create','private_calendar_delete']);
const limit=16384, framed=x=>JSON.stringify(x)+'\n';
const err=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
const check=(v,e='INVALID_REQUEST')=>{if(!v)throw Error(e)};
const plain=o=>o&&Object.getPrototypeOf(o)===Object.prototype;
const fields=(o,keys)=>plain(o)&&Object.keys(o).every(k=>keys.includes(k));
const uid=()=>{check(typeof process.getuid==='function','NO_PRIVATE_OS_ID');return process.getuid()};
async function privatePath(dir){const canonical=resolve(dir), st=await fs.lstat(canonical);
 check(await fs.realpath(canonical)===canonical&&st.isDirectory()&&!st.isSymbolicLink()&&st.uid===uid()&&(st.mode&0o077)===0,'UNSAFE_DIRECTORY');
 const socket=join(canonical,'.dooray-operator.sock');check(Buffer.byteLength(socket)<104,'PRIVATE_PATH_TOO_LONG');return socket;}
async function privateSocket(socket){const st=await fs.lstat(socket);check(st.isSocket()&&!st.isSymbolicLink()&&st.uid===uid(),'UNSAFE_ENDPOINT');return st;}
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const idle=(socket)=>new Promise((done,reject)=>{const s=net.createConnection({path:socket});s.setTimeout(1500,()=>{s.destroy();reject(Error('ENDPOINT_BUSY'))});s.once('connect',()=>{s.destroy();done(false)});s.once('error',e=>e.code==='ECONNREFUSED'?done(true):reject(Error('ENDPOINT_UNVERIFIED')));});
async function stale(socket){let a;try{a=await privateSocket(socket)}catch(e){if(e.code==='ENOENT')return;throw e}
 check(await idle(socket),'ENDPOINT_EXISTS');check(same(a,await privateSocket(socket)),'ENDPOINT_CHANGED');await fs.unlink(socket);}
const validId=x=>Number.isSafeInteger(x)||typeof x==='string'&&x.length>0&&x.length<=80;
const schema=name=>{
 const pk={type:'string',pattern:'^[a-f0-9]{64}$'}, s={type:'string'};
 const requestId={type:'string',format:'uuid'}, ownerOnlyConfirmed={type:'boolean',const:true};
 if(name==='private_calendar_preflight')return {name,description:'Read calendar readiness only.',inputSchema:{type:'object',properties:{calendarKey:pk},required:['calendarKey'],additionalProperties:false}};
 if(name==='private_calendar_version')return {name,description:'Read the strong ETag of the exact event.',inputSchema:{type:'object',properties:{calendarKey:pk,uid:s,member:s},required:['calendarKey','uid'],additionalProperties:false}};
 const common={calendarKey:pk,requestId,ownerOnlyConfirmed}, required=Object.keys(common);
 if(name==='private_calendar_delete')return {name,description:'Conditionally delete a previously managed owner-only event after verifying its restorable archive. Requires a fresh strong ETag.',inputSchema:{type:'object',properties:{...common,uid:s,expectedTag:s},required:[...required,'uid','expectedTag'],additionalProperties:false}};
 return {name,description:'Create one owner-only attendee-free event (always free time), or restore a verified archive. UTC seconds; reuse requestId for the same request.',inputSchema:{type:'object',properties:{...common,title:s,start:s,end:s,visibility:{type:'string',enum:['PUBLIC','PRIVATE']},location:s,restoreArchiveId:requestId},oneOf:[{required:[...required,'title','start','end','visibility'],not:{required:['restoreArchiveId']}},{required:[...required,'restoreArchiveId'],not:{anyOf:['title','start','end','visibility','location'].map(x=>({required:[x]}))}}],additionalProperties:false}};
};
function validArgs(name,a){
 if(name==='private_calendar_create'||name==='private_calendar_delete'){
  try{validateManagedArgs(name==='private_calendar_create'?'create':'delete',a)}catch{throw Error('INVALID_REQUEST')}
  return;
 }
 const isEvent=name==='private_calendar_version',needed=isEvent?['calendarKey','uid']:['calendarKey'];
 check(fields(a,isEvent?[...needed,'member']:needed)&&needed.every(k=>Object.hasOwn(a,k))&&typeof a.calendarKey==='string'&&/^[a-f0-9]{64}$/.test(a.calendarKey));
 if(isEvent){check(typeof a.uid==='string'&&a.uid.length>0&&a.uid.length<=200);if(Object.hasOwn(a,'member'))check(typeof a.member==='string'&&/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,225}$/.test(a.member)&&!a.member.includes('..'));}
}
export async function startPrivateOperator(dir,handlers){
 check(plain(handlers)&&Object.keys(handlers).length&&Object.entries(handlers).every(([k,v])=>methods.has(k)&&typeof v==='function'),'INVALID_HANDLERS');
 const socket=await privatePath(dir);await stale(socket);let busy=false;const peers=new Set();
 const server=net.createServer({allowHalfOpen:true},conn=>{peers.add(conn);conn.on('error',()=>conn.destroy());conn.once('close',()=>peers.delete(conn));
 if(peers.size>8){conn.destroy();return}
 const chunks=[];let size=0,handled=false;conn.setTimeout(5000,()=>conn.destroy());
 conn.on('data',part=>{size+=part.length;if(size>limit||handled){conn.destroy();return}chunks.push(part)});
 conn.on('end',async()=>{if(handled||conn.destroyed)return;handled=true;conn.setTimeout(0);
 let id=null,reply;let took=false;
 try{const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));id=validId(r?.id)?r.id:null;
 check(fields(r,['id','jsonrpc','method','params'])&&id!==null&&r.jsonrpc==='2.0');
 if(r.method==='initialize'){reply={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'dooray-private-local',version:'1.0'}};}
 else if(r.method==='tools/list'){check(r.params===undefined||(fields(r.params,[])&&Object.keys(r.params).length===0));reply={tools:Object.keys(handlers).map(schema)}}
 else {check(r.method==='tools/call'&&fields(r.params,['name','arguments'])&&Object.keys(r.params).length===2&&typeof r.params.name==='string'&&methods.has(r.params.name)&&Object.hasOwn(handlers,r.params.name));
 const n=r.params.name;validArgs(n,r.params.arguments);check(!busy,'BUSY');busy=true;took=true;const data=await handlers[n](r.params.arguments);
 reply={content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
 const out=framed({jsonrpc:'2.0',id,result:reply});check(Buffer.byteLength(out)<=limit,'RESPONSE_LIMIT');if(!conn.destroyed)conn.end(out);
 }catch(e){const code=['BUSY','INVALID_REQUEST','RESPONSE_LIMIT','CALENDAR_NOT_FOUND','UNSUPPORTED_DELIVERY_POLICY','NO_LIVE_ADAPTER','PREFLIGHT_BLOCKED','CONFLICT','RESOURCE_ID_OR_ETAG','PRIVATE_EVENT_REQUIRED','READBACK_MISMATCH','REPLACE_UNCONFIRMED_OR_REJECTED','DELIVERY_OR_SCOPE_UNKNOWN'].includes(e.message)?e.message:'OPERATION_NOT_VERIFIED';
 if(!conn.destroyed)conn.end(framed(err(id,code==='INVALID_REQUEST'?-32602:-32000,code)));}
 finally{if(took)busy=false;} });});
 await new Promise((yes,no)=>{server.once('error',no);server.listen({path:socket},()=>{server.off('error',no);yes()});});server.on('error',()=>{});
 try{await privateSocket(socket)}catch(e){server.close();throw e}
 return {async close(){for(const c of peers)c.destroy();await new Promise(y=>server.close(y));},busy:()=>busy};
}
export async function callPrivateOperator(dir,rpc){
 const socket=await privatePath(dir);await privateSocket(socket);
 const payload=framed(rpc);check(Buffer.byteLength(payload)<=limit,'REQUEST_LIMIT');
 return new Promise((yes,no)=>{const c=net.createConnection({path:socket});const chunks=[];let len=0;
 const timer=setTimeout(()=>{c.destroy();no(Error('OUTCOME_UNKNOWN_NO_RETRY'));},100000);
 c.once('connect',()=>c.end(payload));c.on('data',x=>{len+=x.length;if(len>limit)c.destroy(Error('RESPONSE_LIMIT'));else chunks.push(x)});
 c.on('error',()=>{clearTimeout(timer);no(Error('PRIVATE_ENDPOINT_UNAVAILABLE_OR_OUTCOME_UNKNOWN'))});
 c.on('end',()=>{clearTimeout(timer);try{const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));check(v.id===rpc.id&&v.jsonrpc==='2.0','RESPONSE_ID');yes(v)}catch(e){no(e)}});
 });}
