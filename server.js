const express=require('express');
const http=require('http');
const {Server}=require('socket.io');
const crypto=require('crypto');
const app=express();
app.get('/healthz',(req,res)=>res.json({ok:true,uptime:Math.round(process.uptime()),rooms:[...rooms.values()].filter(r=>!r.practice).length,now:Date.now()}));
app.use(express.static('public'));
const server=http.createServer(app);
// V5.7: mobile calls/backgrounds can briefly stall the browser. Give Socket.IO a wider heartbeat window
// so a short radio/audio interruption is not treated as a dead player.
const io=new Server(server,{
  // V5.9: tolerate mobile radio/call stalls, but keep transport fallback available.
  pingInterval:20000,pingTimeout:60000,connectTimeout:45000,
  connectionStateRecovery:{maxDisconnectionDuration:5*60*1000,skipMiddlewares:true}
});
const hulaGame=require('./hula-room')(io);
const rooms=new Map();
const settlementLedger=require('./timed-ledger');
const timed=require('./timed-mode')({rooms,send,emitLobby,cancelRoomTimer,deal,transferHost,bindSocket,addPlayer,roomPlayerForSocket,touchActivity,makeDeck,best,cmp});
const practicePolicy=require('./practice-bot');
const {observation:practiceObservation,recordAction:recordPracticeAction}=require('./practice-room');

// Practice uses a frozen logical clock. Network/idle cleanup still uses wall time.
function roomNow(r){return r?.practice?(r.pauseAt||Date.now())-(r.clockOffset||0):Date.now()}
function roomTurnMs(r){return (r.settings?.turnSeconds??17)*1000}
function cancelRoomTimer(t){if(t?.practiceTimer){clearTimeout(t.handle);t.cancelled=true;t.room.practiceTimers.delete(t)}else clearTimeout(t)}
function armRoomTimer(t){if(t.cancelled||t.room.closed||t.room.pauseAt)return;t.handle=setTimeout(()=>{if(t.cancelled||t.room.closed||t.room.pauseAt)return;t.room.practiceTimers.delete(t);t.cancelled=true;t.fn()},Math.max(0,t.at-roomNow(t.room)))}
function roomTimeout(r,fn,delay){if(!r.practice)return setTimeout(fn,delay);const t={practiceTimer:true,room:r,fn,at:roomNow(r)+delay,handle:null,cancelled:false};(r.practiceTimers||(r.practiceTimers=new Set())).add(t);armRoomTimer(t);return t}
function setPracticePaused(r,paused){
 if(!r.practice||!!r.pauseAt===paused)return;
 if(paused){r.pauseAt=Date.now();for(const t of r.practiceTimers||[])clearTimeout(t.handle)}
 else{r.clockOffset=(r.clockOffset||0)+Date.now()-r.pauseAt;r.pauseAt=null;for(const t of r.practiceTimers||[])armRoomTimer(t)}
}

const START_BANK=200000, INITIAL_BUYIN=50000, SB=1000, BB=2000, UNIT=1000, GAME_MS=30*60*1000, TURN_MS=17000, NEXT_HAND_MS=8000, BLIND_LEVEL_MS=5*60*1000;
const GAME_DURATIONS={20:20*60*1000,30:30*60*1000,60:60*60*1000,0:null}, TOTAL_ASSETS=[100000,200000,250000,300000,500000], BLIND_LEVEL_MINUTES=[0,3,4,5,6];
function roomDurationMs(r){const m=r.settings?.minutes??30;return m===0?null:m*60000}
function durationLabel(r){const m=r.settings?.minutes??30;return m===0?'제한없음':m+'분'}
function roomTotalAssets(r){if(timed.is(r))return 0;return r.settings?.totalAssets??START_BANK}
function roomBlindLevelMs(r){if(timed.is(r))return 0;const m=r.settings?.blindMinutes??5;return m===0?0:m*60*1000}
function sessionBlinds(r){const ms=roomBlindLevelMs(r);if(!ms)return [SB,BB];const started=r.startedAt||roomNow(r);const level=Math.max(0,Math.min(40,Math.floor((roomNow(r)-started)/ms)));const mult=2**level;return [SB*mult,BB*mult]}
function handBlinds(r){return [r.handSB||SB,r.handBB||BB]}
function roomInitialBuyin(r){if(timed.is(r))return 0;return Math.min(r.settings?.initialBuyin??INITIAL_BUYIN,roomTotalAssets(r))}
const REBUY_AMOUNTS=[50000,100000];
const IDLE_MS=30*60*1000, RESULT_PRESENTATION_MS=20000;
function handCap(r){return r.handMaxBet??r.settings?.maxBet??0}
function availableBet(r,p){const cap=handCap(r);return Math.max(0,Math.min(p.stack,cap?cap-p.contrib:p.stack))}
function canAct(r,p){return p.inHand&&!p.fold&&!p.allin&&availableBet(r,p)>0}
function isIdle(p,now=Date.now()){return false;/* legacy disabled */if(p.bot)return false;return Number.isFinite(p.lastActivityAt)&&now-p.lastActivityAt>=IDLE_MS}
function touchActivity(p){p.lastActivityAt=Date.now()}

const suits=['S','H','D','C'], ranks='23456789TJQKA';
function makeDeck(){let d=suits.flatMap(s=>[...ranks].map(r=>r+s));for(let i=d.length-1;i>0;i--){let j=crypto.randomInt(i+1);[d[i],d[j]]=[d[j],d[i]]}return d}
function score5(cards){const vals=cards.map(c=>ranks.indexOf(c[0])+2).sort((a,b)=>b-a),cnt=new Map();vals.forEach(v=>cnt.set(v,(cnt.get(v)||0)+1));const g=[...cnt].sort((a,b)=>b[1]-a[1]||b[0]-a[0]),flush=cards.every(c=>c[1]===cards[0][1]),u=[...new Set(vals)];if(u.includes(14))u.push(1);let st=0;for(let i=0;i<=u.length-5;i++)if(u[i]-u[i+4]===4){st=u[i];break}if(flush&&st)return[8,st];if(g[0][1]===4)return[7,g[0][0],g[1][0]];if(g[0][1]===3&&g[1][1]===2)return[6,g[0][0],g[1][0]];if(flush)return[5,...vals];if(st)return[4,st];if(g[0][1]===3)return[3,g[0][0],...g.slice(1).map(x=>x[0]).sort((a,b)=>b-a)];if(g[0][1]===2&&g[1][1]===2)return[2,Math.max(g[0][0],g[1][0]),Math.min(g[0][0],g[1][0]),g[2][0]];if(g[0][1]===2)return[1,g[0][0],...g.slice(1).map(x=>x[0]).sort((a,b)=>b-a)];return[0,...vals]}
function cmp(a,b){
  // V5.11: a missing/invalid hand score must never crash the whole Node process.
  if(!Array.isArray(a)&&!Array.isArray(b))return 0;
  if(!Array.isArray(a))return -1;
  if(!Array.isArray(b))return 1;
  for(let i=0;i<Math.max(a.length,b.length);i++){let x=(a[i]||0)-(b[i]||0);if(x)return Math.sign(x)}return 0
}
function bestDetail(cards){let b=null,bc=[];for(let a=0;a<cards.length-4;a++)for(let c=a+1;c<cards.length-3;c++)for(let d=c+1;d<cards.length-2;d++)for(let e=d+1;e<cards.length-1;e++)for(let f=e+1;f<cards.length;f++){let five=[cards[a],cards[c],cards[d],cards[e],cards[f]],sc=score5(five);if(!b||cmp(sc,b)>0){b=sc;bc=five}}return{score:b,cards:bc}}
function best(cards){return bestDetail(cards).score}
const handName=s=>['하이카드','원페어','투페어','트리플','스트레이트','플러시','풀하우스','포카드','스트레이트 플러시'][s?.[0]??0];
const rankText=v=>v===14?'A':v===13?'K':v===12?'Q':v===11?'J':v===10?'10':String(v||'');
function handLabel(s){if(!Array.isArray(s))return '승리';const n=handName(s),k=s[0];if(k===1)return rankText(s[1])+' 원페어';if(k===2)return rankText(s[1])+'·'+rankText(s[2])+' 투페어';if(k===3)return rankText(s[1])+' 트리플';if(k===4)return rankText(s[1])+' 스트레이트';if(k===5)return rankText(s[1])+' 하이 플러시';if(k===6)return rankText(s[1])+' 풀하우스';if(k===7)return rankText(s[1])+' 포카드';if(k===8)return rankText(s[1])+' 스트레이트 플러시';return rankText(s[1])+' 하이'}
const active=r=>r.players.filter(p=>p.inHand&&!p.fold), eligible=r=>active(r).filter(p=>canAct(r,p));
function next(r,from,fn){for(let n=1;n<=r.players.length;n++){let i=(from+n)%r.players.length;if(fn(r.players[i]))return i}return -1}
function note(r,s){r.log.push(s);if(r.log.length>100)r.log.shift()}
function bet(r,i,amount){let p=r.players[i],n=Math.max(0,Math.min(amount,availableBet(r,p)));p.stack-=n;p.bet+=n;p.contrib+=n;p.allin=p.stack===0;p.capped=!!handCap(r)&&p.contrib>=handCap(r)&&!p.allin}
function timeLeft(r){if(!r.startedAt)return roomDurationMs(r)??null;if(roomDurationMs(r)===null)return null;return r.endsAt?Math.max(0,r.endsAt-roomNow(r)):0}
function setTurnDeadline(r){r.turnStartedAt=r.turn>=0?roomNow(r):null;r.turnDeadline=r.turn>=0?r.turnStartedAt+roomTurnMs(r):null}
function markAction(r,p,type,kind=type){r.actionSeq=(r.actionSeq||0)+1;p.lastMove={type,at:roomNow(r),amount:p.bet||0};r.lastAction={seq:r.actionSeq,pid:p.pid,name:p.name,type,at:roomNow(r)};if(r.practice)recordPracticeAction(r,p,type,kind)}
function send(r){
 if(r.closed)return;queuePracticeBot(r);
 queuePreAction(r);leagueBroadcast(r);
 const visible=r.players.filter(x=>!x.departed), pubIndex=old=>{if(old==null||old<0)return -1;const target=r.players[old];return target?visible.indexOf(target):-1};
 for(const p of visible){if(!p.socketId||p.bot)continue;const reveal=new Set(r.showdownReveal||[]);const pub=visible.map((x,i)=>({pid:x.pid,name:x.name,...(r.practice&&x.bot?{botStyle:practicePolicy.publicProfile(x.botProfile)}:{}),timedSeat:x.timedSeat,totalBuyin:r.timed?.session?.rows[x.pid]?.buyin||0,buyinCount:r.timed?.session?.rows[x.pid]?.count||0,stack:x.stack,bank:x.bank,fold:x.fold,inHand:x.inHand,allin:x.allin,capped:!!x.capped,bet:x.bet,contrib:x.contrib,seat:i,cards:(x.pid===p.pid||reveal.has(x.pid))?x.cards:null,cardsPublic:reveal.has(x.pid),manualReveal:x.manualRevealHandId===r.handId,waitingForNextHand:!!r.startedAt&&!x.inHand&&!x.departed,connected:!!x.socketId,total:x.stack+x.bank,spectator:!!x.spectator&&(timed.is(r)||!!r.startedAt),finalRank:x.finalRank||null,eliminatedHandId:x.eliminatedHandId||null,lastMove:x.lastMove||null,rebuyAvailable:!!x.rebuyEligible&&x.stack===0,rebuyHandId:x.rebuyHandId||null,rebuyDeadline:x.rebuyDeadline||null}));const blindMs=roomBlindLevelMs(r);io.to(p.socketId).emit('state',{connectionId:p.socketId,code:r.code,roomName:r.roomName,mode:r.mode||'tournament',timed:timed.publicState(r),practice:!!r.practice,practicePaused:!!r.pauseAt,autoRebuyAmount:r.practice?0:(p.autoRebuyAmount===100000?100000:50000),gameNow:roomNow(r),gameClockOffset:r.clockOffset||0,practiceReviewAvailable:!!(r.practice&&r.street==='done'&&r.settlementComplete&&roomNow(r)>=(r.presentationTimeline?.resultRevealAt||0)),runoutBoard:r.runoutBoard||null,presentationTimeline:r.presentationTimeline||null,preAction:p.preAction&&p.preAction.handId===r.handId?p.preAction.type:null,features:{league:1,timeline:1,chat:1,reactions:1,presentation:1,autoRebuy:1,maxBet:1,idleExit:0},handMaxBet:handCap(r),idleExpiresAt:null,presentationExpiresAt:r.showdown?r.showdown.at+RESULT_PRESENTATION_MS:null,handId:r.handId||null,settlementComplete:!!r.settlementComplete,turnStartedAt:r.turnStartedAt||null,turnDurationMs:roomTurnMs(r),players:pub,board:r.board,street:r.street,pot:r.showdown?.pot??r.players.reduce((s,x)=>s+x.contrib,0),button:pubIndex(r.button),sbIndex:pubIndex(r.sbIndex),bbIndex:pubIndex(r.bbIndex),turn:pubIndex(r.turn),highest:r.highest,minRaise:r.minRaise,log:r.log.slice(-18),you:p.pid,host:r.hostPid,canStart:['waiting','done'].includes(r.street)&&!r.startedAt,blinds:handBlinds(r),nextBlinds:sessionBlinds(r),timeLeft:timeLeft(r),serverNow:Date.now(),sessionEndsAt:r.endsAt,started:!!r.startedAt,settings:r.settings,durationLabel:durationLabel(r),gameOver:r.gameOver,turnDeadline:r.turnDeadline,lastAction:r.lastAction,nextHandAt:r.nextHandAt,showdown:r.showdown||null,resultEndsAt:r.resultEndsAt||null,sessionResultId:r.sessionResultId||null,finalRanking:r.finalRanking||null,sessionSeatOrder:(r.sessionSeatOrder||[]).filter(id=>visible.some(x=>x.pid===id)),blindLevelMs:blindMs,nextBlindAt:(r.startedAt&&blindMs)?r.startedAt+(Math.floor((roomNow(r)-r.startedAt)/blindMs)+1)*blindMs:null})}}

