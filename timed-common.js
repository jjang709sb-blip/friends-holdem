'use strict';
// One private friends-group ledger, independent of room lifecycle.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),L=require('./timed-ledger');
module.exports=function(directory){
 const file=path.join(directory,'friends-common.json');let data=null;
 const copy=x=>structuredClone(x),key=s=>typeof s==='string'&&/^[a-f0-9]{32,96}$/.test(s);
 function write(next){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(next));fs.renameSync(file+'.tmp',file);data=next;}
 function mergeRow(target,row){if(!target)return copy(row);target.units=String(BigInt(target.units)+BigInt(row.units));target.closedRaw=String(BigInt(target.closedRaw||0)+BigInt(row.closedRaw||0));target.games=(target.games||0)+(row.games||0);target.open=target.open!==false||row.open!==false;target.segment=Math.max(target.segment||1,row.segment||1)+1;target.segmentGames=[...new Set([...(target.segmentGames||[]),...(row.segmentGames||[])])];return target;}
 function load(){if(data)return data;if(fs.existsSync(file)){const x=JSON.parse(fs.readFileSync(file,'utf8'));if(x.schema!==1||L.total(x.ledger)!==0n)throw Error('공통 정산 파일 검증 실패');data=x;return data;}
  const next={schema:1,epoch:1,ledger:L.create(),accounts:{},aliases:{},pidAliases:{},archives:[],resets:{},imports:[]};
  const files=fs.existsSync(directory)?fs.readdirSync(directory).filter(x=>/^[A-F0-9]{6}\.json$/.test(x)).sort((a,b)=>fs.statSync(path.join(directory,b)).mtimeMs-fs.statSync(path.join(directory,a)).mtimeMs):[];
  for(const name of files){const old=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));if(old.mode&&old.mode!=='timed')continue;if(!old.ledger)continue;const l=L.migrate(copy(old.ledger));if(L.total(l)!==0n)throw Error('이전 원장 합계 오류: '+name);
   for(const p of old.players||[])if(key(p.token))next.aliases[p.token]={pid:p.pid,name:p.name};
   const ids=Object.keys(l.games),overlap=ids.filter(id=>next.ledger.games[id]);if(overlap.length&&overlap.length!==ids.length)throw Error('이전 원장 경기 기록이 일부 중복되어 자동 이월을 보류합니다: '+name);
   next.imports.push({file:name,skipped:overlap.length>0});if(overlap.length)continue;
   for(const [pid,row]of Object.entries(l.rows))next.ledger.rows[pid]=mergeRow(next.ledger.rows[pid],row);
   Object.assign(next.ledger.games,l.games);next.ledger.history.push(...l.history);next.ledger.confirmed.push(...l.confirmed);next.ledger.version=Math.max(next.ledger.version,l.version||0)+1;
  }
  L.recompute(next.ledger);write(next);return data;
 }
 function canonical(pid,d=load()){while(d.pidAliases[pid])pid=d.pidAliases[pid];return pid;}
 function identify(identity,priorTokens,name){if(!key(identity))throw Error('화면을 새로고침한 뒤 입장해주세요.');const d=load(),next=copy(d);const account=next.accounts[identity];
  const matches=(Array.isArray(priorTokens)?priorTokens:[]).slice(0,100).filter(key).map(t=>next.aliases[t]).filter(x=>x&&x.name===name).map(x=>canonical(x.pid,next));
  const pid=account?canonical(account.pid,next):(matches[0]||crypto.randomBytes(8).toString('hex'));
  if(!account&&!matches.length&&(Object.values(next.accounts).some(x=>x.name===name)||Object.values(next.ledger.rows).some(x=>x.name===name)))throw Error('기존 닉네임 기록이 있습니다. 사용하던 브라우저로 입장해주세요.');
  let changed=false;for(const other of new Set(matches)){if(other===pid)continue;const row=next.ledger.rows[other];if(row){next.ledger.rows[pid]=mergeRow(next.ledger.rows[pid],{...row,pid});delete next.ledger.rows[other];changed=true;}next.pidAliases[other]=pid;}
  if(changed){next.ledger.version++;L.recompute(next.ledger);}
  next.accounts[identity]={pid,name};write(next);return pid;
 }
 function claim(identity,name){
  if(!key(identity))throw Error('접속 정보 오류');const next=copy(load());
  const ids=new Set([...Object.values(next.accounts),...Object.values(next.ledger.rows)].filter(x=>x.name===name).map(x=>canonical(x.pid,next)));
  if(ids.size!==1)throw Error('동일 닉네임 기록이 여러 개입니다. 원장 확인이 필요합니다.');
  const pid=[...ids][0];next.accounts[identity]={pid,name};write(next);return pid;
 }
 function register(token,pid,name){const next=copy(load());next.aliases[token]={pid,name};write(next);}
 function commit(ledger){if(L.total(ledger)!==0n)throw Error('공통 정산 합계 오류');const next=copy(load());next.ledger=ledger;write(next);}
 function reset({version,requestId,actor}){const d=load();if(!key(requestId))throw Error('초기화 요청 오류');if(d.resets[requestId])return;if(version!==d.ledger.version)throw Error('정산 내용이 변경되었습니다. 다시 확인해주세요.');const next=copy(d);next.archives.push({at:Date.now(),actor,epoch:d.epoch,ledger:copy(d.ledger)});next.epoch++;next.ledger=L.create();next.ledger.version=d.ledger.version+1;L.recompute(next.ledger);next.resets[requestId]={actor,at:Date.now()};write(next);}
 return {load,claim,identify,register,canonical,commit,reset,get ledger(){return load().ledger;},get epoch(){return load().epoch;}};
};
