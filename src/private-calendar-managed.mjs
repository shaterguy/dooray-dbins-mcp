import fs from "node:fs/promises";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {normalizeSeoulCalendar} from "./private-calendar-live-io.mjs";

const check=(yes,e)=>{if(!yes)throw Error(e)};
const H=x=>createHash("sha256").update(x).digest("hex");
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY=/^[0-9a-f]{64}$/;
const TAG=/^"[\x21\x23-\x7e]{1,190}"$/;
const unique=(x)=>'moru-private-'+x;
const controlled=x=>typeof x==="string"&&x.startsWith("moru-private-")&&ID.test(x.slice(13));
const text=(x,n)=>typeof x==="string"&&x.length<=n&&!/[\x00-\x1f\x7f]/.test(x);
const fields=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).every(k=>keys.includes(k));
const reason=e=>[e?.code,e?.message].find(x=>typeof x==="string"&&/^[A-Z][A-Z0-9_]{2,63}$/.test(x))||"OPERATION_NOT_VERIFIED";
const rdir='.calendar-managed-v1';
const base=['calendarKey','requestId','ownerOnlyConfirmed'];
const cfields=[...base,'title','start','end','visibility','location','restoreArchiveId'];
const dfields=[...base,'uid','expectedTag'];
const normalizeTime=s=>{
 check(typeof s==="string"&&/^(?:20\d{2}|21\d{2})-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s),"MANAGED_UTC_TIME");
 const x=new Date(s);check(Number.isFinite(+x)&&x.toISOString()===s.slice(0,-1)+".000Z","MANAGED_UTC_TIME");
 return s.replace(/[-:]/g,"");
};
const escaped=s=>s.replace(/\\/g,"\\\\").replace(/,/g,"\\,").replace(/;/g,"\\;");
function fold(s){
 let n=0,parts=[""];for(const char of s){const b=Buffer.byteLength(char);if(n+b>75){parts.push(" ");n=1}parts[parts.length-1]+=char;n+=b}
 return parts.join("\r\n");
}
const stamp=()=>new Date().toISOString().slice(0,19).replace(/[-:]/g,"")+"Z";
function derived(a,b){
 const x=H(a+"\n"+b).slice(0,32).split("");x[12]="4";x[16]=((parseInt(x[16],16)&3)|8).toString(16);
 const s=x.join("");return unique([s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join("-"));
}
function document(uid,input){
 const start=normalizeTime(input.start),end=normalizeTime(input.end);
 check(start<end,"MANAGED_BAD_TIME_ORDER");
 const v=input.visibility;
 return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Moru//Dooray Managed Calendar//EN","BEGIN:VEVENT",
  "UID:"+uid,"DTSTAMP:"+stamp(),"DTSTART:"+start,"DTEND:"+end,"SUMMARY:"+escaped(input.title),
  ...(Object.hasOwn(input,"location")?["LOCATION:"+escaped(input.location)]:[]),"CLASS:"+v,"TRANSP:TRANSPARENT","END:VEVENT","END:VCALENDAR",""].map(fold).join("\r\n");
}
export const validateManagedArgs=(kind,q)=>{
 check(fields(q,kind==="create"?cfields:dfields)&&KEY.test(q.calendarKey)&&typeof q.calendarKey==="string"&&typeof q.requestId==="string"&&ID.test(q.requestId)&&q.ownerOnlyConfirmed===true,"MANAGED_INPUT");
 if(kind==="delete"){check(controlled(q.uid)&&typeof q.expectedTag==="string"&&TAG.test(q.expectedTag),"MANAGED_DELETE_INPUT");return;}
 if(Object.hasOwn(q,"restoreArchiveId")){
  check(fields(q,[...base,'restoreArchiveId'])&&typeof q.restoreArchiveId==="string"&&ID.test(q.restoreArchiveId),"MANAGED_RESTORE_INPUT");
 }else{
  check(text(q.title,200)&&q.title.trim()===q.title&&q.title.length>0&&["PRIVATE","PUBLIC"].includes(q.visibility)&&(!Object.hasOwn(q,"location")||text(q.location,200)),"MANAGED_CREATE_INPUT");
  check(normalizeTime(q.start)<normalizeTime(q.end),"MANAGED_BAD_TIME_ORDER");
 }
};
const syncdir=async(p)=>{const f=await fs.open(p,"r");try{await f.sync()}finally{await f.close()}};
async function dirOK(p){
 const s=await fs.lstat(p);check(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&await fs.realpath(p)===p,"MANAGED_STATE_PERMISSIONS");
}
async function directory(p){
 try{await fs.mkdir(p,{mode:0o700});await syncdir(resolve(p,".."))}catch(e){if(e.code!=="EEXIST")throw e}
 await dirOK(p);return p;
}
async function load(p){
 const s=await fs.lstat(p);check(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=65536,"MANAGED_STATE_PERMISSIONS");
 return fs.readFile(p,"utf8");
}
const from=async p=>JSON.parse(await load(p));
async function save(dir,name,data){
 check(typeof data==="string"&&Buffer.byteLength(data)<=65536,"MANAGED_STATE_DATA");const p=join(dir,name);
 const f=await fs.open(p,"wx",0o600);try{await f.writeFile(data,"utf8");await f.sync()}finally{await f.close()}
 await syncdir(dir);check(await load(p)===data,"MANAGED_BACKUP_UNVERIFIED");return H(data);
}
const saveJSON=(d,p,j)=>save(d,p,JSON.stringify(j));
const dataKeys=["UID","SUMMARY","DTSTART","DTEND","CLASS","TRANSP","LOCATION","DESCRIPTION","STATUS"];
function event(uid,body){
 const wire=normalizeSeoulCalendar(body);
 check(typeof wire==="string"&&wire.endsWith("\r\n"),"MANAGED_INVALID_BODY");
 const ls=wire.replace(/\r\n[ \t]/g,"").slice(0,-2).split("\r\n");
 const a=ls.indexOf("BEGIN:VEVENT"),b=ls.indexOf("END:VEVENT");check(a>0&&b>a&&ls[0]==="BEGIN:VCALENDAR"&&ls.at(-1)==="END:VCALENDAR","MANAGED_SHAPE");
 const ev={}, cal={};
 for(let i=1;i<ls.length-1;i++){
  if(i===a||i===b)continue;
  const t=ls[i],m=/^([A-Z-]+):(.*)$/.exec(t);
  check(m&&m[1]!=="BEGIN"&&m[1]!=="END","MANAGED_UNSUPPORTED_PROPERTY");
  const o=i>a&&i<b?ev:cal,k=m[1];
  check((o===ev?[...dataKeys,"CREATED","DTSTAMP","LAST-MODIFIED","SEQUENCE"]:["VERSION","PRODID","CALSCALE"]).includes(k)&&!Object.hasOwn(o,k),"MANAGED_UNSUPPORTED_PROPERTY");
  o[k]=m[2];
 }
 check(cal.VERSION==="2.0"&&!!cal.PRODID&&ev.UID===uid&&ev.SUMMARY?.length>0&&/^\d{8}T\d{6}Z$/.test(ev.DTSTART||"")&&/^\d{8}T\d{6}Z$/.test(ev.DTEND||"")&&ev.DTSTART<ev.DTEND&&/^\d{8}T\d{6}Z$/.test(ev.DTSTAMP||"")&&["PUBLIC","PRIVATE"].includes(ev.CLASS)&&ev.TRANSP==="TRANSPARENT"&&(!ev.STATUS||ev.STATUS==="CONFIRMED"||ev.STATUS==="TENTATIVE"),"MANAGED_OBJECT_NOT_RESTORABLE");
 const view=Object.fromEntries(dataKeys.map(k=>[k,ev[k]??""]));
 return {wire,view};
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const wireSimilar=(a,b)=>a.replace(/^DTSTAMP:\d{8}T\d{6}Z\r\n/m,"DTSTAMP:<provider-clock>\r\n")===b.replace(/^DTSTAMP:\d{8}T\d{6}Z\r\n/m,"DTSTAMP:<provider-clock>\r\n");
async function tx(root,kind,q,fn){
 validateManagedArgs(kind,q);await dirOK(root);
 const state=await directory(join(root,rdir));
 const ledger=await directory(join(state,"ledger")), list=await directory(join(state,kind));
 const p=join(list,q.requestId), fingerprint=H(JSON.stringify(Object.entries(q).sort()));
 try{await fs.mkdir(p,{mode:0o700});await syncdir(list)}catch(e){
  if(e.code!=="EEXIST")throw e;
  await dirOK(p);let marker;
  try{marker=await from(join(p,"intent.json"))}catch(e2){if(e2.code==="ENOENT")return {state:"request_started_do_not_retry",requestId:q.requestId};throw e2}
  check(marker.fingerprint===fingerprint,"MANAGED_REQUEST_CONFLICT");
  try{return await from(join(p,"result.json"))}catch(e2){if(e2.code==="ENOENT")return {state:"request_started_do_not_retry",requestId:q.requestId};throw e2}
 }
 await dirOK(p);await saveJSON(p,"intent.json",{fingerprint,calendarKey:q.calendarKey});
 const result={requestId:q.requestId,state:"not_started",attempted:false};
 try{await fn(state,ledger,p,result)}catch(e){result.error=reason(e);result.state=result.attempted?"attempt_unverified_do_not_retry":"stopped_before_action";}
 await saveJSON(p,"result.json",result);return result;
}
const bind=(q,identity)=>check(identity?.uid===q.uid&&identity?.calendarKey===q.calendarKey&&identity.member===q.uid+".ics","MANAGED_IDENTITY_MISMATCH");
export const createManaged=(root,connect,q)=>tx(root,"create",q,async(state,ledger,p,out)=>{
 let uid,body,restoring=false;
 if(q.restoreArchiveId){
  const prev=join(state,"delete",q.restoreArchiveId);await dirOK(prev);
  const r=await from(join(prev,"result.json")), a=await from(join(prev,"archive.json"));uid=a.uid;
  check(r.state==="deleted_verified"||r.state==="absent_after_single_attempt","MANAGED_RESTORE_NOT_VERIFIED");
  check(controlled(uid),"MANAGED_RESTORE_ID");
  bind({...q,uid},a);bind({...q,uid},await from(join(ledger,uid+'.json')));body=await load(join(prev,"restorable.ics"));check(H(body)===a.sha256,"MANAGED_BACKUP_UNVERIFIED");restoring=true;
 }else{uid=derived(q.calendarKey,q.requestId);body=document(uid,q)}
 out.uid=uid;out.member=uid+".ics";const io=await connect({calendarKey:q.calendarKey});
 const intended=event(uid,body);io.validateManagedRestore(uid,body);
 const before=await io.getFixturePath(uid);check(before===null,"MANAGED_CREATE_TARGET_EXISTS");
 await save(p,"intended.ics",body);await saveJSON(p,"create-attempted.json",{uid,calendarKey:q.calendarKey});
 out.attempted=true;
 try{out.httpStatus=(await io.createManagedMember(uid,body))?.status??null}catch(e){out.httpWarning=reason(e)}
 const after=await io.getFixturePath(uid);check(after?.uid===uid&&TAG.test(after.etag),"MANAGED_CREATE_UNVERIFIED");
 check(same(event(uid,after.body).view,intended.view),"MANAGED_CREATE_READBACK_MISMATCH");
 // A rejected conditional create is not our operation even if a concurrent copy looks identical.
 check(out.httpStatus===201||out.httpStatus==null,"MANAGED_CREATE_REJECTED");
 const id={uid,member:uid+".ics",calendarKey:q.calendarKey};
 if(!restoring){await saveJSON(ledger,uid+".json",id);}
 out.state=restoring?"restored_verified":"created_verified";out.etag=after.etag;out.visibility=intended.view.CLASS;
});
export const deleteManaged=(root,connect,q)=>tx(root,"delete",q,async(state,ledger,p,out)=>{
 const id=await from(join(ledger,q.uid+".json")).catch(e=>{if(e.code==="ENOENT")throw Error("MANAGED_CREATE_PROVENANCE_REQUIRED");throw e});
 bind(q,id);out.uid=q.uid;
 const io=await connect({calendarKey:q.calendarKey}),before=await io.getFixturePath(q.uid);
 if(before===null){out.state="already_absent";return}
 check(before.uid===q.uid&&TAG.test(before.etag)&&before.etag===q.expectedTag,"CONFLICT");
 const prior=event(q.uid,before.body);io.validateManagedRestore(q.uid,prior.wire);
 check(same(event(q.uid,prior.wire).view,prior.view),"MANAGED_BACKUP_UNVERIFIED");
 const rawHash=await save(p,"original.ics",before.body),sha256=await save(p,"restorable.ics",prior.wire);
 await saveJSON(p,"archive.json",{...id,rawHash,sha256,tag:before.etag});
 check(H(await load(join(p,"restorable.ics")))===sha256&&(await from(join(p,"archive.json"))).sha256===sha256,"MANAGED_BACKUP_UNVERIFIED");
 const fresh=await io.getFixturePath(q.uid);check(fresh?.uid===q.uid&&fresh.etag===q.expectedTag&&wireSimilar(event(q.uid,fresh.body).wire,prior.wire),"CONFLICT");
 await saveJSON(p,"delete-attempted.json",{uid:q.uid,tag:q.expectedTag,sha256});out.attempted=true;out.restoreArchiveId=q.requestId;
 try{out.httpStatus=(await io.deleteManagedMember(q.uid,q.expectedTag,prior.wire))?.status??null}catch(e){out.httpWarning=reason(e)}
 out.freshAbsent=(await io.getFixturePath(q.uid))===null;check(out.freshAbsent,"MANAGED_DELETE_UNVERIFIED");
 out.state=[200,204].includes(out.httpStatus)?"deleted_verified":"absent_after_single_attempt";
});

export async function readExactVersion(io,q){
 const value=q.member?await io.getKnownMember(q.uid,q.member):await io.getByUid(q.uid);
 check(value?.uid===q.uid&&typeof value.etag==="string"&&TAG.test(value.etag),"RESOURCE_ID_OR_ETAG");
 return {uid:q.uid,etag:value.etag};
}