function eliminatePlayers(r,players,reason='bust'){if(timed.is(r))return;
 if(!r.sessionRoster)return;
 const candidates=players.filter(p=>!p.finalRank&&r.sessionRoster.some(x=>x.pid===p.pid));
 // Simultaneous busts: larger assets at the beginning of the hand rank higher.
 // Exact ties: earlier session seat ranks higher. Stable, never locale/random order.
 candidates.sort((a,b)=>(a.handStartAssets||0)-(b.handStartAssets||0)||r.sessionRoster.findIndex(x=>x.pid===b.pid)-r.sessionRoster.findIndex(x=>x.pid===a.pid));
 for(const p of candidates){const row=r.sessionRoster.find(x=>x.pid===p.pid);const rank=r.sessionRoster.filter(x=>!x.rank).length;
  p.finalRank=rank;p.eliminatedHandId=r.handId;Object.assign(row,{rank,stack:p.stack,bank:p.bank,total:p.stack+p.bank,eliminatedHandId:r.handId,reason});
 }
}
function sessionRanking(r){
 const roster=r.sessionRoster?.length?r.sessionRoster:r.players.filter(p=>!p.spectator).map(p=>({pid:p.pid,name:p.name}));
 const rows=roster.map(row=>{const p=r.players.find(p=>p.pid===row.pid);return {...row,...(p?{name:p.name,stack:p.stack,bank:p.bank,total:p.stack+p.bank}:{})}});
 const survivors=rows.filter(x=>!x.rank).sort((a,b)=>(b.total||0)-(a.total||0)||roster.findIndex(x=>x.pid===a.pid)-roster.findIndex(x=>x.pid===b.pid));
 survivors.forEach((p,i)=>{p.rank=i+1});return rows.sort((a,b)=>a.rank-b.rank);
}

function endSession(r,reason=null){if(timed.is(r))return;purgeLeavers(r);reason=reason||durationLabel(r)+' 세션 종료';cancelRoomTimer(r.nextHandTimer);r.nextHandTimer=null;r.nextHandAt=null;r.finalRanking=sessionRanking(r);leagueSettle(r);r.sessionResultId=crypto.randomBytes(8).toString('hex');r.presentationTimeline=null;r.runoutBoard=null;r.players.forEach(p=>{p.preAction=null;p.inHand=false;p.fold=false;p.allin=false;p.capped=false;p.lastMove=null;p.bet=0;p.contrib=0;p.cards=[]});r.board=[];r.endsAt=null;r.startedAt=null;r.gameOver=false;r.street='waiting';r.turn=-1;r.turnDeadline=null;r.showdown=null;r.showdownReveal=[];r.resultEndsAt=null;for(let i=r.players.length-1;i>0;i--){const j=crypto.randomInt(i+1);[r.players[i],r.players[j]]=[r.players[j],r.players[i]]}r.sessionSeatOrder=r.players.map(p=>p.pid);r.button=-1;r.sbIndex=-1;r.bbIndex=-1;note(r,`🏆 ${reason} · 최종 순위 확정`);send(r);if(r.practice){r.practiceClosing=true;r.practiceCloseTimer=roomTimeout(r,()=>closePractice(r,'연습이 종료되었습니다.'),20000)}}
function finishGameIfNeeded(r){if(timed.is(r))return false;if(r.street==='done'&&r.resultEndsAt>roomNow(r))return false;if(r.restartRequested&&r.street==='done'){r.restartRequested=false;endSession(r,'방장 요청 · 새 게임 준비');return true}if(r.startedAt&&r.endsAt&&roomNow(r)>=r.endsAt&&['waiting','done'].includes(r.street)){endSession(r);return true}return false}
function scheduleNext(r,delay=NEXT_HAND_MS){if(timed.is(r))return timed.schedule(r,delay);cancelRoomTimer(r.nextHandTimer);r.nextHandTimer=null;if(r.gameOver||!r.startedAt)return;let alive=r.players.filter(p=>!p.spectator&&p.stack>0&&p.socketId);if(alive.length<2){let funded=r.players.filter(p=>!p.spectator&&(p.stack+p.bank)>0&&p.socketId);if(funded.length<2){r.nextHandAt=roomNow(r)+delay;r.nextHandTimer=roomTimeout(r,()=>{try{r.nextHandTimer=null;r.nextHandAt=null;if(r.startedAt)endSession(r,'승부 종료 · 계속 플레이 가능한 선수가 1명 남음')}catch(e){console.error(new Date().toISOString(),'[FATAL-GUARD] earlySessionEnd',r.code,e?.stack||e);r.nextHandTimer=null;r.nextHandAt=null;send(r)}},delay);send(r);return}r.nextHandAt=null;send(r);return}r.nextHandAt=roomNow(r)+delay;r.nextHandTimer=roomTimeout(r,()=>{try{r.nextHandTimer=null;r.nextHandAt=null;if(!r.gameOver)deal(r)}catch(e){console.error(new Date().toISOString(),'[FATAL-GUARD] nextHand',r.code,e?.stack||e);r.nextHandTimer=null;r.nextHandAt=null;send(r)}},delay);send(r)}
// Each human may preselect a rebuy funded ONLY from their existing bank.
// Run after pot/refund settlement, before elimination and blind selection.
function applySelectedRebuys(r){if(timed.is(r))return false;
 if(r.practice||!r.startedAt||r.gameOver||r.pauseAt||!r.settlementComplete||
    (r.endsAt&&roomNow(r)>=r.endsAt)||r.restartRequested)return false;
 let changed=false;
 for(const p of r.players){
  if(p.stack!==0||p.bank<=0||p.bot||
     p.spectator||p.departed||p.leaveAfterHand||!p.socketId||p.autoRebuyHand===r.handId)continue;
  const amount=Math.min(p.autoRebuyAmount===100000?100000:50000,p.bank);
  p.bank-=amount;p.stack+=amount;p.autoRebuyHand=r.handId;
  p.rebuyEligible=false;p.rebuyHandId=null;p.rebuyDeadline=null;
  note(r,`🔄 ${p.name} 자동 리바이 ${amount.toLocaleString()} · 잔여자산에서 차감`);
  changed=true;
 }
 return changed;
}

