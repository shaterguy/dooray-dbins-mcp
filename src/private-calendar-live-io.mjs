import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createHash } from "node:crypto";
const D="DAV:", C="urn:ietf:params:xml:ns:caldav";
const P=new XMLParser({preserveOrder:true,ignoreAttributes:false,attributeNamePrefix:"",parseTagValue:false,parseAttributeValue:false,processEntities:false,trimValues:false,ignoreDeclaration:true});
const fail=c=>{throw Object.assign(new Error(c),{code:c})}; const bad=()=>fail("PRIVATE_DAV_XML_UNVERIFIED");
function tree(xml){
 if(typeof xml!=="string"||Buffer.byteLength(xml)>65536||/<!DOCTYPE|<!ENTITY|<\?(?!xml(?:\s|\?>))|<!--/i.test(xml)||XMLValidator.validate(xml)!==true)bad();
 let count=0;
 function node(item,scope,level){
  if(++count>4096||level>24)bad();
  let keys=Object.keys(item).filter(k=>k!==":@");
  if(keys.length!==1)bad();
  const k=keys[0];if(k==="#text")return {t:String(item[k])};
  if(k.startsWith("#")||k.startsWith("?")||k.startsWith("!"))bad();
  const ns=new Map(scope);
  for(const [n,v] of Object.entries(item[":@"]||{})){
   if(n==="xmlns")ns.set("",v);else if(n.startsWith("xmlns:"))ns.set(n.substring(6),v);
  }
  const names=k.split(":");if(names.length>2)bad();
  const prefix=names.length===2?names[0]:"", uri=ns.get(prefix);
  if(!uri)bad();
  if(!Array.isArray(item[k]))bad();
  return {uri,name:names.at(-1),children:item[k].map(x=>node(x,ns,level+1))};
 }
 const roots=P.parse(xml).map(i=>node(i,new Map,0)).filter(v=>v.t===undefined||v.t.trim());
 if(roots.length!==1||roots[0].uri!==D||roots[0].name!=="multistatus")bad();
 return roots[0];
}
const select=(n,uri,name)=>n.children.filter(x=>x.uri===uri&&x.name===name);
const one=xs=>xs.length===1?xs[0]:bad();
const onlyText=n=>n.children.map(i=>i.t===undefined?bad():i.t).join("");

