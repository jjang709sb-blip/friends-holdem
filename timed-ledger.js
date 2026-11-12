'use strict';
// Monetary source values are exact integer sixtieths of a won. Suggested payments never modify them.
const SCALE=60n,BLOCK=600000n,HALF=300000n;
const integer=v=>{if(typeof v==='bigint')return v;if(typeof v==='number'&&Number.isSafeInteger(v))return BigInt(v);if(typeof v==='string'&&/^-?\d+$/.test(v))return BigInt(v);throw Error('정수 금액 오류');};
const floorDiv=(n,d)=>n/d-(n<0n&&n%d?1n:0n),abs=n=>n<0n?-n:n;
const total=l=>Object.values(l.rows).reduce((n,r)=>n+integer(r.units),0n);
function create(){return {schema:3,version:0,rows:{},games:{},history:[],confirmed:[],calculation:{rows:[],fixed:'0',sum:'0',warning:null},calculationCount:0};}
function compare(a,b){for(let i=0;i<4;i++)if(a[i]!==b[i])return a[i]<b[i]?-1:1;return 0;}
// For a fixed number of rounded-up rows, lexicographic additive costs dominate.
// The fourth component is a monotone max; replacing a prefix by a smaller max cannot worsen its suffix.
function optimize(entries,target){
 const rows=entries.slice().sort((a,b)=>a.pid.localeCompare(b.pid)).map(x=>{const raw=integer(x.raw),base=floorDiv(raw,BLOCK)*BLOCK;return {...x,raw,base,rem:raw-base};});
 const sumBase=rows.reduce((n,r)=>n+r.base,0n),need=(target-sumBase)/BLOCK;
 if((target-sumBase)%BLOCK||need<0n||need>BigInt(rows.filter(r=>r.rem).length))return null;
 const k=Number(need);let dp=new Map([[0,{cost:[0n,0n,0n,0n],path:''}]]);
 for(const r of rows){const next=new Map();for(const [j,old]of dp)for(const up of r.rem?[0,1]:[0]){if(j+up>k)continue;const value=r.base+BigInt(up)*BLOCK,error=abs(value-r.raw),excess=r.raw<0n&&r.raw-value>HALF?r.raw-value-HALF:0n;
  const cost=[old.cost[0]+(excess?1n:0n),old.cost[1]+excess,old.cost[2]+error,old.cost[3]>error?old.cost[3]:error],candidate={cost,path:old.path+up},prior=next.get(j+up);
  if(!prior||compare(cost,prior.cost)<0||(compare(cost,prior.cost)===0&&candidate.path<prior.path))next.set(j+up,candidate);
 }dp=next;}
 const best=dp.get(k);if(!best)return null;
 return {rows:rows.map((r,i)=>({pid:r.pid,name:r.name,raw:r.raw.toString(),amount:(r.base+BigInt(best.path[i])*BLOCK).toString()})),cost:best.cost.map(String)};
}
function recompute(l){
 if(total(l)!==0n)throw Error('원본 합계가 0이 아닙니다. 임의 보정하지 않았습니다.');
 const fixed=(l.confirmed||[]).reduce((n,x)=>n+integer(x.amount),0n);
 const entries=Object.values(l.rows).filter(r=>r.open!==false).map(r=>({pid:r.pid,name:r.name,raw:(integer(r.units)-integer(r.closedRaw||0)).toString()}));
 let result=optimize(entries,-fixed),warning=null;
 if(!result){
  warning='확정액 때문에 정상 내림·올림 후보로 합계를 맞출 수 없습니다. 임시 제안만 표시하며 추가 정산 완료를 차단합니다.';
  const rows=entries.slice().sort((a,b)=>a.pid.localeCompare(b.pid)).map(r=>({...r,amount:floorDiv(integer(r.raw)+HALF,BLOCK)*BLOCK}));
  if(!rows.length&&fixed!==0n)throw Error('확정액 합계 오류');
  if(rows.length){let steps=(-fixed-rows.reduce((n,r)=>n+r.amount,0n))/BLOCK;const n=BigInt(rows.length),q=steps/n,rem=steps%n;rows.forEach((r,i)=>r.amount+=(q+(BigInt(i)<abs(rem)?(rem<0n?-1n:1n):0n))*BLOCK);}
  result={rows:rows.map(r=>({...r,amount:r.amount.toString()})),cost:null};
 }
 const sum=fixed+result.rows.reduce((n,r)=>n+integer(r.amount),0n);if(sum!==0n)throw Error('자동정산 합계 오류');
 l.calculation={...result,fixed:fixed.toString(),sum:'0',warning,version:l.version};l.calculationCount=(l.calculationCount||0)+1;return l.calculation;
}
function migrate(l){
 if(l.schema===3)return l;
 if(l.schema!==2){
 l.legacy={pot:l.pot||null,history:(l.history||[]).filter(x=>x.kind==='pot')};delete l.pot;
 l.history=(l.history||[]).filter(x=>x.kind!=='pot');l.confirmed=[];l.schema=2;
 for(const r of Object.values(l.rows)){r.closedRaw='0';r.open=true;r.segmentGames=[];r.segment=1;}
 l.migrationNote='이전 원장 잔액을 변경하지 않고 이월했습니다. 과거 정산 기록은 별도 보관됩니다.';
 }
 // Convert money only. Chip buyins, cash, net and counts must never be scaled.
 const money=(o,keys)=>{for(const key of keys)if(o[key]!==undefined)o[key]=String(integer(o[key])*5n);};
 const rows=rs=>{for(const r of Object.values(rs||{}))money(r,['units','closedRaw']);};
 rows(l.rows);
 for(const g of l.history||[])for(const p of g.players||[])money(p,['delta']);
 for(const c of l.confirmed||[])money(c,['raw','lifetimeRaw','amount','difference']);
 for(const a of l.mergeAudit||[]){money(a,['raw','lifetime']);if(a.snapshot)rows(a.snapshot.rows);}
 l.schema=3;l.version++;l.monetaryMigration={fromScale:12,toScale:60,at:Date.now()};
 recompute(l);return l;
}
function settleDeltas(l,gameId,changes,meta={}){
 if(l.games[gameId])return false;
 if(total(l)!==0n||changes.reduce((n,x)=>n+integer(x.delta),0n)!==0n)throw Error('칩/원본 합계 불일치 — 반영 보류');
 if(new Set(changes.map(x=>x.pid)).size!==changes.length)throw Error('중복 참가자');
 const grouped=new Map();for(const p of changes){let pid=p.pid;const seen=new Set();while(l.mergeAliases?.[pid]){if(seen.has(pid))throw Error('정산 연결 순환 오류');seen.add(pid);pid=l.mergeAliases[pid];}const old=grouped.get(pid);if(old)old.delta=String(integer(old.delta)+integer(p.delta));else grouped.set(pid,{...p,pid});}
 for(const p of grouped.values()){let r=l.rows[p.pid];if(!r)r=l.rows[p.pid]={pid:p.pid,name:l.mergeNames?.[p.pid]||p.name,units:'0',closedRaw:'0',games:0,open:true,segment:1,segmentGames:[]};
  if(r.open===false){r.open=true;r.segment++;r.segmentGames=[];}
  r.units=(integer(r.units)+integer(p.delta)).toString();r.games++;(r.segmentGames||(r.segmentGames=[])).push(gameId);
 }
 l.games[gameId]=true;l.version++;l.history.push({kind:'game',id:gameId,...meta,players:changes,at:Date.now()});recompute(l);return true;
}
function settle(l,gameId,players,divisor){
 if(![3,4,5,6].includes(divisor))throw Error('정산 비율 오류');
 const changes=players.map(p=>{const buyin=integer(p.buyin),cash=integer(p.cash);if(buyin<0n||cash<0n)throw Error('음수 칩');const net=cash-buyin;if(p.count!==undefined&&(!Number.isSafeInteger(p.count)||p.count<0))throw Error('바이인 횟수 오류');return {pid:p.pid,name:p.name,...(p.count===undefined?{}:{count:p.count}),buyin:String(buyin),cash:String(cash),net:String(net),delta:String(net*(SCALE/BigInt(divisor)))};});
 return settleDeltas(l,gameId,changes,{divisor});
}
function confirm(l,{version,pid,actor,requestId}){
 if(typeof requestId!=='string'||! /^[a-zA-Z0-9_-]{8,80}$/.test(requestId))throw Error('정산 요청 ID 오류');
 const prior=l.confirmed.find(x=>x.requestId===requestId);if(prior){if(prior.pid!==pid||prior.actor!==actor)throw Error('요청 ID 충돌');return prior;}
 if(version!==l.version)throw Error('정산 금액이 변경되었습니다. 다시 확인해주세요.');
 if(l.calculation.warning)throw Error(l.calculation.warning);
 const r=l.rows[pid],proposal=l.calculation.rows.find(x=>x.pid===pid);if(!r||!proposal||r.open===false)throw Error('미확정 참가자를 확인해주세요.');
 const record={id:requestId,requestId,pid,name:r.name,actor,raw:proposal.raw,lifetimeRaw:r.units,amount:proposal.amount,difference:String(integer(proposal.amount)-integer(proposal.raw)),at:Date.now(),segment:r.segment,games:[...(r.segmentGames||[])]};
 r.closedRaw=r.units;r.open=false;r.segmentGames=[];l.confirmed.push(record);l.version++;recompute(l);return record;
}
module.exports={SCALE,BLOCK,integer,floorDiv,create,total,optimize,recompute,migrate,settle,settleDeltas,confirm};