function finish(r){
 let contenders=active(r),isShowdown=contenders.length>1,alreadyPublic=contenders.length>1&&contenders.every(p=>(r.showdownReveal||[]).includes(p.pid)),totalPot=r.players.reduce((s,x)=>s+x.contrib,0);
 if(isShowdown)while(r.board.length<5)r.board.push(r.deck.pop());
 let scores=new Map(contenders.map(p=>{
  const cards=[...(Array.isArray(p.cards)?p.cards:[]),...(Array.isArray(r.board)?r.board:[])];
  const sc=cards.length>=5?best(cards):null;
  if(!sc)console.error(new Date().toISOString(),'[HAND] invalid score','room='+r.code,'pid='+p.pid,'cards='+JSON.stringify(cards),'street='+r.street);
  return [p.pid,sc];
})),won=new Map(),refunds=new Map(),potResults=[];
 let levels=[...new Set(r.players.map(p=>p.contrib).filter(Boolean))].sort((a,b)=>a-b),prev=0;
 for(const level of levels){let contributors=r.players.filter(p=>p.contrib>=level),amount=(level-prev)*contributors.length;prev=level;
 // A layer funded by one player is uncalled excess, never a pot win.
 // Return it to its contributor even if that player has folded.
 if(contributors.length===1){const p=contributors[0];p.stack+=amount;refunds.set(p.pid,(refunds.get(p.pid)||0)+amount);continue}
 let possible=contenders.filter(p=>p.contrib>=level);if(!possible.length)continue;let winners=possible.filter(p=>possible.every(q=>cmp(scores.get(p.pid),scores.get(q.pid))>=0));if(contributors.length>=2)potResults.push({amount,winnerPids:winners.map(p=>p.pid)});let each=Math.floor(amount/winners.length/UNIT)*UNIT,rem=amount-each*winners.length;winners.forEach(p=>{p.stack+=each;won.set(p.pid,(won.get(p.pid)||0)+each)});let order=[...winners].sort((a,b)=>((r.players.indexOf(a)-r.button-1+r.players.length)%r.players.length)-((r.players.indexOf(b)-r.button-1+r.players.length)%r.players.length));for(let j=0;rem>=UNIT;j=(j+1)%order.length,rem-=UNIT){order[j].stack+=UNIT;won.set(order[j].pid,(won.get(order[j].pid)||0)+UNIT)}}
 let winnerPlayers=contenders.filter(p=>(won.get(p.pid)||0)>0);
 // V5.33: display winner comes from the first real contested pot. Unmatched excess returned to a player is NOT a win.
 let displayWinnerPids=isShowdown?(potResults[0]?.winnerPids||[]):contenders.map(p=>p.pid);
 let displayWinners=contenders.filter(p=>displayWinnerPids.includes(p.pid));
 r.showdownReveal=isShowdown?contenders.map(p=>p.pid):[];
 if(!r.presentationTimeline){r.presentationTimeline=presentationPlan(r,5,false);if(!isShowdown||alreadyPublic){r.presentationTimeline.skipIntro=alreadyPublic;const t=r.presentationTimeline,delta=t.resultRevealAt-(roomNow(r)+700);for(const k of Object.keys(t))if(k.endsWith('At'))t[k]-=delta}}
 r.resultEndsAt=r.presentationTimeline.presentationCompleteAt;
 r.showdown={at:roomNow(r),showdown:isShowdown,pot:totalPot-[...refunds.values()].reduce((a,b)=>a+b,0),committedPot:totalPot,refunds:[...refunds].map(([pid,amount])=>({pid,amount})),displayWinners:displayWinners.map(p=>({pid:p.pid,name:p.name,cards:p.cards,hand:isShowdown?handName(scores.get(p.pid)):'폴드 승리',label:isShowdown?handLabel(scores.get(p.pid)):'폴드 승리',won:won.get(p.pid)||0})),potResults,winners:winnerPlayers.map(p=>({pid:p.pid,name:p.name,cards:p.cards,hand:isShowdown?handName(scores.get(p.pid)):'폴드 승리',label:isShowdown?handLabel(scores.get(p.pid)):'폴드 승리',won:won.get(p.pid)||0})),players:isShowdown?contenders.map(p=>{const detail=bestDetail([...(Array.isArray(p.cards)?p.cards:[]),...(Array.isArray(r.board)?r.board:[])]);return{pid:p.pid,name:p.name,cards:p.cards,hand:handName(scores.get(p.pid)),label:handLabel(scores.get(p.pid)),winner:potResults.some(pot=>pot.winnerPids.includes(p.pid)),rank:detail.score,bestCards:r.board.length===5&&cmp(score5(r.board),detail.score)===0?r.board.slice():detail.cards}}):[]};
 if(winnerPlayers.length)note(r,`🏆 ${winnerPlayers.map(p=>p.name).join(', ')} 승리 · ${winnerPlayers.map(p=>handName(scores.get(p.pid))).join('/')}`);
 r.settlementComplete=true;if(timed.is(r))timed.after(r);applySelectedRebuys(r);
 eliminatePlayers(r,r.players.filter(p=>!p.spectator&&p.stack+p.bank===0));
 r.settlementComplete=true;r.players.forEach(p=>{if(p.inHand&&p.stack===0&&p.bank>0){p.rebuyEligible=true;p.rebuyHandId=r.handId;p.rebuyDeadline=null}});r.street='done';r.turn=-1;r.turnDeadline=null;r.highest=0;purgeLeavers(r);send(r);scheduleNext(r,Math.max(1000,r.resultEndsAt-roomNow(r)+1400))
}
// Server-owned presentation milestones. Acknowledgements never advance the clock.
function presentationPlan(r,base,runout){
 const start=roomNow(r)+1400,cinematic=runout&&base===0;
 const t={id:r.handId,version:2,baseCount:base,cinematic,showdownStartAt:start,
 flopRevealAt:base>=3?start:start+2600,turnRevealAt:base>=4?start:start+3500,
 riverRevealAt:base>=5?start:start+4400};
 if(cinematic){
  // Absolute visual beats; prebuffered payloads never wait for an animation ACK.
  // V7.14.1: keep the overall showdown length, but give FLOP/TURN room to breathe.
  // 700ms between the first four cards; the river cinematic is compressed instead.
  t.cardRevealAts=[start+2600,start+3300,start+4000,start+4700];
  t.flopRevealAt=t.cardRevealAts[0];t.turnRevealAt=t.cardRevealAts[3];t.riverRevealAt=start+5300;
  t.riverPeekAt=t.riverRevealAt+450;t.riverPauseEndAt=t.riverRevealAt+720;
  t.riverFaceAt=t.riverRevealAt+1120;t.riverFlyAt=t.riverRevealAt+1270;t.riverLandAt=t.riverRevealAt+1500;
 }
 t.riverCompleteAt=base>=5?start+2600:t.riverRevealAt+(cinematic?1550:500);
 t.resultRevealAt=Math.max(start+2600,t.riverCompleteAt+(cinematic?600:450));
 // Preserve the old server settlement/payload instant; extend presentation only.
 t.settlementPayloadAt=t.resultRevealAt-900;
 if(runout&&base<5){t.riverPoppin=true;t.riverPeekAt=t.riverRevealAt+720;t.riverPauseEndAt=t.riverRevealAt+1050;t.riverFaceAt=t.riverRevealAt+2300;t.riverFlyAt=t.riverRevealAt+2530;t.riverLandAt=t.riverRevealAt+2900;t.riverCompleteAt=t.riverRevealAt+3000;t.resultRevealAt=t.riverCompleteAt+450;}
 t.sweepAt=t.resultRevealAt+2000;t.collectAt=t.resultRevealAt+2800;t.settleAt=t.resultRevealAt+4700;t.presentationCompleteAt=t.resultRevealAt+5200;
 return t;
}
function atMilestone(r,at,label,fn){
 const hand=r.handId;roomTimeout(r,()=>{if(r.closed||r.handId!==hand)return;try{
  if(process.env.HOLDEM_DIAGNOSTICS==='1')console.log('[TIMELINE]',JSON.stringify({room:r.code,hand,label,planned:at,actual:roomNow(r),delay:roomNow(r)-at}));fn();
 }catch(e){console.error('[TIMELINE]',label,e)}},Math.max(0,at-roomNow(r)));
}
function slowRunout(r){
 if(r.runout)return;const base=r.board.length;r.presentationTimeline=presentationPlan(r,base,true);
 r.runoutBoard=r.board.slice();while(r.runoutBoard.length<5)r.runoutBoard.push(r.deck.pop());
 r.runout=true;r.street='runout';r.turn=-1;r.turnDeadline=null;r.showdownReveal=active(r).map(p=>p.pid);send(r);
 const t=r.presentationTimeline;
 for(const [count,at,label] of [[3,t.flopRevealAt,'flop'],[4,t.turnRevealAt,'turn'],[5,t.riverRevealAt,'river']])if(base<count){
  atMilestone(r,at-900,label+'-payload',()=>{r.board=r.runoutBoard.slice(0,count)});
 }
 atMilestone(r,t.settlementPayloadAt,'settlement-payload',()=>{r.runout=false;finish(r)});
}

