'use strict';
// Pure policy. This module receives a copied observation, never a room, deck,
// socket, other hole cards, or a callback that can inspect the game state.
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
function strength(v){
 const values=v.hole.map(c=>'23456789TJQKA'.indexOf(c[0])+2).sort((a,b)=>b-a);
 if(!v.board.length){const [a,b]=values;return clamp(.12+(a+b)/50+(a===b?.28:0)+(v.hole[0][1]===v.hole[1][1]?.06:0)+(a-b<=2?.05:0)-(a-b>5?.08:0))}
 const made=[.16,.43,.64,.76,.84,.89,.94,.98,1][v.category]||.16;
 const cards=[...v.hole,...v.board],suits={};for(const c of cards)suits[c[1]]=(suits[c[1]]||0)+1;
 const vals=new Set(cards.map(c=>'23456789TJQKA'.indexOf(c[0])+2));if(vals.has(14))vals.add(1);
 let run=0;for(let low=1;low<=10;low++){let n=0;for(let j=0;j<5;j++)if(vals.has(low+j))n++;run=Math.max(run,n)}
 const draw=v.board.length<5?((Math.max(...Object.values(suits))===4?.12:0)+(run===4?.09:0)):0;
 const boardHigh=Math.max(...v.board.map(c=>'23456789TJQKA'.indexOf(c[0])+2));
 return clamp(made+draw+(values[0]>boardHigh?.04:0));
}
function choose(v,random=Math.random,profile={mistakes:.06,aggression:.26}){
 const call=Math.min(v.toCall,v.available),free=v.toCall===0;
 const edge=strength(v)+(random()-.5)*.16+(random()<profile.mistakes?(random()-.5)*.45:0);
 const odds=call/Math.max(1,v.pot+call),pressure=call/Math.max(1,v.stack);
 const active=v.players.filter(p=>p.inHand&&!p.fold).length;
 const threshold=.19+odds*.6+pressure*.16+Math.max(0,active-2)*.018;
 if(!free&&edge<threshold&&random()>.08)return {type:'fold'};
 const max=v.bet+v.available,min=v.highest+v.minRaise;
 if(max>v.highest&&(edge>.58||random()<.035)&&random()<profile.aggression+edge*.2){
  const fraction=[.4,.6,.8,1][Math.floor(random()*4)],desired=v.highest+Math.max(v.minRaise,Math.round(v.pot*fraction/v.unit)*v.unit);
  const amount=Math.min(max,Math.max(min,desired));
  return {type:amount===max?(v.available===v.stack?'allin':'max'):'raise',amount};
 }
 return {type:free?'check':'call'};
}
module.exports={choose,strength};
