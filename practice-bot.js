'use strict';
// Advanced bounded-sampling policy v3. No room, network, actual deck, or other
// private cards enter this module. This is a heuristic agent, NOT a GTO solver.
const {performance}=require('node:perf_hooks');
const RANKS='23456789TJQKA',SUITS='SHDC';
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const encode=c=>SUITS.indexOf(c[1])*13+RANKS.indexOf(c[0]);
const rank=c=>c%13+2;
const suit=c=>Math.floor(c/13);
// Identity stays attached to the player when seats rotate.
const PROFILES=Object.freeze([
 {id:'taesan',name:'태산',label:'🛡️ 정석형',description:'참여할 패는 신중하게 고르고, 좋은 패는 적극적으로 베팅합니다.',aggression:.65,tightness:.02,bluff:.025,entry:.61,callBias:0,sizing:1,trap:0,steal:.10},
 {id:'maengho',name:'맹호',label:'🔥 공격형',description:'넓은 범위로 먼저 레이즈하며, 뒷자리에서 압박을 자주 시도합니다.',aggression:.88,tightness:-.015,bluff:.15,entry:.51,callBias:.025,sizing:1.15,trap:0,steal:.18},
 {id:'yeou',name:'여우',label:'🦊 블러프형',description:'유리한 자리에서 블러프를 섞고, 강한 패를 체크로 숨기기도 합니다.',aggression:.66,tightness:0,bluff:.25,entry:.53,callBias:.015,sizing:.95,trap:.22,steal:.16},
 {id:'baksa',name:'박사',label:'🧠 계산형',description:'콜 비용과 추정 승률을 중시합니다. 비싼 추격은 줄이고 유리한 가격을 고릅니다.',aggression:.53,tightness:0,bluff:.045,entry:.58,callBias:0,sizing:.9,trap:0,steal:.11},
 {id:'bulgom',name:'불곰',label:'📞 콜 잘함',description:'작은 베팅에는 넓게 따라옵니다. 먼저 레이즈하거나 블러프하는 빈도는 낮습니다.',aggression:.22,tightness:-.02,bluff:.01,entry:.42,callBias:.09,sizing:.8,trap:0,steal:.07},
 {id:'beongae',name:'번개',label:'⚡ 막치는형',description:'넓은 패로 참여하고 큰 베팅을 즐깁니다. 무리한 승부도 있어 변동이 큽니다.',aggression:.82,tightness:-.04,bluff:.22,entry:.40,callBias:.08,sizing:1.4,trap:0,steal:.16},
 {id:'bawi',name:'바위',label:'🪨 신중형',description:'참여 범위가 좁고 큰 압박에는 잘 접습니다. 크게 베팅하면 강한 패를 경계하세요.',aggression:.32,tightness:.055,bluff:.005,entry:.67,callBias:0,sizing:.85,trap:0,steal:.06},
 {id:'neung',name:'능구렁',label:'🎯 기회형',description:'앞자리에서는 신중하고, 뒤에서 약한 반응이 보이면 넓게 공격합니다.',aggression:.70,tightness:.005,bluff:.16,entry:.65,callBias:.02,sizing:1,trap:.08,steal:.26}
].map(Object.freeze));
function getProfile(id){return PROFILES.find(p=>p.id===id)||PROFILES[3]}
function publicProfile(id){const p=getProfile(id);return {id:p.id,label:p.label,description:p.description}}
function straight(mask){
 for(let top=14;top>=6;top--)if((mask & (31<<(top-4)))===(31<<(top-4)))return top;
 return (mask & ((1<<14)|(1<<5)|(1<<4)|(1<<3)|(1<<2)))===((1<<14)|(1<<5)|(1<<4)|(1<<3)|(1<<2))?5:0;
}
function pack(category,values){let n=category;for(let i=0;i<5;i++)n=n*15+(values[i]||0);return n}
// Direct best-five evaluator for 5..7 cards, including kickers and board play.
function evaluate(cards){
 const counts=new Uint8Array(15),masks=[0,0,0,0],sc=[0,0,0,0];let mask=0;
 for(const c of cards){const r=rank(c),s=suit(c);counts[r]++;mask|=1<<r;masks[s]|=1<<r;sc[s]++}
 const fs=sc.findIndex(n=>n>=5),st=straight(mask),sf=fs<0?0:straight(masks[fs]);
 if(sf)return pack(8,[sf]);
 const groups=[[],[],[],[],[]];for(let r=14;r>=2;r--)if(counts[r])groups[counts[r]].push(r);
 const high=(exclude=[],m=mask)=>{const a=[];for(let r=14;r>=2;r--)if((m&(1<<r))&&!exclude.includes(r))a.push(r);return a};
 if(groups[4].length)return pack(7,[groups[4][0],...high(groups[4]).slice(0,1)]);
 const t=groups[3][0],pair=[...groups[3].slice(1),...groups[2]].sort((a,b)=>b-a)[0];
 if(t&&pair)return pack(6,[t,pair]);
 if(fs>=0)return pack(5,high([],masks[fs]));
 if(st)return pack(4,[st]);
 if(t)return pack(3,[t,...high([t]).slice(0,2)]);
 if(groups[2].length>=2){const ps=groups[2].slice(0,2);return pack(2,[...ps,...high(ps).slice(0,1)])}
 if(groups[2].length)return pack(1,[groups[2][0],...high(groups[2]).slice(0,3)]);
 return pack(0,high());
}
function preflop(cards){
 const [a,b]=cards.map(rank).sort((a,b)=>b-a),gap=a-b;
 if(a===b)return clamp(.45+(a-2)*.045);
 return clamp(.08+(a+b-4)*.03+(suit(cards[0])===suit(cards[1])?.07:0)+(gap<=2?.05:0)-Math.max(0,gap-3)*.012+(a===14?.035:0));
}
function strength(v){
 if(!v.board.length)return preflop(v.hole.map(encode));
 const cards=[...v.hole,...v.board].map(encode),cat=Math.floor(evaluate(cards)/15**5);
 const base=[.12,.4,.6,.73,.82,.88,.94,.98,1][cat];
 const suits=[0,0,0,0];let mask=0;for(const c of cards){suits[suit(c)]++;mask|=1<<rank(c)}
 let draw=0;if(v.board.length<5){if(suits.includes(4))draw+=.12;for(let top=5;top<=14;top++){let n=0;for(let k=0;k<5;k++)if(mask&(1<<(top-k===1?14:top-k)))n++;if(n===4){draw+=.09;break}}}
 return clamp(base+draw);
}
function position(v){
 const seats=v.players.filter(p=>p.inHand).map(p=>p.seat),n=v.players.length;
 const ordered=seats.sort((a,b)=>((a-v.button-1+n)%n)-((b-v.button-1+n)%n));
 const at=ordered.indexOf(v.position);return ordered.length>1?at/(ordered.length-1):.5;
}
// Public tendency is evidence of pressure, never proof that a bet is a bluff.
function pressureRead(op){
 const t=op.riverPressure;
 return t&&t.opportunities>=4?clamp((t.rate-.55)*t.confidence,0,.30):0;
}
function rangeWeight(pair,op,board){
 const pf=preflop(pair),aggressive=['raise','allin','max'].includes(op.lastAction?.type);
 const raises=op.raises||0;
 let weight=1;
 if(op.preflopRaises>0)weight=.03+Math.pow(pf,3+Math.min(2,op.preflopRaises));
 else if(op.preflopCalled)weight=.15+pf;
 if(!board.length){
  if(aggressive)weight*=.035+Math.pow(pf,3+Math.min(2,raises));
  else if(op.lastAction?.type==='call')weight*=.15+pf;
 }else if(aggressive){
  const all=[...pair,...board],cat=Math.floor(evaluate(all)/15**5);
  const sc=[0,0,0,0];for(const c of all)sc[suit(c)]++;
  const draw=board.length<5&&sc.includes(4);
  // Retain bluff combinations; never infer a single certain opponent hand.
  const read=board.length===5&&op.lastAction?.checkedToBet?pressureRead(op):0;
  weight*=cat>=2?1:cat===1?.45+read*.3:draw?.35:.07+read*.65;
 }
 return Math.max(.005,weight);
}
function samplePair(deck,op,board,rng){
 // Bounded candidate weighting: approximates a range, not an exact posterior.
 const candidates=[];let total=0;
 for(let i=0;i<8;i++){
  const a=Math.floor(rng()*deck.length),j=Math.floor(rng()*(deck.length-1)),b=j>=a?j+1:j;
  const w=rangeWeight([deck[a],deck[b]],op,board);total+=w;candidates.push({a,b,w});
 }
 let target=rng()*total,chosen=candidates.at(-1);
 for(const c of candidates){target-=c.w;if(target<=0){chosen=c;break}}
 const hi=Math.max(chosen.a,chosen.b),lo=Math.min(chosen.a,chosen.b);
 const a=deck[hi],b=deck[lo];deck.splice(hi,1);deck.splice(lo,1);return [a,b];
}
function estimate(v,random=Math.random,options={}){
 const rng=()=>clamp(Number(random())||0,0,.999999999),hole=v.hole.map(encode),board=v.board.map(encode);
 const known=new Set([...hole,...board]);
 if(hole.length!==2||known.size!==hole.length+board.length||[...known].some(c=>c<0||c>51))throw Error('Invalid public observation');
 const opponents=v.players.filter(p=>p.seat!==v.position&&p.inHand&&!p.fold);
 const deckBase=Array.from({length:52},(_,i)=>i).filter(c=>!known.has(c));
 const call=Math.min(v.toCall,v.available),heroTotal=(v.players.find(p=>p.seat===v.position)?.contrib||0)+call;
 // Only count pots hero can win. Folded contributions remain in their layers.
 const contributions=v.players.map(p=>({seat:p.seat,total:p.seat===v.position?heroTotal:Math.min(heroTotal,p.contrib||0),live:p.inHand&&!p.fold}));
 const levels=[...new Set(contributions.map(p=>p.total).filter(n=>n>0))].sort((a,b)=>a-b);
 let last=0;const pots=levels.map(level=>{const members=contributions.filter(p=>p.total>=level),amount=(level-last)*members.length;last=level;return {amount,seats:members.filter(p=>p.live).map(p=>p.seat)}}).filter(p=>p.seats.includes(v.position));
 const eligible= pots.reduce((a,p)=>a+p.amount,0);
 const budget=clamp(options.budgetMs??12,1,25),limit=clamp(options.samples??180,16,400),deadline=performance.now()+budget;
 let samples=0,payout=0,share=0;
 while(samples<limit){
  // Also check within each iteration; ordinary 9-player decision is bounded.
  if(samples>=16&&performance.now()>=deadline)break;
  const deck=deckBase.slice(),pairs=opponents.map(op=>samplePair(deck,op,board,rng));
  const run=board.slice();while(run.length<5){const i=Math.floor(rng()*deck.length);run.push(deck[i]);deck[i]=deck.at(-1);deck.pop()}
  const scores=new Map([[v.position,evaluate([...hole,...run])]]);
  opponents.forEach((op,i)=>scores.set(op.seat,evaluate([...pairs[i],...run])));
  const hero=scores.get(v.position),best=Math.max(...scores.values()),ties=[...scores.values()].filter(x=>x===best).length;
  share+=hero===best?1/ties:0;
  for(const pot of pots){const values=pot.seats.map(seat=>scores.get(seat)).filter(x=>x!==undefined),top=Math.max(...values);if(hero===top)payout+=pot.amount/values.filter(x=>x===top).length}
  samples++;
 }
 return {equity:share/samples,potEquity:eligible?payout/samples/eligible:share/samples,expectedReturn:payout/samples,eligiblePot:eligible,call,samples};
}
function choose(v,random=Math.random,custom={}){
 const rng=()=>clamp(Number(random())||0,0,.999999999);
 const profile={...getProfile(v.botProfile),...custom};
 const free=v.toCall===0,pass={type:free?'check':'call'},fold={type:free?'check':'fold'};
 if(v.hole.length!==2)return fold;
 const opponents=v.players.filter(p=>p.inHand&&!p.fold&&p.seat!==v.position);
 if(!opponents.length)return pass;
 const pos=position(v),pf=preflop(v.hole.map(encode)),bb=v.bigBlind||Math.max(v.unit,v.minRaise);
 const unopened=!v.board.length&&v.highest<=bb;
 // Position-sensitive opening discipline; avoid cheap multiway trash calls.
 if(unopened){
  const entry=profile.entry-pos*profile.steal;
  if(pf<entry)return fold;
  // Unacted players are not eight guaranteed showdown callers.
  const max=v.bet+v.available,min=v.highest+v.minRaise;
  if(max>v.highest&&rng()<profile.aggression){
   const target=Math.min(max,Math.max(min,Math.round(bb*(2.3*profile.sizing+.6*opponents.filter(p=>p.lastAction?.type==='call').length)/v.unit)*v.unit));
   return {type:target===max?(v.available===v.stack?'allin':'max'):'raise',amount:target};
  }
  return pass;
 }
 const e=estimate(v,rng),allCommitted=opponents.every(p=>p.allin||p.capped||p.stack===0);
 const price=e.call/Math.max(1,e.eligiblePot);
 const realization=v.board.length===5||e.call>=v.stack||allCommitted?1:clamp(.83+pos*.11-(opponents.length-1)*.015,.72,.96);
 const pressure=e.call/Math.max(1,v.stack);
 const adjusted=e.potEquity*realization+profile.callBias*Math.max(0,1-pressure*1.8);
 const margin=(v.board.length===5?.012:.025)+profile.tightness;
 const marginal=adjusted>=price+margin-.055;
 const bluffAttempt=opponents.length<=2&&pos>.45&&marginal&&pressure<.18&&rng()<profile.bluff;
 if(!free&&adjusted<price+margin&&!bluffAttempt)return fold;
 const max=v.bet+v.available,min=v.highest+v.minRaise;
 // No meaningless raise into a pot where nobody can contribute more.
 const callable=opponents.filter(p=>!p.allin&&!p.capped&&p.stack>Math.max(0,v.highest-p.bet));
 if(!callable.length||max<=v.highest)return pass;
 const edge=e.equity-1/(opponents.length+1);
 const value=v.board.length?e.equity>(opponents.length===1?.64:.48)&&edge>.20:pf>.77||(unopened&&pf>.57&&pos>.65);
 const semi=v.board.length>0&&v.board.length<5&&e.equity>.30&&e.equity<.58;
 const bluff=bluffAttempt||opponents.length<=2&&pos>.45&&!allCommitted&&rng()<profile.bluff*(semi?1.6:.5)&&v.toCall<Math.max(bb,v.pot*.35);
 const hero=v.players.find(p=>p.seat===v.position);
 // A river trap needs actual private-card value and someone still to act behind.
 // Keep all strong checks available for a later value call/raise, not a forced loss.
 if(free&&value&&e.equity>.78&&v.board.length===5){
  const n=v.players.length,order=seat=>(seat-v.button-1+n)%n;
  const behind=callable.filter(p=>!p.acted&&order(p.seat)>order(v.position));
  const contributes=evaluate([...v.hole,...v.board].map(encode))>evaluate(v.board.map(encode));
  const base={taesan:.16,maengho:.18,yeou:.30,baksa:.20,bulgom:.12,beongae:.14,bawi:.10,neung:.28}[profile.id]??.18;
  const read=behind.length?Math.max(...behind.map(pressureRead)):0;
  const chance=clamp((base+read*.45)/(1+(opponents.length-1)*.25),0,.42);
  if(behind.length&&contributes&&rng()<chance)return pass;
 }
 const checkRaise=!free&&v.board.length===5&&hero?.lastAction?.type==='check'&&value&&e.equity>.78;
 if(!(value||bluff)||rng()>profile.aggression+(value?.25:0)+(checkRaise?.15:0))return pass;
 if(free&&value&&e.equity>.8&&v.board.length<5&&rng()<profile.trap)return pass;
 let target;
 if(!v.board.length){
  target=unopened?Math.round((2.3+opponents.filter(p=>p.lastAction?.type==='call').length*.7)*bb):Math.max(min,v.highest*(pos>.65?3:3.6));
 }else{
  const fraction=bluff?.55:e.equity>.82?.85:e.equity>.66?.65:.42;
  target=v.highest+(v.pot+e.call)*fraction*profile.sizing;
 }
 // Avoid putting chips beyond every opponent's effective stack; MAX stays distinct.
 const effective=Math.max(...callable.map(p=>p.bet+p.stack));
 const ceiling=Math.min(max,Math.max(v.highest,effective));
 if(ceiling<min&&ceiling!==max)return pass;
 target=Math.min(ceiling,Math.max(min,Math.round(target/v.unit)*v.unit));
 target=Math.floor(target/v.unit)*v.unit;
 if(target<=v.highest||(target<min&&target!==max))return pass;
 if(max-target<=Math.max(bb,v.stack*.12)&&e.equity>.74&&max<=effective)target=max;
 return {type:target===max?(v.available===v.stack?'allin':'max'):'raise',amount:target};
}
module.exports={choose,strength,estimate,evaluate,encode,PROFILES,getProfile,publicProfile,version:'3.0.0'};
