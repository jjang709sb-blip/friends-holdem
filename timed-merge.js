'use strict';
const L=require('./timed-ledger');
function resolve(l,pid){const seen=new Set();while(l.mergeAliases?.[pid]){if(seen.has(pid))throw Error('정산 연결 순환 오류');seen.add(pid);pid=l.mergeAliases[pid];}return pid;}
function preview(l,from,to){if(from===to||resolve(l,from)!==from||resolve(l,to)!==to||!l.rows[from]||!l.rows[to])throw Error('서로 다른 정산 기록 두 개를 선택해주세요.');const a=l.rows[from],b=l.rows[to];return {from,to,fromName:a.name,toName:b.name,raw:String(BigInt(a.units)-BigInt(a.closedRaw||0)+BigInt(b.units)-BigInt(b.closedRaw||0)),lifetime:String(BigInt(a.units)+BigInt(b.units))};}
function merge(l,d){
 if(typeof d.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(d.requestId))throw Error('합치기 요청 오류');
 const old=(l.mergeAudit||[]).find(x=>x.id===d.requestId);if(old){if(old.from!==d.from||old.to!==d.to||old.actor!==d.actor)throw Error('합치기 요청 충돌');return false;}
 if(d.version!==l.version)throw Error('정산 내용이 변경되었습니다. 다시 확인해주세요.');
 const info=preview(l,d.from,d.to),a=l.rows[d.from],b=l.rows[d.to];
 const snapshot={rows:structuredClone(l.rows),aliases:structuredClone(l.mergeAliases||{}),names:structuredClone(l.mergeNames||{})};
 b.units=info.lifetime;b.closedRaw=String(BigInt(a.closedRaw||0)+BigInt(b.closedRaw||0));b.open=a.open!==false||b.open!==false;b.games=(a.games||0)+(b.games||0);b.segment=Math.max(a.segment||1,b.segment||1)+1;b.segmentGames=[...new Set([...(a.segmentGames||[]),...(b.segmentGames||[])])];delete l.rows[d.from];(l.mergeNames||(l.mergeNames={}))[d.to]=b.name;(l.mergeAliases||(l.mergeAliases={}))[d.from]=d.to;l.version++;
 L.recompute(l);(l.mergeAudit||(l.mergeAudit=[])).push({...info,id:d.requestId,actor:d.actor,at:Date.now(),version:l.version,snapshot});return true;
}
function undo(l,d){const a=(l.mergeAudit||[]).find(x=>x.id===d.id);if(!a)throw Error('합친 기록이 없습니다.');if(a.undoneAt)return false;if(d.version!==l.version||l.version!==a.version)throw Error('이후 경기 또는 정산 변경이 있어 바로 되돌릴 수 없습니다. 원본 기록을 확인해주세요.');l.rows=structuredClone(a.snapshot.rows);l.mergeAliases=structuredClone(a.snapshot.aliases);l.mergeNames=structuredClone(a.snapshot.names||{});a.undoneAt=Date.now();a.undoneBy=d.actor;l.version++;L.recompute(l);return true;}
module.exports={resolve,preview,merge,undo};