import {safePath} from "./private-calendar-alarm.mjs";
const id=v=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,254}$/.test(v)?v:fail("PRIVATE_UID_INVALID");
const fix=v=>/^moru-private-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id(v))?v:fail("PRIVATE_FIXTURE_UID_INVALID");
const et=v=>typeof v==="string"&&/^"[\x21\x23-\x7e]{1,190}"$/.test(v)?v:fail("PRIVATE_STRONG_ETAG_REQUIRED");
const xdecode=s=>s.replace(/&quot;/g,'"').replace(/&#(13|x0?d);/gi,"\r").replace(/&#(10|x0?a);/gi,"\n");
const H=s=>createHash("sha256").update(s).digest("hex");
function validlines(body){
 if(typeof body!=="string"||Buffer.byteLength(body)>65536||body.includes("\ufffd")||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\r(?!\n)/.test(body))fail("PRIVATE_ICAL_INVALID");
 const ls=body.replace(/\r?\n[ \t]/g,"").replace(/\r\n/g,"\n").split("\n");
 if(ls.at(-1)==="")ls.pop();
 if(ls.length>1024||ls[0]!=="BEGIN:VCALENDAR"||ls.at(-1)!=="END:VCALENDAR")fail("PRIVATE_ICAL_INVALID");
 return ls;
}
// Validation projection only. No network access, no serialization of a new wire body.
const FIXED_SEOUL_ZONE_DIGEST="03230b40fd531c787e3c35c115788bc383bead23807e92dc20ce9522f9d03229";
function seoulProjection(body) {
 const ls=validlines(body), has=ls.some(l=>/^BEGIN:VTIMEZONE$|^METHOD[;:]|^DT(?:START|END);TZID=/i.test(l));
 if(!has)return {text:body,signature:null};
 const vi=ls.indexOf("BEGIN:VTIMEZONE"), ve=ls.indexOf("END:VTIMEZONE"), ei=ls.indexOf("BEGIN:VEVENT"), ee=ls.indexOf("END:VEVENT"), mi=ls.indexOf("METHOD:PUBLISH");
 if(vi<1||ve<=vi||mi<1||mi>=ei||vi>=ei||ve>=ei||ee<=ei||ls.filter(l=>/^METHOD[;:]/i.test(l)).length!==1||
   ls.filter(l=>/^BEGIN:VTIMEZONE$/i.test(l)).length!==1||ls.filter(l=>/^END:VTIMEZONE$/i.test(l)).length!==1||
   H(ls.slice(vi,ve+1).join("\n"))!==FIXED_SEOUL_ZONE_DIGEST)fail("PRIVATE_PROVIDER_ZONE_UNVERIFIED");
 const zoneBytes=/(?:^|\n)(BEGIN:VTIMEZONE\r?\n[\s\S]*?\nEND:VTIMEZONE)(?=\r?\n|$)/.exec(body)?.[1];
 if(!zoneBytes||!/(?:^|\n)METHOD:PUBLISH(?=\r?\n|$)/.test(body))fail("PRIVATE_PROVIDER_ZONE_UNVERIFIED");
 const out=[];let sd=0,ed=0;
 for(let i=0;i<ls.length;i++){
  if(i>=vi&&i<=ve||i===mi)continue;const l=ls[i];
  if(i>ei&&i<ee&&/^DT(?:START|END)[;:]/i.test(l)){
   const a=/^(DTSTART|DTEND);TZID=Asia\/Seoul:((\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d))$/.exec(l);
   if(!a)fail("PRIVATE_PROVIDER_DATE_UNVERIFIED");
   const parts=a.slice(3).map(Number),[y,mo,d,h,n,s]=parts;
   if(y<1971||y>9998)fail("PRIVATE_PROVIDER_DATE_UNVERIFIED");
   const stamp=Date.UTC(y,mo-1,d,h,n,s),rep=new Date(stamp);
   const rt=[rep.getUTCFullYear(),rep.getUTCMonth()+1,rep.getUTCDate(),rep.getUTCHours(),rep.getUTCMinutes(),rep.getUTCSeconds()];
   if(rt.some((v,j)=>v!==parts[j]))fail("PRIVATE_PROVIDER_DATE_UNVERIFIED");
   if(a[1]==="DTSTART")sd++;else ed++;
   out.push(a[1]+":"+new Date(stamp-9*3600000).toISOString().replace(/[-:]/g,"").replace(".000Z","Z"));continue;
  }
  out.push(l);
 }
 if(sd!==1||ed!==1)fail("PRIVATE_PROVIDER_DATE_UNVERIFIED");
 return {text:out.join("\r\n")+"\r\n",signature:H(zoneBytes+"\nMETHOD:PUBLISH")};
}
export function normalizeSeoulCalendar(body){return seoulProjection(body).text}
function extract(body,{projection=false,write=false,existing=false,allowManagedPublic=false}={}){
 const ls=validlines(normalizeSeoulCalendar(body));let stack=[],uid,events=0,alarms=[],a=null;
 const allowCal=new Set(["VERSION","PRODID","CALSCALE"]);
 const allowEv=new Set(["UID","DTSTAMP","CREATED","LAST-MODIFIED","DTSTART","DTEND","DURATION","SUMMARY","DESCRIPTION","LOCATION","CLASS","TRANSP","STATUS","SEQUENCE"]);
 for(const line of ls){
  const i=line.indexOf(":"), field=line.slice(0,i),val=line.slice(i+1),name=field.split(";")[0].toUpperCase();
  if(i<1||!/^[A-Z0-9-]+$/.test(name))fail("PRIVATE_ICAL_INVALID");
  const parent=stack.at(-1);
  if(name==="BEGIN"){
   if(field!=="BEGIN"||!(stack.length===0&&val==="VCALENDAR"||parent==="VCALENDAR"&&val==="VEVENT"||!projection&&parent==="VEVENT"&&val==="VALARM"))fail("PRIVATE_COMPONENT_UNSUPPORTED");
   if(val==="VEVENT")events++;if(val==="VALARM"){a=[];alarms.push(a)}
   stack.push(val); if(a)a.push(line); continue;
  }
  if(name==="END"){
   if(field!=="END"||val!==stack.pop())fail("PRIVATE_ICAL_INVALID");
   if(a)a.push(line);if(val==="VALARM")a=null;continue;
  }
  if(!parent)fail("PRIVATE_ICAL_INVALID");
  if(a){a.push(line);if((write||existing)&&!["ACTION","TRIGGER","DESCRIPTION","DURATION","REPEAT","UID","X-WR-ALARMUID","X-APPLE-DEFAULT-ALARM","DEFAULT-ALARM","ACKNOWLEDGED"].includes(name))fail("PRIVATE_ALARM_UNSUPPORTED");if((write||existing)&&name==="ACTION"&&val!=="DISPLAY")fail("PRIVATE_ALARM_UNSUPPORTED");continue}
  if(parent==="VEVENT"&&name==="UID"){
   if(uid!==undefined||field!=="UID")fail("PRIVATE_ICAL_UID_AMBIGUOUS");uid=id(val)
  }
  if(projection&&!(parent==="VEVENT"&&name==="UID"||parent==="VCALENDAR"&&["VERSION","PRODID","CALSCALE"].includes(name)))fail("PRIVATE_UID_PROJECTION_UNSUPPORTED");
  if(write||existing){
   if(!(parent==="VCALENDAR"?allowCal:allowEv).has(name))fail("PRIVATE_ICAL_FIELD_UNSUPPORTED");
   if(!/^[A-Z0-9-]+$/.test(field))fail("PRIVATE_ICAL_PARAMETERS_UNSUPPORTED");
   if(name==="CLASS"&&val!=="PRIVATE"&&!(allowManagedPublic&&val==="PUBLIC"))fail("PRIVATE_ICAL_NOT_PRIVATE");
   if(name==="STATUS"&&val==="CANCELLED")fail("PRIVATE_ICAL_UNSUPPORTED_STATUS");
  }
 }
 if(stack.length||events!==1||!uid)fail("PRIVATE_ICAL_UID_AMBIGUOUS");
 return {uid,alarms:alarms.map(x=>x.join("\n"))}
}
function bodyOK(uid,body,old,allowManagedPublic=false){
 const ws=seoulProjection(body).signature, os=old?seoulProjection(old).signature:null;
 if(ws!==os)fail("PRIVATE_PROVIDER_METADATA_CHANGED");
 const r=extract(body,{write:true,allowManagedPublic});if(r.uid!==uid)fail("PRIVATE_UID_MISMATCH");
 const prior=old?extract(old,{existing:true}):{alarms:[]};
 if(prior.uid&&prior.uid!==uid)fail("PRIVATE_UID_MISMATCH");
 if(r.alarms.some(x=>!prior.alarms.includes(x))||r.alarms.length>prior.alarms.length||new Set(r.alarms).size!==r.alarms.length)fail("PRIVATE_NEW_ALARM_FORBIDDEN");
}
function strongHttp(signal,status){if(!signal)fail("PRIVATE_HTTP_"+Number(status||0))}
export async function openIO(io,args){
 if(!args||Object.keys(args).length!==1||typeof args.calendarKey!=="string"||!/^[a-f0-9]{64}$/.test(args.calendarKey))fail("PRIVATE_CALENDAR_KEY_INVALID");
 const home=safePath(await io.home()), hprefix=home.replace(/\/?$/,"/");
 const items=(await io.list()).filter(v=>typeof v?.href==="string"&&H(v.href)===args.calendarKey);
 if(items.length!==1)fail("PRIVATE_CALENDAR_AMBIGUOUS");const c=safePath(items[0].href),prefix=c.replace(/\/?$/,"/");
 if(!prefix.startsWith(hprefix)||!/^([^/]+)\/$/.test(prefix.slice(hprefix.length)))fail("PRIVATE_CALENDAR_OUTSIDE_HOME");
 const child=raw=>{const p=safePath(io.canonicalize(raw));if(!p.startsWith(prefix)||!p.slice(prefix.length)||p.slice(prefix.length).includes("/"))fail("PRIVATE_RESOURCE_NOT_CHILD");return p};
 const fixture=uid=>child(prefix+fix(uid)+".ics");
 async function get(uid,p,tag=null){
  const v=await io.send(p,{method:"GET",privateIO:true,match:tag});if(v.status===404)return null;
  strongHttp(v.status===200,v.status);
  if(!/^text\/calendar(?:\s*;|$)/i.test(v.type||""))fail("PRIVATE_CALENDAR_CONTENT_TYPE");
  et(v.etag);if(tag&&v.etag!==tag)fail("PRIVATE_ETAG_CONFLICT");
  if(extract(v.body).uid!==id(uid))fail("PRIVATE_UID_MISMATCH");
  return {uid,body:v.body,etag:v.etag};
 }
 const fresh=new Set();
 async function resolve(uid,window=false){
  if(window)fix(uid);
  id(uid);
  const q='<c:calendar-query xmlns:c="'+C+'" xmlns:d="DAV:"><d:prop><d:getetag/><c:calendar-data><c:comp name="VCALENDAR"><c:comp name="VEVENT"><c:prop name="UID"/></c:comp></c:comp></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'+(window?'<c:time-range start="20010114T000000Z" end="20010115T000000Z"/>':'')+'<c:prop-filter name="UID"><c:text-match collation="i;octet">'+uid+'</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
  const v=await io.send(c,{method:"REPORT",body:q,depth:1,privateIO:true});strongHttp(v.status===207,v.status);
  if(!/^(?:application|text)\/xml(?:\s*;|$)/i.test(v.type||""))fail("PRIVATE_DAV_CONTENT_TYPE");
  const xml=tree(v.body);if(xml.children.some(x=>x.t===undefined&&(x.uri!==D||x.name!=="response")))bad();
  const rows=select(xml,D,"response"), hits=[]; if(window&&rows.length>1)fail("PRIVATE_WINDOW_FILTER_UNVERIFIED");if(rows.length>4)fail("PRIVATE_UID_AMBIGUOUS");
  for(const r of rows){
   if(select(r,D,"status").length)bad();
   const p=child(onlyText(one(select(r,D,"href")))), props=[];
   if(window&&p!==fixture(uid))fail("PRIVATE_WINDOW_FILTER_UNVERIFIED");
   const own=fresh.has(uid)&&rows.length===1&&p===fixture(uid);
   let missingETag=false;
   for(const st of select(r,D,"propstat")){
    const state=onlyText(one(select(st,D,"status"))).trim(), group=one(select(st,D,"prop"));
    if(/^HTTP\/(?:1\.[01]|2(?:\.0)?) 200(?: [^\r\n]*)?$/.test(state)){props.push(group);continue}
    const children=group.children.filter(x=>x.t===undefined);
    if(own&&!missingETag&&/^HTTP\/(?:1\.[01]|2(?:\.0)?) 404(?: [^\r\n]*)?$/.test(state)&&children.length===1&&children[0].uri===D&&children[0].name==="getetag"){missingETag=true;continue}
    bad();
   }
   const data=xdecode(onlyText(one(props.flatMap(x=>select(x,C,"calendar-data")))));
   const tags=props.flatMap(x=>select(x,D,"getetag"));
   if(tags.length>1||tags.length&&missingETag)bad();
   let answer;
   try{answer=extract(data,{projection:true}).uid}
   catch(e){
    if(!own||!["PRIVATE_UID_PROJECTION_UNSUPPORTED","PRIVATE_COMPONENT_UNSUPPORTED"].includes(e?.code))throw e;
    answer=extract(data).uid;
    if(answer!==uid)fail("PRIVATE_UID_MISMATCH");
   }
   if(!tags.length&&(!own||answer!==uid))fail("PRIVATE_REPORT_ETAG_MISSING");
   const tag=tags.length?et(xdecode(onlyText(tags[0]))):null;
   if(window&&answer!==uid)fail("PRIVATE_WINDOW_FILTER_UNVERIFIED");
   if(answer===uid){
    if(fresh.has(uid)&&p!==fixture(uid))fail("PRIVATE_FIXTURE_PATH_MISMATCH");
    hits.push({p,tag});
   }
  }
  if(hits.length>1)fail("PRIVATE_UID_AMBIGUOUS");return hits[0]||null;
 }
 async function write(p,m,condition,body){
  const r=await io.send(p,{method:m,privateIO:true,...condition,...(body?{body}:{})});return {status:r.status};
 }
 const savedMember=name=>{
  if(typeof name!=="string"||name.length>200||!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(name)||name.includes(".."))fail("PRIVATE_MEMBER_INVALID");
  return child(prefix+name);
 };
 const ownedPath=uid=>{const p=fixture(uid);if(!fresh.has(uid))fail("PRIVATE_FRESH_FIXTURE_REQUIRED");return p};
 async function replaceAt(uid,p,tag,body){
  id(uid);et(tag);let snap;
  try{snap=await get(uid,p,tag)}catch(e){if(e?.code==="PRIVATE_HTTP_412")return {status:412};throw e}
  if(!snap)return {status:404};
  bodyOK(uid,body,snap.body);return write(p,"PUT",{match:tag},body);
 }
 // Exact synthetic resource read for local recovery only. Not a write validator.
 async function captureFixture(uid){
  const v=await io.send(fixture(uid),{method:"GET",privateIO:true});strongHttp(v.status===200,v.status);
  if(!/^text\/calendar(?:\s*;|$)/i.test(v.type||""))fail("PRIVATE_CALENDAR_CONTENT_TYPE");
  const tag=et(v.etag), lines=validlines(v.body), stack=[];let events=0,roots=0,seen=0;
  for(const l of lines){
   const marker=/^(BEGIN|END):([A-Z0-9-]+)$/i.exec(l);
   if(marker){
    const name=marker[2].toUpperCase(), par=stack.at(-1);
    if(marker[1].toUpperCase()==="BEGIN"){
     if(stack.length>16)fail("PRIVATE_CAPTURE_STRUCTURE");
     if(!par){if(name!=="VCALENDAR"||++roots!==1)fail("PRIVATE_CAPTURE_STRUCTURE")}
     else if(name==="VCALENDAR")fail("PRIVATE_CAPTURE_STRUCTURE");
     if(name==="VEVENT"){if(par!=="VCALENDAR"||++events!==1)fail("PRIVATE_CAPTURE_NOT_SINGLE_EVENT")}
     if(["VTODO","VJOURNAL","VFREEBUSY","VAVAILABILITY","VPOLL"].includes(name))fail("PRIVATE_CAPTURE_OTHER_RESOURCE");
     stack.push(name);
    } else if(name!==stack.pop())fail("PRIVATE_CAPTURE_STRUCTURE");
    continue;
   }
   if(!stack.length||/^(?:BEGIN|END)(?:;|:)/i.test(l))fail("PRIVATE_CAPTURE_STRUCTURE");
   if(stack.length===2&&stack[1]==="VEVENT"&&/^UID[;:]/i.test(l)){
    if(!/^UID:/i.test(l)||l.slice(4)!==uid||++seen!==1)fail("PRIVATE_CAPTURE_UID_MISMATCH");
   }
  }
  if(stack.length||roots!==1||events!==1||seen!==1)fail("PRIVATE_CAPTURE_UID_MISMATCH");
  return {uid,body:v.body,etag:tag};
 }
 return Object.freeze({
  captureFixture,
  validateManagedRestore(uid,body){fixture(uid);bodyOK(uid,body,undefined,true);},
  async createManagedMember(uid,body){
   const p=fixture(uid);bodyOK(uid,body,undefined,true);
   return write(p,"PUT",{create:true},body);
  },
  async deleteManagedMember(uid,tag,approved){
   const p=fixture(uid);et(tag);let current;
   try{current=await get(uid,p,tag)}catch(e){if(e?.code==="PRIVATE_HTTP_412")return {status:412};throw e}
   if(!current)return {status:404};
   const normalized=normalizeSeoulCalendar(current.body);
   const canonical=x=>x.replace(/^DTSTAMP:\d{8}T\d{6}Z\r\n/m,"DTSTAMP:<provider-clock>\r\n");
   if(canonical(normalized)!==canonical(approved))fail("MANAGED_DELETE_PRECONDITION_CHANGED");
   bodyOK(uid,normalized,undefined,true);return write(p,"DELETE",{match:tag});
  },
  async getFixtureInWindow(uid){
   fix(uid);
   const x=fresh.has(uid)?{p:ownedPath(uid),tag:null}:await resolve(uid,true);
   if(!x)return null;
   const snap=await get(uid,x.p,x.tag);if(!snap)fail("PRIVATE_WINDOW_RESOURCE_CHANGED");return snap
  },
  async getCreatedFixture(uid){return get(uid,ownedPath(uid))},
  async replaceCreatedFixture(uid,expectedETag,body){return replaceAt(uid,ownedPath(uid),expectedETag,body)},
  async getKnownMember(uid,member){id(uid);return get(uid,savedMember(member))},
  async replaceKnownMember(uid,member,expectedETag,body){id(uid);return replaceAt(uid,savedMember(member),expectedETag,body)},
  async getByUid(uid){const x=await resolve(uid);return x?get(uid,x.p,x.tag):null},
  async getFixturePath(uid){return get(uid,fixture(uid))},
  async createFixture(uid,body){const p=fixture(uid);bodyOK(uid,body);const r=await write(p,"PUT",{create:true},body);if(r.status===201)fresh.add(uid);return r},
  async replace(uid,expectedETag,body){
   id(uid);et(expectedETag);
   const x=await resolve(uid);if(!x)return {status:404};if(x.tag!==null&&x.tag!==expectedETag)return {status:412};
   const old=await get(uid,x.p,expectedETag);if(!old)return {status:404};bodyOK(uid,body,old.body);
   return write(x.p,"PUT",{match:expectedETag},body)
  },
  async deleteFixture(uid,expectedETag){
   const p=fixture(uid);et(expectedETag);const old=await get(uid,p,expectedETag);if(!old)return {status:404};
   bodyOK(uid,old.body,old.body);const r=await write(p,"DELETE",{match:expectedETag});if(r.status===200||r.status===204)fresh.delete(uid);return r
  }
 });
}
