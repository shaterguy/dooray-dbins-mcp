import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {openIO} from "../src/private-calendar-live-io.mjs";
import {startPrivateOperator,callPrivateOperator} from "../src/private-calendar-operator.mjs";
import {createManaged,deleteManaged,validateManagedArgs} from "../src/private-calendar-managed.mjs";
const href="/owner/calendar/",home="/owner/",key=createHash("sha256").update(href).digest("hex");
const ids=["269f1600-c624-461a-9d1e-0d0239327106","3e1a6673-9b29-40b0-a7f3-ef185f43bd04","c0786f94-8879-42fe-b2a0-a1dfadd43702","d923b056-d58f-46d1-8d1d-cdb58da229f6","62073a46-6d8b-4a8a-ae34-b92793ac272c"];
const base={calendarKey:key,ownerOnlyConfirmed:true}, seed={...base,requestId:ids[0],title:"한글 제목 \\ test, punctuation; "+'한'.repeat(24),start:"2026-11-20T07:10:00Z",end:"2026-11-20T07:20:00Z",visibility:"PUBLIC",location:"개인 위치"};
const del=(uid,etag,i=1)=>({...base,requestId:ids[i],uid,expectedTag:etag});
async function setup(t){
 const root=await fs.mkdtemp(join(tmpdir(),"dooray-managed-test-"));
 t.after(async()=>{await fs.rm(root,{recursive:true,force:true})});
 let event=null,eid=0,put=0,deletes=0;const flags={};
 const connect=async q=>{
  assert.deepEqual(q,{calendarKey:key});
  return openIO({list:async()=>[{href}],home:async()=>home,canonicalize:x=>x,
   async send(p,r){
    assert.match(p,/^\/owner\/calendar\/moru-private-[a-f0-9-]{36}\.ics$/);
    if(r.method==="GET"){if(!event||event.path!==p)return {status:404};if(r.match&&r.match!==event.etag)return {status:412};return {status:200,etag:event.etag,body:event.body,type:"text/calendar"}}
    if(r.method==="PUT"){
     assert.equal(r.create,true);assert.equal(r.match,undefined);put++;if(event)return {status:412};
     assert.doesNotMatch(r.body,/^ATTENDEE:|^ORGANIZER:|^BEGIN:VALARM|^METHOD:/m);
     assert.ok(r.body.split("\r\n").every(l=>Buffer.byteLength(l)<=75));
     event={body:r.body,etag:'"version'+(++eid)+'"',path:p};
     if(flags.ambiguousPut)throw Error("AMBIGUOUS_PUT");return {status:201}
    }
    assert.equal(r.method,"DELETE");assert.equal(r.match,event.etag);deletes++;
    const archivePath=join(root,".calendar-managed-v1","delete",flags.delId||ids[1],"restorable.ics");
    const restored=await fs.readFile(archivePath,"utf8");
    assert.equal(restored,event.body);assert.equal((await fs.lstat(archivePath)).mode&0o077,0);
    if(flags.conflict)return {status:412};
    event=null;if(flags.ambiguousDelete)throw Error("AMBIGUOUS_DELETE");return {status:204};
   }},{calendarKey:key});
 };
 return {root,connect,counts:()=>[put,deletes],current:()=>event,flags};
}
test("create and verified delete, then recover the exact UID and public classification with a conditional create",async t=>{
 const x=await setup(t);const c=await createManaged(x.root,x.connect,seed);
 assert.equal(c.state,"created_verified",JSON.stringify(c));assert.equal(c.visibility,"PUBLIC");assert.equal(c.member,c.uid+".ics");
 const orig=x.current().body;
 assert.deepEqual(await createManaged(x.root,x.connect,seed),c);assert.deepEqual(x.counts(),[1,0]);
 await assert.rejects(createManaged(x.root,x.connect,{...seed,title:"Alt"}),/MANAGED_REQUEST_CONFLICT/);
 const d=await deleteManaged(x.root,x.connect,del(c.uid,c.etag));
 assert.equal(d.state,"deleted_verified",JSON.stringify(d));assert.equal(d.restoreArchiveId,ids[1]);assert.equal(x.current(),null);
 assert.deepEqual(await deleteManaged(x.root,x.connect,del(c.uid,c.etag)),d);
 const a=await createManaged(x.root,x.connect,{...base,requestId:ids[2],restoreArchiveId:d.restoreArchiveId});
 assert.equal(a.state,"restored_verified",JSON.stringify(a));assert.equal(a.uid,c.uid);
 assert.equal(x.current().body,orig);assert.deepEqual(x.counts(),[2,1]);
});
test("private visibility, stale expected tag and user-added attendees fail closed",async t=>{
 const x=await setup(t);const c=await createManaged(x.root,x.connect,{...seed,visibility:"PRIVATE"});
 assert.equal(c.state,"created_verified",JSON.stringify(c));assert.equal(c.visibility,"PRIVATE");
 const a=await deleteManaged(x.root,x.connect,del(c.uid,'"stale"'));
 assert.equal(a.error,"CONFLICT");
 x.current().body=x.current().body.replace("END:VEVENT","ATTENDEE:mailto:person@example.invalid\r\nEND:VEVENT");
 const b=await deleteManaged(x.root,x.connect,del(c.uid,c.etag,2));
 assert.equal(b.state,"stopped_before_action");assert.deepEqual(x.counts(),[1,0]);
});
test("unknown provider write outcomes are never retried",async t=>{
 const x=await setup(t);x.flags.ambiguousPut=true;x.flags.ambiguousDelete=true;
 const c=await createManaged(x.root,x.connect,seed);assert.equal(c.state,"created_verified",JSON.stringify(c));
 const d=await deleteManaged(x.root,x.connect,del(c.uid,c.etag));
 assert.equal(d.state,"absent_after_single_attempt",JSON.stringify(d));assert.equal(d.restoreArchiveId,ids[1]);
 assert.deepEqual(x.counts(),[1,1]);
 assert.deepEqual(await deleteManaged(x.root,x.connect,del(c.uid,c.etag)),d);assert.deepEqual(x.counts(),[1,1]);
});
test("unmanaged, different calendar, lost backup and no consent are blocked",async t=>{
 const x=await setup(t);
 let connected=0;const c0=await deleteManaged(x.root,async()=>{connected++;throw Error("should not connect");},del('moru-private-'+ids[0],'"not-managed"'));
 assert.equal(c0.error,"MANAGED_CREATE_PROVENANCE_REQUIRED");assert.equal(connected,0);
 const c=await createManaged(x.root,x.connect,seed);assert.equal(c.state,"created_verified");
 const m=await deleteManaged(x.root,x.connect,{...del(c.uid,c.etag,2),calendarKey:"a".repeat(64)});assert.equal(m.error,"MANAGED_IDENTITY_MISMATCH");
 await assert.rejects(createManaged(x.root,x.connect,{...seed,ownerOnlyConfirmed:false}),/MANAGED_INPUT/);
 await assert.rejects(createManaged(x.root,x.connect,{...seed,title:"abc\r\nATTENDEE:first"}),/MANAGED_CREATE_INPUT/);
 assert.throws(()=>validateManagedArgs("create",{...seed,start:"2026-02-30T00:00:00Z"}),/MANAGED_UTC_TIME/);
 x.flags.delId=ids[3];const d=await deleteManaged(x.root,x.connect,del(c.uid,c.etag,3));assert.equal(d.state,"deleted_verified");
 await fs.appendFile(join(x.root,".calendar-managed-v1","delete",d.restoreArchiveId,"restorable.ics"),"corrupted");
 const z=await createManaged(x.root,x.connect,{...base,requestId:ids[4],restoreArchiveId:d.restoreArchiveId});
 assert.equal(z.error,"MANAGED_BACKUP_UNVERIFIED");assert.deepEqual(x.counts(),[1,1]);
});
test("owner-local tool list excludes edits and exposes only narrow schema",async t=>{
 const x=await setup(t);
 const run=await startPrivateOperator(x.root,{private_calendar_preflight:async()=>({read:true}),private_calendar_version:async()=>({read:true}),private_calendar_create:async q=>createManaged(x.root,x.connect,q),private_calendar_delete:async q=>deleteManaged(x.root,x.connect,q)});
 t.after(()=>run.close());
 const call=(name,args)=>callPrivateOperator(x.root,{jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}});
 const list=await callPrivateOperator(x.root,{jsonrpc:"2.0",id:2,method:"tools/list"});
 assert.deepEqual(list.result.tools.map(o=>o.name).sort(),["private_calendar_create","private_calendar_delete","private_calendar_preflight","private_calendar_version"]);
 for(const n of ["private_calendar_edit","private_calendar_fixture_once"])assert.equal((await call(n,base)).error.message,"INVALID_REQUEST");
 assert.equal((await call("private_calendar_create",{...seed,alarms:[10]})).error.message,"INVALID_REQUEST");
 assert.equal((await call("private_calendar_create",{...seed,ownerOnlyConfirmed:false})).error.message,"INVALID_REQUEST");
 assert.deepEqual(x.counts(),[0,0]);
 const c=(await call("private_calendar_create",seed)).result.structuredContent;assert.equal(c.state,"created_verified",JSON.stringify(c));
 const d=(await call("private_calendar_delete",del(c.uid,c.etag))).result.structuredContent;assert.equal(d.state,"deleted_verified",JSON.stringify(d));
});