function advance(r){if(active(r).length<=1){finish(r);return}if(eligible(r).length===0||(eligible(r).length===1&&eligible(r)[0].bet>=r.highest)){slowRunout(r);return}let pending=r.players.some(p=>canAct(r,p)&&(!p.acted||p.bet<r.highest));if(pending){r.turn=next(r,r.turn,p=>canAct(r,p)&&(!p.acted||p.bet<r.highest));setTurnDeadline(r);send(r);return}if(r.street==='river'){finish(r);return}r.street={preflop:'flop',flop:'turn',turn:'river'}[r.street];let count=r.street==='flop'?3:1;for(let k=0;k<count;k++)r.board.push(r.deck.pop());r.players.forEach(p=>{p.bet=0;p.acted=false;p.lastMove=null});r.highest=0;r.minRaise=handBlinds(r)[1];r.turn=next(r,r.button,p=>canAct(r,p));setTurnDeadline(r);note(r,`${r.street.toUpperCase()} ${r.board.join(' ')}`);send(r)}
function deal(r){if(timed.is(r)){if(!['waiting','done'].includes(r.street)||!timed.before(r))return;timed.reorder(r);}purgeLeavers(r);if(!['waiting','done'].includes(r.street)||r.gameOver||finishGameIfNeeded(r))return;applySelectedRebuys(r);let alive=r.players.filter(p=>!p.spectator&&p.stack>0&&p.socketId);if(alive.length<2)return;if(!r.startedAt)return;[r.handSB,r.handBB]=sessionBlinds(r);r.handMaxBet=r.settings?.maxBet||0;r.button=next(r,r.button,p=>!p.spectator&&p.stack>0&&!!p.socketId);r.handId=crypto.randomBytes(8).toString('hex');r.presentationTimeline=null;r.runoutBoard=null;r.settlementComplete=false;r.players.forEach(p=>{p.presentedHand=null;p.manualRevealHandId=null;p.preAction=null;p.handStartAssets=p.stack+p.bank});r.deck=makeDeck();r.board=[];r.showdown=null;r.showdownReveal=[];r.resultEndsAt=null;r.street='preflop';r.highest=r.handBB;r.minRaise=r.handBB;r.players.forEach(p=>{p.inHand=!p.spectator&&p.stack>0&&!!p.socketId;p.fold=false;p.allin=false;p.capped=false;p.acted=false;p.bet=0;p.contrib=0;p.cards=[];p.lastMove=null});for(let k=0;k<2;k++)for(let j=1;j<=r.players.length;j++){let p=r.players[(r.button+j)%r.players.length];if(p.inHand)p.cards.push(r.deck.pop())}let sb=next(r,r.button,p=>p.inHand),bb=next(r,sb,p=>p.inHand);if(alive.length===2){sb=r.button;bb=next(r,sb,p=>p.inHand)}r.sbIndex=sb;r.bbIndex=bb;bet(r,sb,r.handSB);bet(r,bb,r.handBB);r.highest=Math.max(r.players[sb].bet,r.players[bb].bet);r.turn=next(r,bb,p=>canAct(r,p));setTurnDeadline(r);note(r,`🃏 새 핸드 · SB ${r.handSB.toLocaleString()} / BB ${r.handBB.toLocaleString()}`);send(r);if(r.turn<0||(eligible(r).length===1&&eligible(r)[0].bet>=r.highest))advance(r)}
function lobbyRooms(){return [...rooms.values()].filter(r=>!r.practice&&r.players.some(p=>p.socketId)).map(r=>({code:r.code,name:r.roomName||((r.players.find(p=>p.pid===r.hostPid)?.name||'친구')+'의 방'),count:r.players.filter(p=>p.socketId).length,status:(r.mode==='timed'?'타임제 · ':'토너먼트 · ')+(r.startedAt?'게임중':'대기중'),host:r.players.find(p=>p.pid===r.hostPid)?.name||''})).sort((a,b)=>a.name.localeCompare(b.name,'ko'))}
function emitLobby(){io.emit('rooms:list',lobbyRooms())}
// Practice rooms use the normal poker action validator; only their scheduler is new.
function fillPracticeBots(r){
 if(!r.practice||r.players.length>=9)return;
 const firstFill=!r.players.some(p=>p.bot);
 const used=new Set(r.players.filter(p=>p.bot).map(p=>p.botProfile));
 const profiles=practicePolicy.PROFILES.filter(p=>!used.has(p.id));
 for(let i=profiles.length-1;i>0;i--){const j=crypto.randomInt(i+1);[profiles[i],profiles[j]]=[profiles[j],profiles[i]]}
 while(r.players.length<9&&profiles.length){const pid=crypto.randomBytes(8).toString('hex'),profile=profiles.pop();
  r.players.push({pid,token:crypto.randomBytes(24).toString('hex'),socketId:'practice-bot:'+pid,bot:true,botProfile:profile.id,name:profile.name,
   stack:roomInitialBuyin(r),bank:roomTotalAssets(r)-roomInitialBuyin(r),spectator:false,inHand:false,fold:false,allin:false,bet:0,contrib:0,cards:[],acted:false,lastActivityAt:Date.now()});
 }
 // deal() advances from this index; uniformly random here means a random first dealer.
 if(firstFill)r.button=crypto.randomInt(r.players.length);
}
function closePractice(r,message='연습방을 종료했습니다.'){
 if(r.closed)return;r.closed=true;for(const t of [...(r.practiceTimers||[])])cancelRoomTimer(t);cancelRoomTimer(r.botTimer);cancelRoomTimer(r.nextHandTimer);cancelRoomTimer(r.practiceCloseTimer);
 r.botTimer=null;r.nextHandTimer=null;r.runout=false;rooms.delete(r.code);
 for(const p of r.players){const sock=io.sockets.sockets.get(p.socketId);if(sock){sock.leave(r.code);sock.data.roomCode=null;sock.data.pid=null;sock.emit('room:removed',{message})}}
}
function queuePracticeBot(r){
 if(!r.practice||r.closed||r.practiceClosing||r.pauseAt)return;
 const p=r.players[r.turn],owner=r.players.find(x=>x.pid===r.practiceOwner);
 const key=p?.bot&&owner?.socketId&&canAct(r,p)&&['preflop','flop','turn','river'].includes(r.street)?[r.handId,p.pid,r.turnDeadline].join(':'):null;
 if(r.botKey===key&&r.botTimer)return;cancelRoomTimer(r.botTimer);r.botTimer=null;r.botKey=key;if(!key)return;
 r.botTimer=roomTimeout(r,()=>{
  r.botTimer=null;if(r.closed||!rooms.has(r.code)||r.botKey!==key||r.players[r.turn]!==p||!canAct(r,p))return;
  const view=practiceObservation(r,p,{available:availableBet(r,p),category:r.board.length?best([...p.cards,...r.board])[0]:0,unit:UNIT});
  let action;try{action=practicePolicy.choose(view)}catch(e){action={type:view.toCall?'call':'check'}}const actor={id:p.socketId,data:{roomCode:r.code,pid:p.pid}};touchActivity(p);
  applyPokerAction(actor,action,result=>{if(result?.error)applyPokerAction(actor,{type:view.toCall?'call':'check'})});
 },900+crypto.randomInt(900));
}
function roomOfSocket(id){return [...rooms.values()].find(r=>r.players.some(p=>p.socketId===id))}
function roomPlayerForSocket(s){
  if(s.data?.roomCode&&s.data?.pid){const r=rooms.get(s.data.roomCode),p=r?.players.find(x=>x.pid===s.data.pid);if(r&&p&&p.socketId===s.id)return {r,p}}
  const r=roomOfSocket(s.id),p=r?.players.find(x=>x.socketId===s.id);return r&&p?{r,p}:null
}
function bindSocket(r,p,s){
  const old=p.socketId&&p.socketId!==s.id?io.sockets.sockets.get(p.socketId):null;
  if(old){old.leave(r.code);old.data.roomCode=null;old.data.pid=null;old.emit('session-replaced',{message:'같은 좌석이 다른 창에서 연결되었습니다. 이 창은 대기실로 이동합니다.'})}
  // A reconnect replaces only this player's old connection. Never let a stale socket clear the new one.
  if(!Number.isFinite(p.lastActivityAt))touchActivity(p);p.disconnectedAt=null;p.socketId=s.id;s.data.roomCode=r.code;s.data.pid=p.pid;s.join(r.code);r.emptySince=null;if(timed.is(r))timed.reconnect(r,p);
}
function transferHost(r){const members=r.players.filter(x=>!x.departed&&!x.leaveAfterHand);const nextHost=members.find(x=>x.socketId)||members[0];r.hostPid=nextHost?.pid||null;if(nextHost)note(r,`👑 ${nextHost.name} 방장 승계`)}
function detachToLobby(r,p,s){if(timed.is(r))return timed.detach(r,p,s);if(r.practice&&p.pid===r.practiceOwner){closePractice(r);return}if(r.startedAt)eliminatePlayers(r,[p],'left');if(p.socketId===s.id)p.socketId=null;s.leave(r.code);s.data.roomCode=null;s.data.pid=null;const wasHost=r.hostPid===p.pid;if(!p.inHand||['waiting','done'].includes(r.street)){const i=r.players.indexOf(p);if(i>=0)r.players.splice(i,1);if(r.button>=i)r.button--;if(r.sbIndex!=null&&r.sbIndex>=i)r.sbIndex--;if(r.bbIndex!=null&&r.bbIndex>=i)r.bbIndex--;if(r.turn>=i)r.turn--;r.sessionSeatOrder=(r.sessionSeatOrder||[]).filter(id=>id!==p.pid)}else{p.leaveAfterHand=true;p.departed=true}if(wasHost)transferHost(r);if(!r.players.some(x=>!x.departed&&!x.leaveAfterHand)){cancelRoomTimer(r.nextHandTimer);r.nextHandTimer=null;if(r.league){if(r.startedAt){eliminatePlayers(r,r.players.filter(x=>!x.finalRank),'left');endSession(r,'참가자 퇴장 · 게임 종료')}}else{r.closed=true;rooms.delete(r.code)}}emitLobby()}
function purgeLeavers(r){if(timed.is(r))return;const gone=r.players.filter(p=>p.leaveAfterHand&&!p.socketId);if(!gone.length)return;const ids=new Set(gone.map(p=>p.pid));r.players=r.players.filter(p=>!ids.has(p.pid));r.sessionSeatOrder=(r.sessionSeatOrder||[]).filter(id=>!ids.has(id));r.button=-1;r.sbIndex=null;r.bbIndex=null;r.turn=-1}

function expirePlayer(r,p,reason='30분 무활동'){
 return; // Preserve seats and chips during inactivity/disconnect.
 const live=io.sockets.sockets.get(p.socketId),transport=live||{id:null,data:{},leave:()=>{}};
 const wasTurn=r.turn>=0&&r.players[r.turn]?.pid===p.pid;
 const betting=['preflop','flop','turn','river'].includes(r.street);
 if(betting&&p.inHand&&!p.fold&&!p.allin&&!p.capped){p.fold=true;p.acted=true;markAction(r,p,'fold')}
 note(r,`🚪 ${p.name} ${reason} · 자동 퇴장`);
 if(live)live.emit('idle-exit',{code:r.code,message:'30분 동안 활동이 없어 대기실로 이동했습니다.'});
 detachToLobby(r,p,transport);
 if(rooms.has(r.code)){if(betting&&(wasTurn||active(r).length<=1))advance(r);else send(r)}
}
function expireIdlePlayers(r,now=Date.now()){
 for(const p of [...r.players])if(isIdle(p,now))expirePlayer(r,p);
}
function connlog(...a){console.log(new Date().toISOString(),'[NET]',...a)}
function validNickname(name){return typeof name==='string'&&name.trim().length>0}
function addPlayer(r,name,s,ack,spectator=false){if(!validNickname(name))return ack({error:'닉네임을 입력해주세요.'});if(roomPlayerForSocket(s))return ack({error:'이미 이 방에 착석되어 있습니다.'});name=String(name||'Player').trim().slice(0,14)||'Player';let token=crypto.randomBytes(24).toString('hex'),pid=crypto.randomBytes(8).toString('hex');const total=roomTotalAssets(r);let p={pid,token,socketId:s.id,name,stack:spectator?0:roomInitialBuyin(r),bank:spectator?0:Math.max(0,total-roomInitialBuyin(r)),spectator:!!spectator,inHand:false,fold:false,allin:false,bet:0,contrib:0,cards:[],acted:false,lastActivityAt:Date.now()};if(s.data.leagueRestore){p.pid=s.data.leagueRestore.pid;p.token=s.data.leagueRestore.token;delete s.data.leagueRestore}if(timed.is(r)){try{timed.identify(p,s.data.timedCredentials);}catch(e){return ack({error:e.message,...(e.message.includes('기존 닉네임')?{code:'TAKEOVER_CONFIRM'}:{})});}}r.players.push(p);if(!r.hostPid)r.hostPid=p.pid;bindSocket(r,p,s);note(r,spectator?`${name} 관전 입장`:`${name} 입장`);ack({code:r.code,token:p.token,pid:p.pid,spectator:!!spectator,lastActivityAt:p.lastActivityAt,serverNow:Date.now()});send(r)}
function armAutoRebuy(r,p){
 if(r.startedAt&&!r.gameOver&&p.rebuyEligible&&p.stack===0&&p.bank>0&&!p.rebuyDeadline)p.rebuyDeadline=roomNow(r)+10000;
}
function completeRebuy(r,p,amount){
 if(!p.rebuyEligible||p.spectator||p.stack!==0||amount<=0||p.bank<amount)return false;
 p.bank-=amount;p.stack+=amount;p.rebuyEligible=false;p.rebuyHandId=null;p.rebuyDeadline=null;
 note(r,`${p.name} ${amount.toLocaleString()} 리바이`);
 if(r.startedAt&&['waiting','done'].includes(r.street)&&r.players.filter(x=>!x.spectator&&x.stack>0&&x.socketId).length>=2&&!r.nextHandTimer)scheduleNext(r);
 return true;
}
function tickAutoRebuy(r){if(timed.is(r))return;
 if(r.street==='done'&&applySelectedRebuys(r)){scheduleNext(r,Math.max(400,(r.resultEndsAt||roomNow(r))-roomNow(r)+400));send(r)}
 for(const p of r.players){
  if(!p.rebuyEligible||p.stack!==0||p.spectator||!r.startedAt||r.gameOver)continue;
  // A missed presentation acknowledgement must not strand a reconnecting player.
  // The old hand has ended; alternatively allow the complete server result window.
  if(p.rebuyHandId!==r.handId||(r.street==='done'&&r.resultEndsAt&&roomNow(r)>=r.resultEndsAt))armAutoRebuy(r,p);
  if(p.rebuyDeadline&&roomNow(r)>=p.rebuyDeadline)completeRebuy(r,p,Math.min(50000,p.bank));
 }
}
// Room-local league. Poker sessions, not individual hands, produce one entry.
const LEAGUE_POINT_MAX=1000000;
function applyPokerAction(s,{type,amount},ack=()=>{}){
 const rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;
 if(r?.pauseAt)return ack({error:'연습이 일시정지되어 있습니다.'});
 if(!r||!p||r.turn<0||r.players[r.turn]!==p||!canAct(r,p))return ack({error:'내 차례가 아닙니다.'});
 const call=Math.max(0,r.highest-p.bet),available=availableBet(r,p),max=p.bet+available,min=r.highest+r.minRaise;
 if(type==='allin'&&available<p.stack)return ack({error:'MAX 베팅 상한입니다. MAX 버튼을 사용하세요.'});
 const chosenMax=type==='max';
 if(chosenMax)type=available===p.stack?'allin':'max';
 if(type==='fold'){p.fold=true;p.acted=true;markAction(r,p,'fold');note(r,p.name+' 폴드')}
 else if(type==='check'&&call===0){p.acted=true;markAction(r,p,'check');note(r,p.name+' 체크')}
 else if(type==='call'&&call>0){bet(r,r.turn,call);p.acted=true;markAction(r,p,p.allin?'allin':p.capped?'max':'call','call');note(r,p.name+(p.allin?' 올인 콜':p.capped?' MAX 콜':' 콜'))}
 else if((type==='allin'||type==='max')&&max<=r.highest){bet(r,r.turn,available);p.acted=true;markAction(r,p,type,'call');note(r,`${p.name} ${type==='max'?'MAX':'올인'} ${max.toLocaleString()}`)}
 else if(type==='raise'||type==='allin'||type==='max'){
  const total=type==='raise'?Number(amount):max;
  if(!Number.isSafeInteger(total)||total%UNIT!==0||total<=r.highest||total>max||(total<min&&total!==max))return ack({error:`레이즈는 ${Math.min(min,max).toLocaleString()}~${max.toLocaleString()}까지, 1,000 단위입니다.`});
  const previous=r.highest;bet(r,r.turn,total-p.bet);r.highest=p.bet;const size=r.highest-previous;
  if(size>=r.minRaise){r.minRaise=size;r.players.forEach(q=>{if(q!==p&&canAct(r,q))q.acted=false})}
  p.acted=true;const actual=p.allin?'allin':p.capped?'max':'raise';markAction(r,p,actual,'raise');
  note(r,`${p.name} ${actual==='allin'?'올인':actual==='max'?'MAX':'레이즈'} ${total.toLocaleString()}`);
 }else return ack({error:'잘못된 액션'});
 ack({ok:true});advance(r);
 }
