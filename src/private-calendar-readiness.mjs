import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

const parser=new XMLParser({ignoreAttributes:false,processEntities:false,trimValues:true,parseTagValue:false,maxNestedTags:48});
export const READINESS_BODY='<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-privilege-set/></d:prop></d:propfind>';
const zero=kind=>({kind,bind:false,unbind:false,writeContentOnCollection:false});
const seq=x=>Array.isArray(x)?x:[x];
function elements(obj,inherit=Object.create(null)){
 if(!obj||typeof obj!=='object')return [];
 const my=Object.assign(Object.create(null),inherit);
 for(const [k,v] of Object.entries(obj)){
  if(k==='@_xmlns')my['']=v;
  else if(k.startsWith('@_xmlns:'))my[k.slice(8)]=v;
 }
 const rows=[];
 for(const [k,v] of Object.entries(obj)){
  if(k.startsWith('@')||k[0]==='#'||k[0]==='?')continue;
  const split=k.split(':'); if(split.length>2)continue;
  const prefix=split.length===2?split[0]:'', local=split.at(-1);
  for(const item of seq(v)) {
   const childNs=Object.assign(Object.create(null),my);
   if(item&&typeof item==='object')for(const [key,val] of Object.entries(item)){
    if(key==='@_xmlns')childNs['']=val;
    else if(key.startsWith('@_xmlns:'))childNs[key.slice(8)]=val;
   }
   rows.push({local,ns:childNs[prefix],v:item,nsMap:childNs});
  }
 }
 return rows;
}
const kids=(n,k)=>elements(n.v,n.nsMap).filter(e=>e.ns==='DAV:'&&e.local===k);
const stringValue=n=>typeof n?.v==='string'?n.v:typeof n?.v?.['#text']==='string'?n.v['#text']:'';
export function inspectCollectionPermissions(xml,href,origin) {
 if(typeof xml!=='string'||Buffer.byteLength(xml)>65536||/<!DOCTYPE|<!ENTITY/.test(xml))return zero('unreported');
 let root;try{root=elements(parser.parse(xml));}catch{return zero('unreported');}
 if(root.length!==1||root[0].ns!=='DAV:'||root[0].local!=='multistatus')return zero('unreported');
 const found=kids(root[0],'response').filter(n=>{
   const h=kids(n,'href');if(h.length!==1)return false;
   try{const u=new URL(stringValue(h[0]),origin);return u.origin===new URL(origin).origin&&u.pathname===href&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}
 });
 if(found.length!==1)return zero('unreported');
 let sets=[];
 for(const ps of kids(found[0],'propstat')){
  const st=kids(ps,'status');if(st.length!==1||!/^HTTP\/\d(?:\.\d)? 200(?: |$)/i.test(stringValue(st[0])))continue;
  for(const p of kids(ps,'prop'))sets.push(...kids(p,'current-user-privilege-set'));
 }
 if(sets.length!==1)return zero('unreported');
 const names=new Set();
 for(const p of kids(sets[0],'privilege')){
  const entries=elements(p.v,p.nsMap);if(entries.length!==1) return zero('unreported');
  if(entries[0].ns==='DAV:') names.add(entries[0].local);
 }
 const write=names.has('write')||names.has('all');
 return {kind:'reported',bind:write||names.has('bind'),unbind:write||names.has('unbind'),writeContentOnCollection:write||names.has('write-content')};
}
export function pin(href){return createHash('sha256').update(href,'utf8').digest('hex');}
