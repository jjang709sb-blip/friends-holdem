'use strict';
const hulaLobbySocket=io('/hula');
hulaLobbySocket.on('rooms:list',rooms=>{window.hulaLobbyRooms=rooms;renderRooms(window.holdemLobbyRooms||[])});
let hulaPending=false;
function enterHulaResponse(r){hulaPending=false;if(r.error){$('msg').textContent=r.error;return}localStorage.setItem('hula_'+r.code,r.token);location.href='/hula.html?room='+encodeURIComponent(r.code)}
function createHulaRoom(){const name=validName();if(!name||hulaPending)return;if(name!=='개발자훌라방'){$('msg').textContent='훌라방은 비공개 테스트 중입니다.';return}if(!hulaLobbySocket.connected){$('msg').textContent='서버 연결을 기다려주세요.';return}hulaPending=true;hulaLobbySocket.timeout(5000).emit('create',{name},(err,r)=>{if(err){hulaPending=false;$('msg').textContent='응답이 없습니다. 다시 시도해주세요.'}else enterHulaResponse(r)})}
function joinHulaRoom(code){const name=validName();if(!name||hulaPending)return;hulaPending=true;hulaLobbySocket.timeout(5000).emit('join',{code,name,token:localStorage.getItem('hula_'+code)},(err,r)=>{if(err){hulaPending=false;$('msg').textContent='연결을 확인해주세요.'}else enterHulaResponse(r)})}