function queuePreAction(r){
 if(r.pauseAt)return;
 const p=r.players[r.turn],q=p?.preAction;if(!q)return;
 if(q.handId!==r.handId||!canAct(r,p)){p.preAction=null;return}
 if(!p.socketId||p.preActionQueued)return;p.preActionQueued=true;
 roomTimeout(r,()=>{p.preActionQueued=false;if(p.preAction!==q||r.handId!==q.handId||r.players[r.turn]!==p||!canAct(r,p))return;
 const sock=io.sockets.sockets.get(p.socketId);if(!sock)return;p.preAction=null;
 applyPokerAction(sock,{type:q.type},result=>{if(result?.error)send(r)});
 },900);
}
function removeMember(r,p,reason){
 const live=io.sockets.sockets.get(p.socketId),transport=live||{id:null,data:{},leave:()=>{}};
 const betting=['preflop','flop','turn','river'].includes(r.street),wasTurn=r.players[r.turn]===p;
 if(betting&&p.inHand&&!p.allin&&!p.capped){p.fold=true;p.acted=true;markAction(r,p,'fold')}
 p.preAction=null;
 if(live)live.emit('room:removed',{message:reason});
 detachToLobby(r,p,transport);
 if(rooms.has(r.code)){if(betting&&(wasTurn||active(r).length<=1))advance(r);else send(r)}
}
function leagueMembers(r){return r.players.filter(p=>!p.departed&&!p.leaveAfterHand)}
function leagueIds(r){return leagueMembers(r).map(p=>p.pid).sort()}
function leagueSame(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function leagueCopy(v){return JSON.parse(JSON.stringify(v))}
function leagueDefault(n){return {count:n,bet:1,awards:Array.from({length:9},(_,i)=>i===0?n:0)}}
function leagueEnsure(r){if(!r.league)r.league={phase:'editing',version:1,draft:leagueDefault(Math.max(2,leagueMembers(r).length)),active:null,approvals:[],proposalIds:[],approvedIds:[],presets:{},ledger:{},history:[],pendingSettlement:null,decisions:{},ledgerVersion:0,activation:0,notice:null};leagueSyncMembers(r);return r.league}
function leagueValidation(c){
 if(!c||!Number.isInteger(c.count)||c.count<2||c.count>9)return {valid:false,error:'참가 인원을 2~9명으로 선택해주세요.'};
 if(!Number.isSafeInteger(c.bet)||c.bet<1||c.bet>LEAGUE_POINT_MAX)return {valid:false,error:'참가비은 1~1,000,000만의 정수로 입력해주세요.'};
 if(!Array.isArray(c.awards)||c.awards.length!==9||c.awards.slice(0,c.count).some(v=>!Number.isSafeInteger(v)||v<0||v>9*LEAGUE_POINT_MAX))return {valid:false,error:'활성 순위의 순위별 획득금를 0 이상의 정수로 입력해주세요.'};
 const total=c.count*c.bet,sum=c.awards.slice(0,c.count).reduce((a,b)=>a+b,0),delta=sum-total;
 return {valid:delta===0,total,sum,delta,error:delta<0?`${-delta}만원을 더 배분해주세요.`:delta>0?`${delta}만 초과했습니다.`:null};
}
function leagueSyncMembers(r){const l=r.league;if(!l)return;
 for(const p of r.players){if(p.departed)continue;let row=l.ledger[p.pid];if(!row&&p.spectator)continue;if(!row){row=l.ledger[p.pid]={pid:p.pid,name:p.name,token:p.token,points:0,games:0};l.ledgerVersion++}row.name=p.name;}
 if(l.phase==='consent'&&!leagueSame(l.proposalIds,leagueIds(r))){l.phase='invalid';l.approvals=[];l.proposalIds=[];l.version++;l.notice='참가 인원이 변경되었습니다. 토너먼트 설정을 다시 맞춰주세요.';}
}
// V7.15.1: observer visits are not settlement participation. Keep historical data
// intact; omit legacy zero-game visitors from the displayed cumulative table.
function leagueHasParticipation(r,pid){
 const l=r.league,row=l?.ledger[pid];
 return !!(row?.hasParticipated||row?.games||row?.points||
  r.leagueGame?.participants.some(p=>p.pid===pid)||
  l?.pendingSettlement?.players.some(p=>p.pid===pid)||
  l?.history.some(g=>g.players?.some(p=>p.pid===pid)));
}
// Same room nickname is the settlement display identity; original IDs/history stay intact.
function leagueTotals(r){
 const groups=new Map();
 for(const row of Object.values(r.league?.ledger||{})){
  if(!leagueHasParticipation(r,row.pid)&&!leagueMembers(r).some(p=>p.pid===row.pid&&!p.spectator))continue;
  const key=String(row.name).normalize('NFC').trim();
  let total=groups.get(key);if(!total){total={pid:row.pid,name:key,points:0,games:0,left:true};groups.set(key,total)}
  total.points+=row.points;total.games+=row.games;
  if(leagueMembers(r).some(p=>p.name.normalize('NFC').trim()===key))total.left=false;
 }
 return [...groups.values()].sort((a,b)=>b.points-a.points||a.pid.localeCompare(b.pid));
}
function leaguePublic(r){const l=r.league;return {code:r.code,host:r.hostPid,members:leagueMembers(r).map(p=>({pid:p.pid,name:p.name})),phase:l?.phase||'off',version:l?.version||0,active:l?.active||null,draft:l?.draft||null,validation:leagueValidation(l?.draft),approvals:l?.approvals||[],proposalIds:l?.proposalIds||[],activation:l?.activation||0,notice:l?.notice||null,error:l?.error||null,presets:l?.presets||{},ledgerVersion:l?.ledgerVersion||0,automatic:l?.automatic||null,ledger:leagueTotals(r),history:l?.history||[],pendingSettlement:l?.pendingSettlement||null,currentGame:r.leagueGame?{id:r.leagueGame.id,version:r.leagueGame.version,config:r.leagueGame.config,finished:!!r.leagueGame.settlementStatus,status:r.leagueGame.settlementStatus||'running'}:null};}
function leagueBroadcast(r){leagueSyncMembers(r);const payload=leaguePublic(r),key=JSON.stringify(payload);for(const p of leagueMembers(r)){const sock=io.sockets.sockets.get(p.socketId);if(sock&&sock.data.leagueSent!==key){sock.data.leagueSent=key;sock.emit('league:state',payload)}}}
function leagueStartError(r){const l=r.league;if(!l)return null;if(l.pendingSettlement)return '이전 게임의 정산 반영 여부를 먼저 선택해주세요.';leagueSyncMembers(r);
 if(l.phase!=='idle'||!l.active)return '토너먼트 설정을 확정하고 참가자 전원이 확인해야 게임을 시작할 수 있습니다.';
 if(l.active.count!==leagueMembers(r).length)return `토너먼트 설정과 현재 참가 인원이 다릅니다. 정산 ${l.active.count}인 / 현재 ${leagueMembers(r).length}인. 토너먼트 설정을 다시 맞춰주세요.`;
 if(!leagueSame(l.approvedIds,leagueIds(r)))return '참가자가 변경되었습니다. 토너먼트 설정에서 다시 전원 확인을 받아주세요.';
 return leagueValidation(l.active).valid?null:'정산 금액 설정을 다시 확인해주세요.';
}
function leagueSnapshot(r){if(r.league?.pendingSettlement)throw new Error('Pending settlement blocks new game');r.leagueGame=null;if(!r.league?.active)return;const l=r.league;
// start() promotes these confirmed members into this session immediately after
// snapshot. Register former spectators now, not during their observer visits.
for(const p of leagueMembers(r)){
 let row=l.ledger[p.pid];if(!row){row=l.ledger[p.pid]={pid:p.pid,name:p.name,token:p.token,points:0,games:0};l.ledgerVersion++}
 row.hasParticipated=true;
}
r.leagueGame={id:crypto.randomBytes(12).toString('hex'),version:l.active.version,config:leagueCopy(l.active),participants:leagueMembers(r).map(p=>({pid:p.pid,name:p.name})),startedAt:Date.now(),settlementStatus:null};r.leagueGame.gameId=r.leagueGame.id;}
function leagueSettle(r){const g=r.leagueGame,l=r.league;if(!g||g.settlementStatus||!l)return;
 if(l.pendingSettlement){l.error='이전 게임의 정산 반영 여부를 먼저 선택해주세요.';return}
 const rows=g.participants.map(p=>{const rank=r.finalRanking.find(x=>x.pid===p.pid)?.rank;return {...p,rank,acquired:g.config.awards[rank-1],bet:g.config.bet}});
 if(rows.length!==g.config.count||new Set(rows.map(x=>x.rank)).size!==rows.length||rows.some(x=>!Number.isInteger(x.rank)||x.rank<1||x.rank>rows.length||!Number.isSafeInteger(x.acquired))){l.error='정산 결과 검증에 실패했습니다. 누적하지 않았습니다.';return}
 rows.forEach(x=>x.delta=x.acquired-x.bet);if(rows.reduce((a,x)=>a+x.delta,0)!==0){l.error='정산 변동 합계 오류로 누적하지 않았습니다.';return}
 // Calculation is deliberately separate from committing totals.
 l.pendingSettlement={gameId:g.id,id:g.id,status:'pending',startedAt:g.startedAt,endedAt:Date.now(),version:g.version,config:leagueCopy(g.config),players:rows.sort((a,b)=>a.rank-b.rank)};
 g.settlementStatus='pending';l.error=null;
}
function leagueDecideUnsafe(r,p,data){const l=r.league;if(!l||typeof data.gameId!=='string'||!['applied','excluded'].includes(data.decision))return {error:'정산 요청을 확인해주세요.'};
 const prior=l.decisions?.[data.gameId];if(prior)return {ok:true,alreadyResolved:true,status:prior.status};
 const pending=l.pendingSettlement;if(!pending||pending.gameId!==data.gameId||pending.status!=='pending')return {error:'현재 대기 중인 게임 정산이 아닙니다.'};
 if(data.decision==='applied'){
  const rows=pending.players;if(rows.reduce((a,x)=>a+x.delta,0)!==0)return {error:'정산 변동 합계가 올바르지 않습니다.'};
  for(const x of rows){const row=l.ledger[x.pid];if(!row||!Number.isSafeInteger(row.points+x.delta)||!Number.isSafeInteger(row.games+1))return {error:'상금누적값을 확인할 수 없습니다.'}}
  // Synchronous, once-only commit. No awaits between checking the ID and storing its decision.
  for(const x of rows){l.ledger[x.pid].points+=x.delta;l.ledger[x.pid].games++}
  l.history.push({...leagueCopy(pending),status:'applied',decidedBy:p.pid,decidedAt:Date.now()});l.ledgerVersion++;
 }
 (l.decisions||(l.decisions={}))[pending.gameId]={status:data.decision,decidedBy:p.pid,decidedAt:Date.now()};
 if(r.leagueGame?.id===pending.gameId)r.leagueGame.settlementStatus=data.decision;
 l.pendingSettlement=null;l.error=null;return {ok:true,status:data.decision};
}
// Account mutations are staged on a clone and published only after durable replacement succeeds.
function automaticLedger(l){if(l.automatic)return structuredClone(l.automatic);const a=settlementLedger.create();const rows=Object.values(l.ledger).filter(x=>x.hasParticipated||x.games||x.points);if(rows.length)settlementLedger.settleDeltas(a,'legacy-import',rows.map(x=>({pid:x.pid,name:x.name,delta:String(BigInt(x.points)*120000n)})),{mode:'tournament',legacy:true});return a;}
function leagueDecide(r,p,data){const original=r.league,oldStatus=r.leagueGame?.settlementStatus;r.league=leagueCopy(original);try{const result=leagueDecideUnsafe(r,p,data);if(result.error||result.alreadyResolved){r.league=original;return result;}if(data.decision==='applied'){r.league.automatic=automaticLedger(original);const g=r.league.history.at(-1);settlementLedger.settleDeltas(r.league.automatic,g.gameId,g.players.map(x=>({pid:x.pid,name:x.name,delta:String(BigInt(x.delta)*120000n)})),{mode:'tournament'});}if(r.league.automatic)timed.persist(r);return result;}catch(e){r.league=original;if(r.leagueGame)r.leagueGame.settlementStatus=oldStatus;throw e;}}
function completeLeaguePayment(r,p,d){if(r.startedAt)throw Error('경기 종료 후 실제 정산 완료를 기록해주세요.');const original=r.league;if(!original)throw Error('누적정산 기록이 없습니다.');const next=leagueCopy(original);next.automatic=automaticLedger(original);settlementLedger.confirm(next.automatic,{version:d.version,pid:d.pid,actor:p.pid,requestId:d.requestId});try{r.league=next;timed.persist(r);}catch(e){r.league=original;throw e;}return {ok:true};}
function installLeagueHandlers(s){
 const handler=(event,host,fn)=>s.on(event,(data,callback)=>{const ack=typeof callback==='function'?callback:()=>{};const rp=roomPlayerForSocket(s);if(!rp)return ack({error:'방에 입장해주세요.'});if(host&&rp.p.pid!==rp.r.hostPid)return ack({error:'방장만 변경할 수 있습니다.'});try{const result=fn(rp.r,rp.p,data||{});leagueBroadcast(rp.r);ack(result||{ok:true})}catch(e){console.error('[LEAGUE]',e);ack({error:'정산 요청을 처리하지 못했습니다.'})}});
 handler('league:open',true,(r)=>{if(timed.is(r))return {error:'타임제 누적정산을 사용해주세요.'};if(r.practice)return {error:'봇 연습방은 토너먼트 상금누적을 사용하지 않습니다.'};const l=leagueEnsure(r);if(l.phase==='idle'||l.phase==='invalid'){l.draft=leagueCopy(l.active||l.draft);l.phase='editing';l.approvals=[];l.version++;l.notice=null}return {ok:true}});
 handler('league:edit',true,(r,p,d)=>{const l=r.league;if(!l||d.version!==l.version)return {error:'설정이 변경되었습니다. 최신 설정에서 다시 입력해주세요.',code:'STALE_VERSION'};if(!['editing','consent','invalid'].includes(l.phase))return {error:'토너먼트 설정을 먼저 열어주세요.'};
 const c={...l.draft};if(Object.hasOwn(d,'count')){if(!Number.isInteger(d.count)||d.count<2||d.count>9)return {error:'참가 인원을 확인해주세요.'};Object.assign(c,leagueCopy(l.presets[d.count]||{...c,count:d.count}));c.count=d.count}
 if(Object.hasOwn(d,'bet'))c.bet=d.bet;if(Object.hasOwn(d,'awards')){if(!Array.isArray(d.awards)||d.awards.length!==9)return {error:'순위 입력을 확인해주세요.'};c.awards=d.awards.slice()}
 // Null represents a temporarily empty numeric input; it is shared but cannot be confirmed.
 if((c.bet!==null&&(!Number.isSafeInteger(c.bet)||c.bet<1||c.bet>LEAGUE_POINT_MAX))||c.awards.some(v=>v!==null&&(!Number.isSafeInteger(v)||v<0||v>9*LEAGUE_POINT_MAX)))return {error:'정산 금액은 허용 범위의 정수로 입력해주세요.'};
 l.draft=c;l.version++;l.approvals=[];l.proposalIds=[];l.phase='editing';l.notice=null;return {ok:true,version:l.version};});
 handler('league:confirm',true,(r,p,d)=>{const l=r.league;if(!l||d.version!==l.version)return {error:'최신 설정을 다시 확인해주세요.'};const v=leagueValidation(l.draft);if(!v.valid)return {error:v.error};if(l.draft.count!==leagueMembers(r).length)return {error:`토너먼트 설정 ${l.draft.count}인 / 현재 참가 ${leagueMembers(r).length}인. 인원을 맞춰주세요.`};l.phase='consent';l.approvals=[];l.proposalIds=leagueIds(r);l.version++;l.notice=null;return {ok:true}});
 handler('league:agree',false,(r,p,d)=>{const l=r.league;leagueSyncMembers(r);if(!l||l.phase!=='consent'||d.version!==l.version||!l.proposalIds.includes(p.pid))return {error:'참가자 또는 설정이 변경되었습니다. 다시 확인해주세요.'};if(!l.approvals.includes(p.pid))l.approvals.push(p.pid);
 if(l.approvals.length===l.proposalIds.length){l.active={...leagueCopy(l.draft),version:l.version};l.presets[l.active.count]=leagueCopy(l.draft);l.approvedIds=l.proposalIds.slice();l.phase='idle';l.activation++;l.notice=null}return {ok:true}});
 handler('settlement:decide',true,leagueDecide);
 handler('settlement:complete',true,completeLeaguePayment);
 handler('league:reset',true,(r,p,d)=>{const original=r.league;if(!original)return {ok:true};if(original.pendingSettlement)return {error:'이전 게임 정산을 먼저 처리해주세요.'};if(d.ledgerVersion!==original.ledgerVersion)return {error:'정산이 변경되었습니다.'};const l=leagueCopy(original);(l.accountArchives||(l.accountArchives=[])).push({at:Date.now(),actor:p.pid,ledger:leagueCopy(l.ledger),history:l.history,automatic:l.automatic||null});for(const row of Object.values(l.ledger)){row.points=0;row.games=0}l.history=[];l.automatic=settlementLedger.create();l.ledgerVersion++;l.error=null;try{r.league=l;timed.persist(r);}catch(e){r.league=original;throw e;}return {ok:true}});
 handler('league:get',false,()=>({ok:true}));
}

io.on('connection',s=>{
 installLeagueHandlers(s);
 timed.handlers(s);
 const meaningful=new Set(['auto-rebuy:set','practice:pause','practice:cards','settlement:decide','league:open','league:edit','league:confirm','league:agree','league:reset','activity','pre-action','room:kick','chat:send','action','reaction','settings','start','rebuy','restart-session']);
 s.use((packet,next)=>{
  if(meaningful.has(packet[0])){const rp=roomPlayerForSocket(s);if(rp){
   if(isIdle(rp.p)){expirePlayer(rp.r,rp.p);const cb=packet.at(-1);if(typeof cb==='function')cb({error:'30분 무활동으로 퇴장되었습니다.',code:'IDLE_EXIT'});return}
   touchActivity(rp.p);
  }}next();
 });
 s.on('clock:ping',(ack)=>{if(typeof ack==='function')ack({now:Date.now()})});
 s.on('activity',()=>{});
 s.on('leave-idle',({code,token},ack=()=>{})=>{
  const r=rooms.get(String(code||'').toUpperCase()),p=r?.players.find(p=>p.token===token&&!p.departed);
  if(r&&p&&isIdle(p))expirePlayer(r,p);ack({ok:true});
 });

 connlog('connect',s.id,'transport='+s.conn.transport.name,'recovered='+!!s.recovered);
 s.conn.on('upgrade',t=>connlog('upgrade',s.id,'transport='+t.name));
 s.conn.on('error',e=>connlog('engine-error',s.id,e?.message||e));

 s.on('auto-rebuy:set',(data={},ack=()=>{})=>{
  const rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;
  if(!r||r.practice||!p||p.bot||p.spectator||p.departed||p.leaveAfterHand||p.socketId!==s.id)return ack({error:'일반 홀덤방의 참가자만 설정할 수 있습니다.'});
  if(![50000,100000].includes(data?.amount))return ack({error:'자동 리바이는 5만 또는 10만 중 선택하세요.'});
  p.autoRebuyAmount=data.amount;touchActivity(p);
  if(r.street==='done'&&applySelectedRebuys(r))scheduleNext(r,Math.max(400,(r.resultEndsAt||roomNow(r))-roomNow(r)+400));
  send(r);ack({ok:true,amount:p.autoRebuyAmount});
 });
 s.on('practice:pause',(data={},ack=()=>{})=>{
  const rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;
  if(!r?.practice||p?.pid!==r.practiceOwner||p.socketId!==s.id)return ack({error:'연습방 주인만 사용할 수 있습니다.'});
  if(!r.startedAt||r.practiceClosing||typeof data.paused!=='boolean')return ack({error:'진행 중인 연습에서만 사용할 수 있습니다.'});
  setPracticePaused(r,data.paused);touchActivity(p);send(r);ack({ok:true,paused:!!r.pauseAt});
 });
 s.on('practice:cards',(data={},ack=()=>{})=>{
  const rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;
  if(!r?.practice||p?.pid!==r.practiceOwner||p.socketId!==s.id)return ack({error:'연습방에서만 사용할 수 있습니다.'});
  if(data.handId!==r.handId||r.street!=='done'||!r.settlementComplete||!r.showdown)return ack({error:'이번 핸드가 끝난 뒤 봇 좌석을 눌러주세요.'});
  // A fold ends the hand immediately. Showdown still follows its public result timeline.
  if(r.showdown.showdown!==false&&roomNow(r)<(r.presentationTimeline?.resultRevealAt||0))return ack({error:'결과 공개 후 봇 좌석을 눌러주세요.'});
  const target=r.players.find(x=>x.pid===data.pid&&x.bot&&x.cards?.length===2);
  if(!target)return ack({error:'이번 핸드에 패를 받은 봇을 선택해주세요.'});
  // Presentation only; winner/refund accounting and the bot observation never change.
  if(!(r.showdownReveal||[]).includes(target.pid))r.showdownReveal=[...(r.showdownReveal||[]),target.pid];
  target.manualRevealHandId=r.handId;touchActivity(p);send(r);
  ack({ok:true,handId:r.handId,pid:target.pid});
 });
 s.on('rooms:list',()=>s.emit('rooms:list',lobbyRooms()));
 s.on('create',({name,practice=false,mode='tournament',timedCredentials},ack)=>{s.data.timedCredentials=timedCredentials;if(roomPlayerForSocket(s))return ack({error:'이미 방에 입장 중입니다.'});if(!validNickname(name))return ack({error:'닉네임을 입력해주세요.'});let code;do{code=crypto.randomBytes(3).toString('hex').toUpperCase()}while(rooms.has(code));let cleanName=String(name||'Player').trim().slice(0,14)||'Player';let r={code,roomName:cleanName+'의 방',practice:practice===true,players:[],hostPid:null,button:-1,street:'waiting',board:[],turn:-1,highest:0,minRaise:BB,handSB:SB,handBB:BB,startedAt:null,log:[],endsAt:null,gameOver:false,turnDeadline:null,lastAction:null,actionSeq:0,nextHandTimer:null,nextHandAt:null,runout:false,showdown:null,showdownReveal:[],resultEndsAt:null,emptySince:null,finalRanking:null,sbIndex:null,bbIndex:null,settings:{minutes:30,totalAssets:200000,initialBuyin:50000,blindMinutes:5,maxBet:0},sessionSeatOrder:[],restartRequested:false};if(r.practice){r.settings.totalAssets=500000;r.settings.initialBuyin=500000}r.settings.turnSeconds=17;if(mode==='timed'&&!r.practice){try{timed.init(r);}catch(e){return ack({error:e.message});}}rooms.set(code,r);addPlayer(r,cleanName,s,res=>{if(res.error){rooms.delete(code);return ack(res)}r.hostPid=res.pid;if(timed.is(r))r.players[0].timedSeat=0;if(r.practice){r.practiceOwner=res.pid;fillPracticeBots(r);send(r)}ack(res);if(!r.practice)emitLobby()})});
 s.on('join',({code,name,token,timedCredentials,takeover},ack)=>{if(!validNickname(name))return ack({error:'닉네임을 입력해주세요.'});delete s.data.leagueRestore;let existing=roomPlayerForSocket(s);if(existing)return ack({error:'이미 한 자리에 착석되어 있습니다.'});let r=rooms.get(String(code||'').toUpperCase());if(!r)return ack({error:'방을 찾을 수 없습니다.'});if(r.practice&&(!token||!r.players.some(p=>p.pid===r.practiceOwner&&p.token===token)))return ack({error:'비공개 연습방입니다.'});if(timed.is(r))return timed.join(r,String(name).trim().slice(0,14),token,s,ack,timedCredentials);const same=r.players.find(x=>x.name===String(name).trim().slice(0,14)&&!x.departed&&!x.bot);if(same){if(token!==same.token&&!takeover)return ack({code:'TAKEOVER_CONFIRM',error:'이미 같은 닉네임이 플레이 중입니다.'});if(token!==same.token)same.token=crypto.randomBytes(24).toString('hex');bindSocket(r,same,s);touchActivity(same);ack({code:r.code,pid:same.pid,token:same.token,resumed:true});send(r);return;}if(r.gameOver)return ack({error:'이미 종료된 방입니다.'});name=String(name||'Player').trim().slice(0,14)||'Player';if(r.players.some(p=>p.name===name&&p.socketId))return ack({error:'같은 닉네임이 이미 접속 중입니다.'});/* V5.59 fallback for in-app browsers that lose/recreate the webview: same nickname + disconnected seat means reconnect, never a new spectator. */let ghost=r.players.find(x=>((token&&x.token===token)||(!r.league?.automatic&&x.name===name))&&!x.socketId&&!x.departed&&!x.leaveAfterHand);if(r.practice&&ghost?.pid!==r.practiceOwner)ghost=null;if(ghost&&isIdle(ghost)){expirePlayer(r,ghost);ghost=null;if(!rooms.has(r.code))return ack({error:'방이 종료되었습니다. 새 방을 만들어주세요.'})}if(ghost){if(token===ghost.token)ghost.name=name;bindSocket(r,ghost,s);note(r,`${ghost.name} 기존 좌석 복귀`);ack({code:r.code,token:ghost.token,pid:ghost.pid,resumed:true,spectator:!!ghost.spectator,lastActivityAt:ghost.lastActivityAt,serverNow:Date.now()});connlog('name-resume',r.code,ghost.pid,s.id);send(r);emitLobby();return}if(r.league){const old=Object.values(r.league.ledger).find(x=>token&&x.token===token)||(!r.league.automatic&&Object.values(r.league.ledger).find(x=>x.name===name));if(old){if(!r.players.some(x=>x.pid===old.pid))s.data.leagueRestore=old}}if(leagueMembers(r).length>=9)return ack({error:'9명이 모두 찼습니다.'});if(r.startedAt)return addPlayer(r,name,s,res=>{ack(res);emitLobby()},true);addPlayer(r,name,s,res=>{ack(res);emitLobby()})});
 s.on('resume',({code,token},ack)=>{let r=rooms.get(String(code||'').toUpperCase());if(!r)return ack({error:'방이 없습니다.'});let p=r.players.find(x=>x.token===token&&!x.departed&&!x.leaveAfterHand);if(!p||p.bot||(r.practice&&p.pid!==r.practiceOwner))return ack({error:'재접속 정보가 없습니다.'});if(!validNickname(p.name))return ack({error:'닉네임을 입력한 뒤 방에 입장해주세요.',code:'NAME_REQUIRED'});if(isIdle(p)){expirePlayer(r,p);return ack({error:'30분 무활동으로 퇴장되었습니다.',code:'IDLE_EXIT'})}bindSocket(r,p,s);ack({code:r.code,token:p.token,pid:p.pid,resumed:true,lastActivityAt:p.lastActivityAt,serverNow:Date.now()});note(r,`${p.name} 재접속`);connlog('resume',r.code,p.pid,s.id);
  // V5.5: 전원이 백그라운드로 나간 사이 핸드가 끝나면 nextHandTimer가 없는 채로 대기할 수 있다.
  // 두 명 이상 복귀한 순간 세션이 살아 있으면 다음 핸드 스케줄을 다시 깨운다.
  const connectedReady=r.players.filter(x=>!x.spectator&&x.stack>0&&x.socketId).length;
  if(r.pauseAt){send(r);return}if(r.startedAt&&(timed.is(r)||!r.endsAt||roomNow(r)<r.endsAt)&&['waiting','done'].includes(r.street)&&connectedReady>=2&&!r.nextHandTimer){scheduleNext(r,NEXT_HAND_MS);return}
  // 진행 중 핸드라면 기존 서버 턴/마감시간을 그대로 유지한다. 이미 시간이 지났으면 즉시 자동 폴드해 정지 상태를 해소한다.
  if(r.startedAt&&r.turn>=0&&r.turnDeadline&&roomNow(r)>=r.turnDeadline){let tp=r.players[r.turn];if(tp&&tp.inHand&&!tp.fold&&!tp.allin){tp.fold=true;tp.acted=true;markAction(r,tp,'timeout');note(r,`⏱️ ${tp.name} 시간초과 · 자동 폴드`);advance(r);return}}
  send(r)});
 s.on('leave-room',(ack=()=>{})=>{let rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;if(!r||!p)return ack({error:'입장한 방이 없습니다.'});let wasTurn=r.turn>=0&&r.players[r.turn]?.pid===p.pid;if(r.startedAt&&['preflop','flop','turn','river'].includes(r.street)&&p.inHand&&!p.fold&&!p.allin&&!p.capped){p.fold=true;p.acted=true;markAction(r,p,'fold');note(r,`🚪 ${p.name} 방 나가기 · 자동 폴드`)}else note(r,`🚪 ${p.name} 대기실로 이동`);detachToLobby(r,p,s);ack({ok:true});if(rooms.has(r.code)){if(r.startedAt&&['preflop','flop','turn','river'].includes(r.street)&&(wasTurn||active(r).length<=1))advance(r);else send(r)}});
 s.on('restart-session',(ack=()=>{})=>{let rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;if(timed.is(r))return ack({error:'타임제는 막1 종료 후 자동 정산됩니다.'});if(!r||!p||p.pid!==r.hostPid)return ack({error:'방장만 새 게임을 준비할 수 있습니다.'});if(r.pauseAt)return ack({error:'계속하기 후 새 게임을 준비해주세요.'});if(r.league?.pendingSettlement){const message='이전 게임의 정산 반영 여부를 먼저 선택해주세요.';s.emit('league:error',{message});return ack({error:message})}if(!r.startedAt){ack({ok:true,ready:true});send(r);return}if(['waiting','done'].includes(r.street)&&!(r.resultEndsAt>roomNow(r))){endSession(r,'방장 요청 · 새 게임 준비');ack({ok:true});return}r.restartRequested=true;note(r,'🔄 방장이 새 게임 준비를 요청했습니다 · 현재 핸드 종료 후 전환');ack({ok:true});send(r)});
 s.on('settings',({minutes,totalAssets,initialBuyin=50000,blindMinutes,maxBet=0,turnSeconds=17},ack=()=>{})=>{let rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;if(!r||p?.pid!==r.hostPid)return ack({error:'방장만 게임설정을 바꿀 수 있습니다.'});if(timed.is(r))return ack({error:'타임제 전용 설정을 사용해주세요.'});if(r.startedAt)return ack({error:'게임 시작 전에서만 설정할 수 있습니다.'});if([minutes,totalAssets,initialBuyin,blindMinutes,maxBet,turnSeconds].some(v=>v===null||typeof v==='boolean'||v===''))return ack({error:'잘못된 게임설정입니다.'});if(typeof maxBet!=='number'&&(typeof maxBet!=='string'||!/^\d+$/.test(maxBet)))return ack({error:'잘못된 MAX 베팅입니다.'});minutes=Number(minutes);totalAssets=Number(totalAssets);blindMinutes=Number(blindMinutes);initialBuyin=Number(initialBuyin);maxBet=Number(maxBet);turnSeconds=Number(turnSeconds);if(!Number.isInteger(turnSeconds)||turnSeconds<5||turnSeconds>120)return ack({error:'턴 시간은 5~120초입니다.'});if(!Number.isInteger(minutes)||minutes<0||minutes>1440||!Number.isInteger(blindMinutes)||blindMinutes<0||blindMinutes>1440||![totalAssets,initialBuyin].every(n=>Number.isSafeInteger(n)&&n>=UNIT&&n<=100000000&&n%UNIT===0)||initialBuyin>totalAssets||!Number.isSafeInteger(maxBet)||maxBet<0||maxBet>100000000||maxBet%UNIT!==0)return ack({error:'잘못된 게임설정입니다.'});if(r.practice)initialBuyin=totalAssets;r.settings={minutes,totalAssets,initialBuyin,blindMinutes,maxBet,turnSeconds};r.handMaxBet=maxBet;r.players.forEach(x=>{x.stack=roomInitialBuyin(r);x.bank=Math.max(0,totalAssets-x.stack)});note(r,`⚙️ 게임설정 · ${durationLabel(r)} · 총자산 ${totalAssets.toLocaleString()} · 블라인드업 ${blindMinutes===0?'없음':blindMinutes+'분'}`);ack({ok:true});send(r)});
 s.on('start',(arg,callback)=>{const ack=typeof arg==='function'?arg:typeof callback==='function'?callback:()=>{};let rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;if(!r||p?.pid!==r.hostPid||r.startedAt||!['waiting','done'].includes(r.street))return;if(r.pauseAt)return ack({error:'계속하기 후 시작해주세요.'});if(timed.is(r))return ack({error:'타임제 시작을 사용해주세요.'});if(r.practiceClosing)return ack({error:'연습방 종료 중입니다.'});if(r.practice)fillPracticeBots(r);const offline=leagueMembers(r).filter(x=>!x.socketId);if(offline.length){const message=offline.map(x=>x.name).join(', ')+'님 재연결 대기 중';s.emit('league:error',{message,readiness:true});return ack({error:message})}const leagueError=leagueStartError(r);if(leagueError){s.emit('league:error',{message:leagueError});ack({error:leagueError});leagueBroadcast(r);return}leagueSnapshot(r);let connected=r.players.filter(x=>x.socketId);if(connected.length<2){note(r,'게임 시작은 2명 이상 필요합니다.');send(r);return}const total=roomTotalAssets(r),dur=roomDurationMs(r);r.players.forEach(x=>{x.spectator=false;x.stack=roomInitialBuyin(r);x.bank=Math.max(0,total-x.stack);x.autoRebuyHand=null;x.rebuyEligible=false;x.rebuyHandId=null;x.rebuyDeadline=null;x.inHand=false;x.fold=false;x.allin=false;x.bet=0;x.contrib=0;x.cards=[];x.acted=false});{/* V5.60: visual clockwise seats MUST use the same stable order as server betting order. Randomizing only sessionSeatOrder made the turn appear to jump around the table. */let order=r.players.filter(x=>x.socketId&&!x.spectator).map(x=>x.pid);r.sessionSeatOrder=order;}r.sessionRoster=r.players.filter(p=>p.socketId&&!p.spectator).map(p=>({pid:p.pid,name:p.name}));r.players.forEach(p=>{p.finalRank=null;p.eliminatedHandId=null});r.sessionResultId=null;r.restartRequested=false;r.startedAt=roomNow(r);r.endsAt=dur===null?null:r.startedAt+dur;r.finalRanking=null;r.showdown=null;r.showdownReveal=[];r.resultEndsAt=null;r.handSB=SB;r.handBB=BB;r.gameOver=false;r.nextHandAt=null;note(r,`▶️ ${durationLabel(r)} 새 세션 시작 · 전원 총자산 ${total.toLocaleString()} 초기화`);deal(r)});

 // V7.08: authenticated room chat, independent of poker state and presentation.
 s.on('chat:history',(callback)=>{
  const ack=typeof callback==='function'?callback:()=>{},rp=roomPlayerForSocket(s);
  if(!rp||rp.p.socketId!==s.id||rp.p.departed)return ack({error:'방에 입장해주세요.'});
  rp.r.chat=(rp.r.chat||[]).filter(m=>Date.now()-m.at<30*60*1000);
  ack({code:rp.r.code,messages:rp.r.chat});
 });
 s.on('chat:send',(payload,callback)=>{
  const ack=typeof callback==='function'?callback:()=>{},rp=roomPlayerForSocket(s);
  if(!rp||rp.p.socketId!==s.id||rp.p.departed)return ack({error:'방에 입장해주세요.'});
  if(typeof payload?.text!=='string'||payload.text.length>640)return ack({error:'채팅은 160자까지 입력해주세요.'});
  const text=payload.text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim();
  if(!text||[...text].length>160)return ack({error:'채팅은 1~160자로 입력해주세요.'});
  const {r,p}=rp,now=Date.now(),wait=800-(now-(p.chatAt||0));
  if(wait>0)return ack({error:'잠시 후 보내주세요.',retryAfter:wait});
  p.chatAt=now;r.chatSeq=(r.chatSeq||0)+1;
  const message={code:r.code,id:r.chatSeq,pid:p.pid,name:p.name,text,at:now};
  r.chat=[...(r.chat||[]).filter(m=>now-m.at<30*60*1000),message].slice(-50);
  io.to(r.code).emit('chat:message',message);ack({ok:true,message});
 });

 // V6.10: authenticated, room-scoped reactions. Client cannot supply a sender or room.
 s.on('reaction',(payload,callback)=>{
  const ack=typeof callback==='function'?callback:()=>{};
  const rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;
  if(!r||!p||p.socketId!==s.id||p.spectator||p.departed)return ack({error:'착석한 플레이어만 리액션을 보낼 수 있습니다.'});
  const id=payload?.id;
  if(!['angry','yay','cry','laugh','pray','fire','nice','shock','clap','challenge'].includes(id))return ack({error:'잘못된 리액션입니다.'});
  const now=Date.now(),remaining=2600-(now-(p.reactionAt||0));
  if(remaining>0)return ack({error:'잠시 후 다시 보내주세요.',retryAfter:remaining});
  p.reactionAt=now;r.reactionSeq=(r.reactionSeq||0)+1;
  io.to(r.code).emit('reaction',{code:r.code,pid:p.pid,id,seq:r.reactionSeq,at:now});
  ack({ok:true});
 });
 // Presentation acknowledgement never settles chips. finish() has already done that.
 s.on('presentation-complete',(payload,callback)=>{
  const ack=typeof callback==='function'?callback:()=>{};
  const rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;
  if(!r||!p||p.socketId!==s.id||r.street!=='done'||!r.settlementComplete||!r.showdown||payload?.handId!==r.handId||payload?.resultAt!==r.showdown.at)return ack({error:'아직 정산 완료 상태가 아닙니다.'});
  if(r.presentationTimeline&&roomNow(r)<r.presentationTimeline.presentationCompleteAt)return ack({error:'결과 연출 대기 중입니다.'});
  p.presentedHand=r.handId;armAutoRebuy(r,p);ack({ok:true,rebuyDeadline:p.rebuyDeadline||null});send(r);
 });
 // V7.14.4: after a hand is fully settled, a player may voluntarily show their own
 // previously-hidden hole cards. This is presentation-only and cannot affect poker results.
 s.on('show-hand',(payload,callback)=>{
  const ack=typeof callback==='function'?callback:()=>{};
  const rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;
  if(!r||!p||p.socketId!==s.id||p.spectator||p.departed)return ack({error:'착석한 플레이어만 패를 공개할 수 있습니다.'});
  if(r.street!=='done'||!r.settlementComplete||!r.showdown||payload?.handId!==r.handId)return ack({error:'패가 끝난 뒤에만 공개할 수 있습니다.'});
  if(r.presentationTimeline&&roomNow(r)<r.presentationTimeline.resultRevealAt)return ack({error:'결과 공개 후 패를 보여줄 수 있습니다.'});
  if(!p.inHand||!Array.isArray(p.cards)||p.cards.length!==2)return ack({error:'공개할 패가 없습니다.'});
  if((r.showdownReveal||[]).includes(p.pid))return ack({ok:true,already:true});
  r.showdownReveal=[...(r.showdownReveal||[]),p.pid];p.manualRevealHandId=r.handId;touchActivity(p);
  note(r,`🃏 ${p.name} 패 공개`);ack({ok:true});send(r);
 });
 s.on('rebuy',({amount},ack=()=>{})=>{
 const rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;amount=Number(amount);
 if(!r||!p||r.gameOver||!r.startedAt||!p.rebuyEligible||p.spectator||p.stack!==0)return ack({error:'리바이 가능한 상태가 아닙니다.'});
 if(p.rebuyHandId===r.handId&&(r.street!=='done'||!r.settlementComplete||!r.showdown||p.presentedHand!==r.handId))return ack({error:'카드 공개와 결과 연출이 끝난 뒤 리바이할 수 있습니다.'});
 if(!REBUY_AMOUNTS.includes(amount))return ack({error:'리바이는 5만 / 10만 중 선택할 수 있습니다.'});
 if(amount===50000)amount=Math.min(amount,p.bank);
 if(!completeRebuy(r,p,amount))return ack({error:'남은 잔고가 부족합니다.'});
 ack({ok:true});send(r);
 });
 s.on('pre-action',(data={},ack=()=>{})=>{
 const rp=roomPlayerForSocket(s);if(!rp)return ack({error:'방에 입장해주세요.'});const {r,p}=rp;
 if(r.pauseAt)return ack({error:'연습이 일시정지되어 있습니다.'});
 if(data.type===null){p.preAction=null;send(r);return ack({ok:true})}
 if(data.handId!==r.handId||!['fold','allin','max'].includes(data.type)||!['preflop','flop','turn','river'].includes(r.street)||!canAct(r,p)||r.players[r.turn]===p)return ack({error:'현재 예약할 수 없습니다.'});
 if(data.type==='allin'&&availableBet(r,p)<p.stack)return ack({error:'MAX로 예약해주세요.'});
 p.preAction=p.preAction?.type===data.type?null:{type:data.type,handId:r.handId};send(r);ack({ok:true});
 });
 s.on('room:kick',(data={},ack=()=>{})=>{
 const rp=roomPlayerForSocket(s);if(!rp||rp.p.pid!==rp.r.hostPid)return ack({error:'방장만 사용할 수 있습니다.'});
 const target=rp.r.players.find(p=>p.pid===data.pid&&!p.departed&&!p.leaveAfterHand);
 if(!target||target.pid===rp.p.pid)return ack({error:'강제퇴장 대상을 확인해주세요.'});
 removeMember(rp.r,target,'방장에 의해 현재 방에서 퇴장되었습니다.');ack({ok:true});
 });
 s.on('action',(data,ack)=>applyPokerAction(s,data,ack));
 s.on('disconnect',(reason,details)=>{let rp=roomPlayerForSocket(s),r=rp?.r,p=rp?.p;connlog('disconnect',s.id,'reason='+reason,'room='+(r?.code||'-'),'pid='+(p?.pid||'-'),details?.message||'');if(!r||!p)return;/* stale disconnect must never erase a newer resumed socket */if(p.socketId===s.id){p.socketId=null;p.disconnectedAt=Date.now();if(r.practice&&p.pid===r.practiceOwner&&r.startedAt)setPracticePaused(r,true)}if(!r.players.some(x=>x.socketId))r.emptySince=Date.now();emitLobby();note(r,`${p.name} 연결 끊김 · 자동 재접속 대기`);send(r)});
});
setInterval(()=>{for(const r of rooms.values()){try{for(const p of [...r.players])if(!p.departed&&!p.leaveAfterHand&&!p.socketId&&p.disconnectedAt&&Date.now()-p.disconnectedAt>=90000)expirePlayer(r,p,'90초 재접속 유예 종료');expireIdlePlayers(r);if(!rooms.has(r.code))continue;if(r.pauseAt){send(r);continue}if(r.startedAt){tickAutoRebuy(r);if(r.turn>=0&&r.turnDeadline&&roomNow(r)>=r.turnDeadline){let p=r.players[r.turn];if(p&&p.inHand&&!p.fold&&!p.allin){p.fold=true;p.acted=true;markAction(r,p,'timeout');note(r,`⏱️ ${p.name} 시간초과 · 자동 폴드`);advance(r);continue}}if(!r.runout)send(r);finishGameIfNeeded(r)}}catch(e){console.error(new Date().toISOString(),'[FATAL-GUARD] roomTick',r.code,e?.stack||e)}}},1000);
timed.restore();
server.listen(process.env.PORT||3000,()=>console.log('Friends Holdem on '+(process.env.PORT||3000)));
