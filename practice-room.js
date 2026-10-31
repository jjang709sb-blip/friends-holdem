'use strict';
// Trusted adapter explicitly whitelists observations. Policy has no access to r.
function observation(r,p,{available,category,unit}){
 const v={hole:p.cards.slice(),board:r.board.slice(),category,unit,street:r.street,
  stack:p.stack,bet:p.bet,available,toCall:Math.max(0,r.highest-p.bet),highest:r.highest,minRaise:r.minRaise,
  pot:r.players.reduce((a,x)=>a+x.contrib,0),position:r.players.indexOf(p),button:r.button,
  players:r.players.map(x=>({seat:r.players.indexOf(x),stack:x.stack,bet:x.bet,contrib:x.contrib,inHand:x.inHand,fold:x.fold,
   lastAction:x.lastMove?{type:x.lastMove.type,amount:x.lastMove.amount}:null}))};
 const freeze=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(freeze);Object.freeze(o)}return o};return freeze(v);
}
module.exports={observation};
