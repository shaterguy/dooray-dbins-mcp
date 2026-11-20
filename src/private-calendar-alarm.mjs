import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createHash } from "node:crypto";
const D="DAV:", C="urn:ietf:params:xml:ns:caldav", A="default-alarm-vevent-datetime";
const P=new XMLParser({preserveOrder:true,ignoreAttributes:false,attributeNamePrefix:"",parseTagValue:false,parseAttributeValue:false,processEntities:false,trimValues:false,ignoreDeclaration:true});
const bad=()=>{throw Error("UNVERIFIED_DAV_RESPONSE")};
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
export function safePath(href){
 if(typeof href!=="string"||!href.startsWith("/")||href.startsWith("//")||href.length>1600||/[\x00-\x20\x7f\\?#&]|%(?:00|2f|5c|2e|25)/i.test(href)||href.includes("//")||/(^|\/)\.{1,2}(\/|$)/.test(href))bad();
 const u=new URL(href,"https://invalid.example");
 if(u.pathname!==href)bad();
 return href;
}
function collectionPath(h){const p=safePath(h);return p.endsWith("/")?p:p+"/"}
export function inspectTimedAlarm(xml, expectedPath, canonicalize=safePath){
 const r=one(select(tree(xml),D,"response"));
 if(select(r,D,"status").length)bad();
 const responsePath=canonicalize(onlyText(one(select(r,D,"href"))));
 if(responsePath!==expectedPath)bad();
 const matches=[];
 for(const s of select(r,D,"propstat")){
  const prop=one(select(s,D,"prop"));const props=select(prop,C,A);
  if(!props.length)continue;
  const status=onlyText(one(select(s,D,"status"))).trim().match(/^HTTP\/(?:1\.[01]|2(?:\.0)?) ([0-9]{3})(?: [^\r\n]*)?$/);
  if(!status||props.length!==1)bad();
  const value=onlyText(props[0]);
  matches.push(status[1]==="200"?(value===""?"explicit-empty":value.trim()?"nonempty":"invalid"):status[1]==="404"?"absent-or-unsupported":status[1]==="403"?"forbidden":"unknown");
 }
 return matches.length===1?matches[0]:"unknown";
}
export function evidence(c,h,ca,ha){
 if(c==="nonempty")return "collection-configured";
 if(c==="explicit-empty"&&ca===true)return "collection-explicit-empty";
 if(c==="absent-or-unsupported"&&ca===true&&ha===true){
  if(h==="explicit-empty")return "inherited-explicit-empty";
  if(h==="nonempty")return "inherited-configured";
 }
 return "unknown";
}
const hash=s=>createHash("sha256").update(s).digest("hex");
const alarmBody='<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:default-alarm-vevent-datetime/></d:prop></d:propfind>';
export async function getAlarmEvidence(io,args){
 const base={protocol:"private-calendar-alarm-readiness-v1",collectionTimedAlarm:"unknown",homeTimedAlarm:"unknown",collectionAdvertised:null,homeAdvertised:null,alarmEvidence:"unknown",schedulingPolicy:"unverified",providerNotifications:"unverified",writeAllowed:false,reason:"unverified"};
 if(!args||Object.keys(args).length!==1||!Object.hasOwn(args,"calendarKey")||typeof args.calendarKey!=="string"||!/^[a-f0-9]{64}$/.test(args.calendarKey))return {...base,reason:"invalid-target"};
 try{
  const home=safePath(await io.home());
  const matches=(await io.list()).filter(v=>typeof v?.href==="string"&&hash(v.href)===args.calendarKey);
  if(matches.length!==1)return {...base,reason:"target-mismatch"};
  const cal=safePath(matches[0].href),prefix=collectionPath(home),relative=cal.slice(prefix.length).replace(/\/$/,"");
  if(!cal.startsWith(prefix)||!relative||relative.includes("/"))return {...base,reason:"target-not-home-child"};
  const opts=async h=>{try{const b=await io.options(h);return typeof b==="boolean"?b:null}catch{return null}};
  const probe=async h=>{try{return inspectTimedAlarm(await io.propfind(h,alarmBody),h,io.canonicalize)}catch{return "unknown"}};
  base.collectionTimedAlarm=await probe(cal);base.homeTimedAlarm=await probe(home);
  base.collectionAdvertised=await opts(cal);base.homeAdvertised=await opts(home);
  base.alarmEvidence=evidence(base.collectionTimedAlarm,base.homeTimedAlarm,base.collectionAdvertised,base.homeAdvertised);
  return {...base,reason:"provider-notification-or-scheduling-policy-unverified"};
 }catch{return {...base,reason:"discovery-unverified"}}
}
