'use strict';
const crypto=require('crypto'),L=require('./timed-ledger'),fs=require('fs'),path=require('path');
module.exports=function(E){
 const store=process.env.TIMED_LEDGER_DIR||path.resolve('data/timed-ledgers');
 function persist(r,ledger=r.timed?.ledger||r.league?.automatic){fs.mkdirSync(store,{recursive:true});const data={mode:r.mode||'tournament',league:is(r)?null:r.league,code:r.code,roomName:r.roomName,hostPid:r.hostPid,settings:r.settings,ledger,players:r.players.map(p=>({pid:p.pid,token:p.token,name:p.name,timedSeat:p.timedSeat}))};const file=path.join(store,r.code+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file);}
 function restore(){if(!fs.existsSync(store))return;for(const file of fs.readdirSync(store)){if(!/^[A-F0-9]{6}\.json$/.test(file))continue;try{const d=JSON.parse(fs.readFileSync(path.join(store,file),'utf8'));L.migrate(d.ledger);if(L.total(d.ledger)!==0n)throw Error('원장 합계 오류');const r={code:d.code,roomName:d.roomName,hostPid:d.hostPid,mode:d.mode||'timed',settings:{...d.settings,...(d.mode==='tournament'?{}:{buyin:20000})},players:d.players.map(p=>({...p,socketId:null,spectator:true,departed:false,stack:0,bank:0,bet:0,contrib:0,cards:[],inHand:false,fold:false,lastActivityAt:Date.now()})),button:-1,sbIndex:-1,bbIndex:-1,street:'waiting',board:[],turn:-1,highest:0,minRaise:2000,handSB:1000,handBB:2000,startedAt:null,endsAt:null,log:['누적정산 원장 복원 · 착석 후 새 게임을 시작해주세요.'],showdown:null,showdownReveal:[],gameOver:false,sessionSeatOrder:[],timed:{ledger:d.ledger,session:null,stage:0,error:null}};if(d.mode==='tournament'){r.league=d.league;delete r.timed;if(r.league)r.league.automatic=d.ledger;}E.rooms.set(r.code,r);}catch(e){console.error('[TIMED LEDGER RESTORE]',file,e.message);}}}
 const is=r=>r?.mode==='timed',live=r=>['preflop','flop','turn','river','runout'].includes(r.street);
 function init(r){r.mode='timed';r.settings={minutes:30,buyin:20000,divisor:4,blindMinutes:0,maxBet:0,turnSeconds:17};r.timed={ledger:L.create(),session:null,stage:0,error:null};}
 // Initial entry is always 20,000; later purchases require an explicit request.
 function buy(r,p){const g=r.timed.session;if(!g||g.settled||r.timed.stage===1||p.spectator||p.departed||g.rows[p.pid])return false;
  g.rows[p.pid]={pid:p.pid,name:p.name,buyin:20000,count:1,cash:20000,pending:0};p.stack=20000;p.bank=0;return true;}
 function applyPending(r,p){const row=r.timed.session?.rows[p.pid];if(row?.pending){p.stack+=row.pending;row.buyin+=row.pending;row.count++;const request=r.timed.session.requests?.[p.pid+':'+row.pendingId];if(request)request.status='applied';row.pending=0;row.pendingId=null;}if(row)row.cash=p.stack;}
 function cancelPending(r,p){const row=r.timed.session?.rows[p.pid];if(row?.pending){const request=r.timed.session.requests?.[p.pid+':'+row.pendingId];if(request)request.status='cancelled';row.pending=0;row.pendingId=null;}}

 function manualBuy(r,p,d){const g=r.timed.session;
  if(!r.startedAt||!g||g.settled||d.sessionId!==g.id)throw Error('현재 경기에서만 바이인할 수 있습니다.');
  if(typeof d.requestId!=='string'||! /^[a-zA-Z0-9_-]{8,80}$/.test(d.requestId)||![20000,40000].includes(d.amount))throw Error('바이인 요청 오류');
  const requests=g.requests||(g.requests={}),key=p.pid+':'+d.requestId;
  if(requests[key]){if(requests[key].amount!==d.amount)throw Error('동일 요청 금액이 다릅니다.');return {ok:true,duplicate:true,...requests[key]};}
  if(r.timed.stage===1)throw Error('막1 시작 후에는 바이인할 수 없습니다.');
  const row=g.rows[p.pid];if(!row||p.spectator||p.departed)throw Error('착석한 참가자만 바이인할 수 있습니다.');
  if(row.pending)throw Error('이미 다음 핸드 바이인을 신청했습니다.');
  if(p.stack!==0)throw Error('보유 칩을 모두 잃었을 때 바이인할 수 있습니다.');
  row.pending=d.amount;row.pendingId=d.requestId;
  requests[key]={amount:d.amount,requestId:d.requestId,status:'pending'};
  if(!live(r)){if(!r.nextHandTimer)schedule(r,Math.max(500,(r.resultEndsAt||0)-Date.now()+400));}
  return {ok:true,...requests[key]};
 }
 function after(r){if(!is(r))return;const g=r.timed.session;if(!g)return;for(const p of r.players){if(g.rows[p.pid])g.rows[p.pid].cash=p.stack;if(g.rows[p.pid]&&p.departed){p.spectator=true;p.inHand=false;}}}
 function finish(r){const t=r.timed,g=t.session;if(!g||g.settled)return;for(const p of r.players){cancelPending(r,p);if(g.rows[p.pid])g.rows[p.pid].cash=p.stack;}
  try{const next=structuredClone(t.ledger);L.settle(next,g.id,Object.values(g.rows),r.settings.divisor);if(r.code)persist(r,next);t.ledger=next;t.error=null;}catch(e){t.error=e.message;E.send(r);return;}
  g.settled=true;r.startedAt=null;r.endsAt=null;r.turn=-1;r.turnDeadline=null;r.nextHandAt=null;E.cancelRoomTimer(r.nextHandTimer);r.nextHandTimer=null;r.street='waiting';E.send(r);E.emitLobby();}
 function before(r){const t=r.timed;if(!r.startedAt)return false;if(t.error)return false;if(t.stage===1){finish(r);return false;}
  if(r.players.filter(p=>!p.departed&&!p.spectator&&(p.stack+(t.session?.rows[p.pid]?.pending||0))>0&&p.socketId).length<2)return false;
  for(const p of r.players)if(!p.departed&&!p.spectator&&p.socketId)applyPending(r,p);
  if(Date.now()>=r.endsAt)t.stage=t.stage? t.stage-1:3;return true;}
 function schedule(r,delay){E.cancelRoomTimer(r.nextHandTimer);r.nextHandTimer=null;if(!r.startedAt)return;r.nextHandAt=Date.now()+delay;r.nextHandTimer=setTimeout(()=>{r.nextHandTimer=null;r.nextHandAt=null;E.deal(r);},delay);E.send(r);}
 function publicState(r){if(!is(r))return null;const t=r.timed;return {stage:t.stage,session:t.session?{id:t.session.id,rows:t.session.rows,settled:t.session.settled}:null,ledger:t.ledger,error:t.error,seats:r.players.map((p,i)=>({i,pid:p.pid,name:p.name,free:!!p.departed&&!p.inHand})).filter(x=>x.i<9)};}
 function detach(r,p,s){cancelPending(r,p);p.socketId=null;p.departed=true;p.leaveAfterHand=true;s.leave(r.code);s.data.roomCode=null;s.data.pid=null;if(!live(r)||!p.inHand){p.spectator=true;p.inHand=false;}if(r.hostPid===p.pid)E.transferHost(r);E.emitLobby();}
 function join(r,name,token,s,ack){let p=r.players.find(x=>token&&x.token===token);if(p){if(p.socketId)return ack({error:'이미 접속 중입니다.'});if(p.departed&&live(r)&&p.inHand)return ack({error:'퇴장한 핸드 정산 후 재입장해주세요.'});if(p.departed)p.spectator=true;p.departed=false;p.leaveAfterHand=false;if(!r.hostPid)r.hostPid=p.pid;E.bindSocket(r,p,s);ack({code:r.code,pid:p.pid,token:p.token,spectator:true});E.send(r);return;}
  if(r.players.some(p=>p.name===name))return ack({error:'같은 닉네임 기록이 있습니다. 기존 브라우저의 입장 토큰으로 재입장해주세요.'});E.addPlayer(r,name,s,ack,true);}
 function start(r,p){if(p.pid!==r.hostPid||r.startedAt)throw Error('방장만 시작할 수 있습니다.');
  const ps=r.players.filter(x=>!x.spectator&&!x.departed&&x.socketId);if(ps.length<2)throw Error('착석한 참가자 2명 이상 필요합니다.');
  r.timed.session={id:crypto.randomBytes(12).toString('hex'),rows:{},settled:false};r.timed.stage=0;r.timed.error=null;r.startedAt=Date.now();r.endsAt=r.startedAt+r.settings.minutes*60000;r.street='waiting';r.gameOver=false;r.resultEndsAt=null;r.showdown=null;r.sessionRoster=null;r.button=-1;
  for(const x of r.players){x.stack=0;x.bank=0;x.bet=0;x.contrib=0;x.inHand=false;x.cards=[];x.finalRank=null;if(ps.includes(x))buy(r,x);}
  r.sessionSeatOrder=ps.map(x=>x.pid);E.deal(r);E.emitLobby();}
 function seat(r,p,i){if(r.timed.stage===1&&r.startedAt)throw Error('막1 착석/바이인 마감');if(!p.spectator||(p.inHand&&live(r)))throw Error('이미 착석했거나 정산 중입니다.');if(!Number.isInteger(i)||i<0||i>8)throw Error('좌석 오류');
  const occupied=r.players.find(x=>x.timedSeat===i&&((!x.departed&&!x.spectator)||(x.inHand&&live(r))));if(occupied)throw Error('이미 사용 중인 좌석입니다.');
  // Keep the engine's array indices stable during a hand; order is established at the next hand boundary.
  p.timedSeat=i;p.spectator=false;p.departed=false;p.leaveAfterHand=false;p.inHand=false;if(r.startedAt){if(p.stack===0)buy(r,p);else{const row=r.timed.session.rows[p.pid];if(!row)throw Error('바이인 기록 오류');}}
  if(!live(r)&&r.startedAt&&!r.nextHandTimer)schedule(r,Math.max(500,(r.resultEndsAt||0)-Date.now()+400));}
 function reorder(r){const last=r.players[r.button]?.timedSeat??-1;r.players.sort((a,b)=>(a.spectator||a.departed?99:a.timedSeat)-(b.spectator||b.departed?99:b.timedSeat));const active=r.players.filter(p=>!p.spectator&&!p.departed&&p.stack>0&&p.socketId);const chosen=active.find(p=>p.timedSeat>last)||active[0];r.button=(r.players.indexOf(chosen)-1+r.players.length)%r.players.length;r.sessionSeatOrder=r.players.filter(x=>!x.spectator&&!x.departed).map(x=>x.pid);}
 function reconnect(r,p){if(r.startedAt&&!live(r)){if(!r.nextHandTimer)schedule(r,Math.max(500,(r.resultEndsAt||0)-Date.now()+400));}}
 function handlers(s){s.on('timed:command',(d={},ack=()=>{})=>{const rp=E.roomPlayerForSocket(s);if(!rp||!is(rp.r))return ack({error:'타임제 방이 아닙니다.'});const {r,p}=rp,t=r.timed;try{
  E.touchActivity(p);
  if(d.type==='settings'){if(r.startedAt||p.pid!==r.hostPid)throw Error('시작 전 방장만 설정 가능합니다.');if(![20,30,60].includes(d.minutes)||(d.buyin!==undefined&&d.buyin!==20000)||![3,4].includes(d.divisor))throw Error('설정 오류');Object.assign(r.settings,{minutes:d.minutes,buyin:20000,divisor:d.divisor});}
  else if(d.type==='buyin'){const result=manualBuy(r,p,d);E.send(r);return ack(result);}
  else if(d.type==='seat')seat(r,p,d.seat);
  else if(d.type==='start')start(r,p);
  else if(d.type==='settlement-retry'){if(p.pid!==r.hostPid||!t.error||live(r)||t.stage!==1)throw Error('정산 재확인 대상이 아닙니다.');finish(r);if(t.error)throw Error(t.error);}
  else if(d.type==='settlement-complete'){if(r.startedAt||p.pid!==r.hostPid)throw Error('경기 종료 후 방장만 실제 정산 완료를 기록할 수 있습니다.');const next=structuredClone(t.ledger);L.confirm(next,{version:d.version,pid:d.pid,actor:p.pid,requestId:d.requestId});persist(r,next);t.ledger=next;}
  else throw Error('잘못된 요청');E.send(r);ack({ok:true});
 }catch(e){ack({error:e.message});}});}
 return {is,init,restore,persist,reconnect,buy,manualBuy,after,finish,before,schedule,publicState,detach,join,start,seat,reorder,handlers};
};
