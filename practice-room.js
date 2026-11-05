'use strict';
// Room-local bounded public-action memory. Never reads opponents' cards,
// deck, runout or showdown. Weak ownership releases memory with the room.
const memories=new WeakMap();
function memoryFor(r){
 let m=memories.get(r);if(!m){m={stats:new Map()};memories.set(r,m)}
 const present=new Set(r.players.map(p=>p.pid));for(const id of m.stats.keys())if(!present.has(id))m.stats.delete(id);
 if(m.hand!==r.handId){m.hand=r.handId;m.actions=new Map();m.checked=new Set();m.riverBet=false;m.counted=new Set();m.seq=null}
 return m;
}
function recordAction(r,p,type,kind=type){
 if(!r.practice)return;
 const m=memoryFor(r);if(m.seq===r.actionSeq)return;m.seq=r.actionSeq;
 let a=m.actions.get(p.pid);if(!a){a={raises:0,preflopRaises:0,preflopCalled:false,lastAction:null};m.actions.set(p.pid,a)}
 // 'kind' distinguishes an all-in CALL from a bet/raise while the public UI
 // may still display both as all-in. Unknown all-in events stay conservative.
 const aggressive=kind==='raise';
 const lastToAct=!r.players.some(x=>x!==p&&x.inHand&&!x.fold&&!x.allin&&!x.capped&&x.stack>0&&!m.checked.has(x.pid));
 const opportunity=r.street==='river'&&!m.riverBet&&m.checked.size>0&&lastToAct&&!m.counted.has(p.pid);
 if(opportunity){
  m.counted.add(p.pid);let t=m.stats.get(p.pid)||{opportunities:0,bets:0};
  t={opportunities:t.opportunities*.97+1,bets:t.bets*.97+(aggressive?1:0)};m.stats.set(p.pid,t);
 }
 const checkedToBet=aggressive&&opportunity;
 if(aggressive){a.raises=Math.min(8,a.raises+1);if(r.street==='preflop')a.preflopRaises=Math.min(4,a.preflopRaises+1)}
 if(r.street==='preflop'&&kind==='call')a.preflopCalled=true;
 a.lastAction={type:kind,amount:p.bet||0,street:r.street,checkedToBet};
 if(r.street==='river'){if(kind==='check')m.checked.add(p.pid);if(aggressive)m.riverBet=true}
}
function observation(r,p,{available,category,unit}){
 const memory=memoryFor(r);
 const players=r.players.map((x,seat)=>{
  const a=memory.actions.get(x.pid)||{raises:0,preflopRaises:0,preflopCalled:false,lastAction:null};
  const t=memory.stats.get(x.pid)||{opportunities:0,bets:0};
  return {seat,stack:x.stack,bet:x.bet,contrib:x.contrib,inHand:x.inHand,fold:x.fold,acted:!!x.acted,
   allin:!!x.allin,capped:!!x.capped,raises:a.raises,preflopRaises:a.preflopRaises,preflopCalled:a.preflopCalled,
   lastAction:a.lastAction?.street===r.street?{...a.lastAction}:null,
   riverPressure:{opportunities:t.opportunities,rate:(t.bets+2)/(t.opportunities+4),confidence:t.opportunities/(t.opportunities+12)}};
 });
 const v={botProfile:p.botProfile||'baksa',hole:p.cards.slice(),board:r.board.slice(),category,unit,street:r.street,
  stack:p.stack,bet:p.bet,available,toCall:Math.max(0,r.highest-p.bet),highest:r.highest,minRaise:r.minRaise,
  bigBlind:r.handBB||unit*2,pot:players.reduce((a,x)=>a+(x.contrib||0),0),position:r.players.indexOf(p),button:r.button,players};
 const freeze=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(freeze);Object.freeze(o)}return o};return freeze(v);
}
module.exports={observation,recordAction};
