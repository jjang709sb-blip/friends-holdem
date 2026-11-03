'use strict';
// Weakly owned by room: bounded to nine seats, reset per hand, never persists
// private cards. No opponent cards/deck/runout/showdown are read here.
const memories=new WeakMap();
function observation(r,p,{available,category,unit}){
 let memory=memories.get(r);
 if(!memory||memory.hand!==r.handId){memory={hand:r.handId,seats:new Map()};memories.set(r,memory)}
 const players=r.players.map((x,seat)=>{
  let m=memory.seats.get(seat);if(!m){m={key:null,raises:0,preflopRaises:0,preflopCalled:false};memory.seats.set(seat,m)}
  const action=x.lastMove;
  if(action){const key=[r.street,action.at,action.type,action.amount].join(':');
   if(key!==m.key){m.key=key;if(['raise','allin','max'].includes(action.type)){m.raises=Math.min(8,m.raises+1);if(r.street==='preflop')m.preflopRaises=Math.min(4,m.preflopRaises+1)}
    if(r.street==='preflop'&&action.type==='call')m.preflopCalled=true;
   }
  }
  return {seat,stack:x.stack,bet:x.bet,contrib:x.contrib,inHand:x.inHand,fold:x.fold,
   allin:!!x.allin,capped:!!x.capped,raises:m.raises,preflopRaises:m.preflopRaises,preflopCalled:m.preflopCalled,
   lastAction:action?{type:action.type,amount:action.amount}:null};
 });
 const v={botProfile:p.botProfile||'baksa',hole:p.cards.slice(),board:r.board.slice(),category,unit,street:r.street,
  stack:p.stack,bet:p.bet,available,toCall:Math.max(0,r.highest-p.bet),highest:r.highest,minRaise:r.minRaise,
  bigBlind:r.handBB||unit*2,pot:players.reduce((a,x)=>a+(x.contrib||0),0),position:r.players.indexOf(p),button:r.button,players};
 const freeze=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(freeze);Object.freeze(o)}return o};return freeze(v);
}
module.exports={observation};
