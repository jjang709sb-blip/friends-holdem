'use strict';
const crypto=require('crypto');
const R='A23456789TJQK',S='SHDC',LIMIT=6,TURN=45000,GRACE=90000;
const rank=c=>R.indexOf(c[0])+1;
function meldKind(cards){
 if(!Array.isArray(cards)||!cards.length||new Set(cards).size!==cards.length||cards.some(c=>typeof c!=='string'||c.length!==2||!R.includes(c[0])||!S.includes(c[1])))return null;
 if(cards.every(c=>rank(c)===rank(cards[0]))&&cards.length<=4&&(cards.length>=3||rank(cards[0])===7))return 'set';
 const a=cards.map(rank).sort((a,b)=>a-b);
 if(cards.length>=3&&cards.every(c=>c[1]===cards[0][1])&&a.every((x,i)=>!i||x===a[i-1]+1))return 'run';
 return null;
}
function shuffled(){const a=[...S].flatMap(s=>[...R].map(r=>r+s));for(let i=a.length-1;i>0;i--){const j=crypto.randomInt(i+1);[a[i],a[j]]=[a[j],a[i]]}return a}
const points=cards=>cards.reduce((n,c)=>n+Math.min(10,rank(c)),0);
function attach(io){
 const ns=io.of('/hula'),rooms=new Map();
 const list=()=>[...rooms.values()].filter(r=>r.players.some(p=>p.sid)).map(r=>({code:r.code,name:r.name,game:'hula',count:r.players.length,status:r.phase==='playing'?'게임중':'대기중'}));
 const lobby=()=>ns.emit('rooms:list',list());
 function note(r,message){r.log.push(message);if(r.log.length>30)r.log.shift()}
 function state(r,p){return {game:'hula',code:r.code,name:r.name,you:p.id,host:r.host,revision:r.revision,round:r.round,phase:r.phase,turn:r.players[r.turn]?.id||null,step:r.step,deadline:r.deadline,serverNow:Date.now(),stock:r.deck.length,discard:r.discard.at(-1)||null,discardCount:r.discard.length,melds:r.melds.map(m=>({...m,cards:m.cards.slice()})),hand:p.hand.slice(),players:r.players.map(x=>({id:x.id,name:x.name,count:x.hand.length,registered:x.registered,connected:!!x.sid,score:x.score})),result:r.result,log:r.log.slice()}}
 function send(r){r.revision++;for(const p of r.players)if(p.sid)ns.to(p.sid).emit('state',state(r,p))}
 function current(s){const r=rooms.get(s.data.hulaCode),p=r?.players.find(x=>x.id===s.data.hulaPid&&x.sid===s.id);return p?{r,p}:null}
 function bind(s,r,p){if(p.sid&&p.sid!==s.id){const previous=ns.sockets.get(p.sid);if(previous){previous.data.hulaCode=null;previous.emit('replaced');previous.disconnect()}}p.sid=s.id;p.offlineAt=null;s.data.hulaCode=r.code;s.data.hulaPid=p.id;}
 function end(r,winner,reason){r.phase='done';r.deadline=null;r.step='done';const rows=r.players.map(p=>({id:p.id,name:p.name,penalty:p.id===winner?0:points(p.hand),cards:p.hand.slice()}));for(const p of r.players)p.score+=rows.find(x=>x.id===p.id).penalty;r.result={winner,reason,rows};note(r,reason);send(r);lobby()}
 function start(r){if(r.phase==='playing')throw Error('이미 게임 중입니다.');if(r.players.length<2||r.players.some(p=>!p.sid))throw Error('접속한 2~6명이 필요합니다.');r.deck=shuffled();r.discard=[];r.melds=[];r.result=null;r.round++;for(const p of r.players){p.hand=r.deck.splice(0,7);p.registered=false}r.discard.push(r.deck.pop());r.turn=(r.round-1)%r.players.length;r.step='draw';r.phase='playing';r.deadline=Date.now()+TURN;note(r,'라운드 '+r.round+' 시작');}
 function draw(r,p){if(!r.deck.length&&r.discard.length>1){const top=r.discard.pop();r.deck=r.discard;r.discard=[top];for(let i=r.deck.length-1;i>0;i--){const j=crypto.randomInt(i+1);[r.deck[i],r.deck[j]]=[r.deck[j],r.deck[i]]}}if(!r.deck.length){end(r,null,'뽑을 카드가 없어 종료 · 각자 남은 패 점수 누적');return false}p.hand.push(r.deck.pop());r.step='play';return true}
 function selected(p,cards){if(!Array.isArray(cards)||cards.length<1||cards.length>13||new Set(cards).size!==cards.length||cards.some(c=>!p.hand.includes(c)))throw Error('내 패에서 카드를 선택해주세요.');return cards.slice()}
 function remove(p,cards){p.hand=p.hand.filter(c=>!cards.includes(c))}
 function move(r,p,d){
  if(r.phase!=='playing'||r.players[r.turn]!==p)throw Error('내 차례가 아닙니다.');
  if(d.type==='draw'){if(r.step!=='draw')throw Error('이미 카드를 가져왔습니다.');draw(r,p);note(r,p.name+' 카드 뽑기');return}
  if(d.type==='take'){
   if(r.step!=='draw'||!r.discard.length)throw Error('지금 버린 카드를 가져올 수 없습니다.');
   const cards=Array.isArray(d.cards)&&d.cards.length===0?[]:selected(p,d.cards),all=[...cards,r.discard.at(-1)],kind=meldKind(all);if(!kind)throw Error('버린 카드와 선택한 패로 등록 가능한 묶음을 만들어주세요.');
   r.discard.pop();remove(p,cards);p.registered=true;r.melds.push({id:crypto.randomBytes(6).toString('hex'),owner:p.id,kind,cards:all});r.step='play';note(r,p.name+' 버린 카드로 등록');
  }else{
   if(r.step!=='play')throw Error('먼저 카드를 뽑거나 버린 카드로 등록하세요.');
   const cards=selected(p,d.cards);
   if(d.type==='meld'){const kind=meldKind(cards);if(!kind)throw Error('같은 숫자 3장, 같은 무늬 연속 3장 또는 7을 등록하세요.');remove(p,cards);p.registered=true;r.melds.push({id:crypto.randomBytes(6).toString('hex'),owner:p.id,kind,cards});note(r,p.name+' 등록');}
   else if(d.type==='attach'){if(!p.registered)throw Error('내 패를 먼저 등록해야 붙일 수 있습니다.');const m=r.melds.find(x=>x.id===d.meldId);if(!m||meldKind([...m.cards,...cards])!==m.kind)throw Error('이 묶음에 붙일 수 없는 카드입니다.');remove(p,cards);m.cards.push(...cards);note(r,p.name+' 붙이기');}
   else if(d.type==='discard'){if(cards.length!==1)throw Error('버릴 카드 1장만 선택하세요.');remove(p,cards);r.discard.push(cards[0]);note(r,p.name+' '+cards[0]+' 버림');if(p.hand.length){r.turn=(r.turn+1)%r.players.length;r.step='draw';r.deadline=Date.now()+TURN;}}
   else throw Error('알 수 없는 행동입니다.');
  }
  if(!p.hand.length)end(r,p.id,p.name+' 훌라!');
 }
 function leave(r,p){if(r.phase==='playing'){r.phase='waiting';r.deadline=null;r.result=null;r.melds=[];r.deck=[];r.discard=[];for(const x of r.players){x.hand=[];x.registered=false}note(r,p.name+' 퇴장 · 라운드 중단, 점수 변동 없음');}r.players=r.players.filter(x=>x!==p);if(!r.players.length){rooms.delete(r.code);lobby();return}if(r.host===p.id)r.host=(r.players.find(x=>x.sid)||r.players[0]).id;send(r);lobby()}
 ns.on('connection',s=>{
  s.emit('rooms:list',list());let last=0;
  function handle(event,fn){s.on(event,(data,ack)=>{if(typeof data==='function'){ack=data;data={}}ack=typeof ack==='function'?ack:()=>{};try{if(Date.now()-last<40)throw Error('잠시 후 다시 눌러주세요.');last=Date.now();const result=fn(data&&typeof data==='object'?data:{});ack(result||{ok:true})}catch(e){ack({error:e.message})}})}
  handle('rooms:list',()=>{s.emit('rooms:list',list());return {ok:true}});
  handle('create',d=>{if(current(s))throw Error('이미 훌라방에 있습니다.');if(typeof d.name!=='string'||!d.name.trim())throw Error('닉네임을 입력해주세요.');const name=d.name.trim().slice(0,14);let code;do{code='H'+crypto.randomBytes(3).toString('hex').toUpperCase()}while(rooms.has(code));const p={id:crypto.randomBytes(8).toString('hex'),token:crypto.randomBytes(24).toString('hex'),name,hand:[],score:0,registered:false};const r={code,name:name+'의 훌라방',players:[p],host:p.id,phase:'waiting',step:'draw',round:0,turn:0,revision:0,deck:[],discard:[],melds:[],result:null,log:[],lastActivity:Date.now(),deadline:null};rooms.set(code,r);bind(s,r,p);send(r);lobby();return {ok:true,code,token:p.token,pid:p.id}});
  handle('join',d=>{const r=rooms.get(String(d.code||'').toUpperCase());if(!r)throw Error('방이 종료되었거나 존재하지 않습니다.');const occupied=current(s);if(occupied&&occupied.r!==r)throw Error('먼저 현재 방에서 나가주세요.');let p=r.players.find(x=>typeof d.token==='string'&&x.token===d.token);if(occupied&&p!==occupied.p)throw Error('이미 착석 중입니다.');if(!p){if(r.phase==='playing')throw Error('게임 중에는 새로 입장할 수 없습니다.');if(r.players.length>=LIMIT)throw Error('6명이 모두 찼습니다.');if(typeof d.name!=='string'||!d.name.trim())throw Error('닉네임을 입력해주세요.');const name=d.name.trim().slice(0,14);if(r.players.some(x=>x.name===name))throw Error('이미 사용 중인 닉네임입니다.');p={id:crypto.randomBytes(8).toString('hex'),token:crypto.randomBytes(24).toString('hex'),name,hand:[],registered:false,score:0};r.players.push(p)}bind(s,r,p);r.lastActivity=Date.now();send(r);lobby();return {ok:true,code:r.code,token:p.token,pid:p.id}});
  handle('start',()=>{const c=current(s);if(!c||c.r.host!==c.p.id)throw Error('방장만 시작할 수 있습니다.');start(c.r);c.r.lastActivity=Date.now();send(c.r);lobby()});
  handle('action',d=>{const c=current(s);if(!c)throw Error('방에 입장해주세요.');if(d.revision!==c.r.revision)throw Error('상태가 바뀌었습니다. 다시 선택해주세요.');move(c.r,c.p,d);c.r.lastActivity=Date.now();send(c.r)});
  handle('chat',d=>{const c=current(s);if(!c)throw Error('방에 입장해주세요.');const text=typeof d.text==='string'?d.text.trim().slice(0,160):'';if(!text)return;note(c.r,c.p.name+': '+text);c.r.lastActivity=Date.now();send(c.r)});
  handle('leave',()=>{const c=current(s);if(c){s.data.hulaCode=null;s.data.hulaPid=null;leave(c.r,c.p)}});
  s.on('disconnect',()=>{const c=current(s);if(c){c.p.sid=null;c.p.offlineAt=Date.now();send(c.r);lobby()}});
 });
 const timer=setInterval(()=>{const now=Date.now();for(const r of rooms.values()){
  if(now-r.lastActivity>30*60*1000){for(const p of r.players)if(p.sid)ns.to(p.sid).emit('closed','30분 동안 조작이 없어 방이 종료되었습니다.');rooms.delete(r.code);lobby();continue}
  for(const p of [...r.players])if(!p.sid&&p.offlineAt&&now-p.offlineAt>=GRACE)leave(r,p);
  if(!rooms.has(r.code)||r.phase!=='playing'||now<r.deadline)continue;
  const p=r.players[r.turn];try{if(r.step==='draw'&&!draw(r,p))continue;move(r,p,{type:'discard',cards:[p.hand.at(-1)]});note(r,p.name+' 시간초과 · 자동 뽑기/버리기');send(r)}catch(e){r.phase='waiting';r.deadline=null;note(r,'턴 처리 중단 · 새 라운드를 시작해주세요.');send(r)}
 }},1000);timer.unref();
 return {rooms,move,start,state,close:()=>clearInterval(timer)};
}
module.exports=attach;module.exports.meldKind=meldKind;module.exports.points=points;
