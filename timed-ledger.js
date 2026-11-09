'use strict';
// All point values are integral twelfths of a point. No binary fractions.
const crypto=require('crypto');
const SCALE=12n, BLOCK=120000n;
const id=()=>crypto.randomBytes(12).toString('hex');
function integer(v){if(typeof v==='bigint')return v;if(typeof v==='number'&&Number.isSafeInteger(v))return BigInt(v);if(typeof v==='string'&&/^-?\d+$/.test(v))return BigInt(v);throw Error('정수 금액이 아닙니다.');}
function floorDiv(n,d){const q=n/d;return n<0n&&n%d?q-1n:q;}
function create(){return {version:0,rows:{},games:{},history:[],pot:null};}
function total(l){return Object.values(l.rows).reduce((s,r)=>s+integer(r.units),0n);}
function settle(l,gameId,players,divisor){
 if(![3,4].includes(divisor))throw Error('정산 비율 오류');
 if(l.games[gameId])return false;
 if(l.pot&&l.pot.phase!=='complete')throw Error('누적정산팟 진행 중');
 const seen=new Set();let sum=0n;
 const changes=players.map(p=>{if(!p.pid||seen.has(p.pid))throw Error('참가자 중복');seen.add(p.pid);const buyin=integer(p.buyin),cash=integer(p.cash);if(buyin<0n||cash<0n)throw Error('음수 칩');const net=cash-buyin;sum+=net;return {pid:p.pid,name:p.name,buyin:buyin.toString(),cash:cash.toString(),net:net.toString(),delta:(net*(SCALE/BigInt(divisor))).toString()};});
 if(sum!==0n||total(l)!==0n)throw Error('칩/정산 합계 불일치 — 반영 보류');
 for(const p of changes){const row=l.rows[p.pid]||(l.rows[p.pid]={pid:p.pid,name:p.name,units:'0',games:0});row.units=(integer(row.units)+integer(p.delta)).toString();row.games++;}
 l.games[gameId]=true;l.version++;l.history.push({kind:'game',id:gameId,divisor,players:changes,at:Date.now()});return true;
}
function preview(l){
 if(total(l)!==0n)throw Error('누적정산 합계 불일치');
 const rows=Object.values(l.rows).map(r=>{const n=integer(r.units),base=floorDiv(n,BLOCK)*BLOCK;return {pid:r.pid,name:r.name,before:r.units,base:base.toString(),remainder:(n-base).toString()};});
 const pot=rows.reduce((s,r)=>s+integer(r.remainder),0n);if(pot%BLOCK)throw Error('팟 단위 오류');
 return {version:l.version,rows,pot:pot.toString(),participants:rows.filter(r=>integer(r.remainder)>0n).map(r=>r.pid)};
}
function begin(l,version,online){
 if(l.pot&&l.pot.phase!=='complete')throw Error('이미 진행 중입니다.');if(version!==l.version)throw Error('정산이 변경되었습니다. 다시 확인해주세요.');
 const p=preview(l);if(!p.participants.every(pid=>online.includes(pid)))throw Error('참가 대상 전원 접속 후 진행해주세요.');
 if(p.pot==='0')return {phase:'complete',empty:true};
 l.pot={...p,id:id(),phase:'ready',round:0,contenders:[...p.participants],rounds:[]};return l.pot;
}
function round(l,deck,evaluate,compare,online){
 const p=l.pot;if(!p||!['ready','tie','paused'].includes(p.phase))throw Error('재경기 상태 오류');
 if(!p.participants.every(pid=>online.includes(pid))){p.phase='paused';return p;}
 if(new Set(deck).size!==52||deck.length!==52||deck.some(c=>! /^[2-9TJQKA][SHDC]$/.test(c)))throw Error('덱 오류');
 if(p.contenders.length>23)throw Error('단일 덱 참가 인원 초과');
 const cards=deck.slice();const players=p.contenders.map(pid=>({pid,cards:[cards.pop(),cards.pop()]}));const board=cards.splice(-5);let top=null;
 for(const row of players){row.score=evaluate([...row.cards,...board]);if(!top||compare(row.score,top)>0)top=row.score;}
 const winners=players.filter(r=>compare(r.score,top)===0).map(r=>r.pid);if(!winners.length)throw Error('승자 계산 실패');
 p.round++;p.rounds.push({number:p.round,board,players:players.map(r=>({...r,win:winners.includes(r.pid)})),winners,at:Date.now()});p.contenders=winners;
 if(winners.length>1){p.phase='tie';return p;}
 // Commit exactly once, only after a unique winner is known. Original rows stay intact until then.
 if(p.version!==l.version)throw Error('정산 원장이 변경되었습니다.');
 for(const row of p.rows)l.rows[row.pid].units=(integer(row.base)+(row.pid===winners[0]?integer(p.pot):0n)).toString();
 if(total(l)!==0n)throw Error('정산 합계 오류');p.phase='complete';p.winner=winners[0];l.version++;l.history.push({kind:'pot',...JSON.parse(JSON.stringify(p)),at:Date.now()});return p;
}
module.exports={SCALE,BLOCK,integer,floorDiv,create,total,settle,preview,begin,round};
