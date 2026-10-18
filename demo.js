/* demo.js — 健身动作演示（SVG 火柴人，requestAnimationFrame 驱动，禁用 CSS 动画） */
(function(){
'use strict';
var NS='http://www.w3.org/2000/svg';
var LINE='#a3e635',GROUND='#2a3140';

function lerp(a,b,t){return a+(b-a)*t;}
function ease(t){return t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2;}
function lerpPose(A,B,t){
  var o={};
  for(var k in A){o[k]=[lerp(A[k][0],B[k][0],t),lerp(A[k][1],B[k][1],t)];}
  return o;
}

/* ---------- 8 个动作的关键帧姿态（120x120 画布，地面 y=105） ---------- */
var MOVES={
  '深蹲':{cycle:2200,poses:[
    {h:[60,20],s:[60,32],p:[60,60],e1:[46,46],e2:[74,46],a1:[44,58],a2:[76,58],k1:[54,82],k2:[66,82],f1:[52,104],f2:[68,104]},
    {h:[57,32],s:[57,44],p:[57,68],e1:[43,58],e2:[71,58],a1:[38,70],a2:[76,70],k1:[42,76],k2:[72,76],f1:[46,104],f2:[68,104]},
    {h:[60,20],s:[60,32],p:[60,60],e1:[46,46],e2:[74,46],a1:[44,58],a2:[76,58],k1:[54,82],k2:[66,82],f1:[52,104],f2:[68,104]}
  ]},
  '俯卧撑':{cycle:1600,poses:[
    {h:[76,64],s:[68,72],p:[42,78],e1:[66,85],e2:[70,85],a1:[66,96],a2:[72,96],k1:[28,84],k2:[32,86],f1:[16,93],f2:[20,95]},
    {h:[74,76],s:[66,84],p:[42,86],e1:[74,90],e2:[78,90],a1:[66,96],a2:[72,96],k1:[28,88],k2:[32,90],f1:[16,94],f2:[20,96]},
    {h:[76,64],s:[68,72],p:[42,78],e1:[66,85],e2:[70,85],a1:[66,96],a2:[72,96],k1:[28,84],k2:[32,86],f1:[16,93],f2:[20,95]}
  ]},
  '平板支撑':{cycle:3000,poses:[
    {h:[78,72],s:[70,78],p:[44,80],e1:[62,92],e2:[64,92],a1:[48,94],a2:[50,94],k1:[30,84],k2:[34,85],f1:[16,93],f2:[20,95]},
    {h:[78,70],s:[70,76],p:[44,79],e1:[62,92],e2:[64,92],a1:[48,94],a2:[50,94],k1:[30,83],k2:[34,84],f1:[16,93],f2:[20,95]},
    {h:[78,72],s:[70,78],p:[44,80],e1:[62,92],e2:[64,92],a1:[48,94],a2:[50,94],k1:[30,84],k2:[34,85],f1:[16,93],f2:[20,95]}
  ]},
  '卷腹':{cycle:1800,poses:[
    {h:[82,88],s:[72,90],p:[44,92],e1:[84,80],e2:[86,82],a1:[80,76],a2:[82,78],k1:[58,78],k2:[60,80],f1:[72,96],f2:[74,96]},
    {h:[74,82],s:[64,84],p:[44,92],e1:[76,74],e2:[78,76],a1:[72,70],a2:[74,72],k1:[58,78],k2:[60,80],f1:[72,96],f2:[74,96]},
    {h:[82,88],s:[72,90],p:[44,92],e1:[84,80],e2:[86,82],a1:[80,76],a2:[82,78],k1:[58,78],k2:[60,80],f1:[72,96],f2:[74,96]}
  ]},
  '开合跳':{cycle:1100,poses:[
    {h:[60,18],s:[60,30],p:[60,58],e1:[44,18],e2:[76,18],a1:[36,8],a2:[84,8],k1:[48,80],k2:[72,80],f1:[38,102],f2:[82,102]},
    {h:[60,21],s:[60,33],p:[60,61],e1:[50,46],e2:[70,46],a1:[47,60],a2:[73,60],k1:[55,83],k2:[65,83],f1:[53,104],f2:[67,104]},
    {h:[60,18],s:[60,30],p:[60,58],e1:[44,18],e2:[76,18],a1:[36,8],a2:[84,8],k1:[48,80],k2:[72,80],f1:[38,102],f2:[82,102]}
  ]},
  '弓步蹲':{cycle:2000,poses:[
    {h:[64,22],s:[62,34],p:[62,60],e1:[52,46],e2:[72,46],a1:[50,62],a2:[74,62],k1:[72,82],k2:[48,84],f1:[78,104],f2:[40,104]},
    {h:[60,26],s:[58,38],p:[58,64],e1:[48,50],e2:[68,50],a1:[46,66],a2:[70,66],k1:[70,78],k2:[50,96],f1:[78,102],f2:[42,104]},
    {h:[64,22],s:[62,34],p:[62,60],e1:[52,46],e2:[72,46],a1:[50,62],a2:[74,62],k1:[72,82],k2:[48,84],f1:[78,104],f2:[40,104]}
  ]},
  '靠墙静蹲':{cycle:3200,wall:true,poses:[
    {h:[81,28],s:[79,42],p:[75,70],e1:[66,54],e2:[70,54],a1:[62,66],a2:[74,66],k1:[45,70],k2:[49,70],f1:[43,102],f2:[47,102]},
    {h:[81,27],s:[79,41],p:[75,69],e1:[66,54],e2:[70,54],a1:[62,66],a2:[74,66],k1:[45,70],k2:[49,70],f1:[43,102],f2:[47,102]},
    {h:[81,28],s:[79,42],p:[75,70],e1:[66,54],e2:[70,54],a1:[62,66],a2:[74,66],k1:[45,70],k2:[49,70],f1:[43,102],f2:[47,102]}
  ]},
  '高抬腿':{cycle:900,poses:[
    {h:[62,20],s:[60,32],p:[60,58],e1:[68,42],e2:[50,44],a1:[74,52],a2:[44,54],k1:[72,48],k2:[52,82],f1:[68,70],f2:[48,104]},
    {h:[62,20],s:[60,32],p:[60,58],e1:[50,42],e2:[70,44],a1:[44,52],a2:[76,54],k1:[62,82],k2:[48,48],f1:[66,104],f2:[52,70]},
    {h:[62,20],s:[60,32],p:[60,58],e1:[68,42],e2:[50,44],a1:[74,52],a2:[44,54],k1:[72,48],k2:[52,82],f1:[68,70],f2:[48,104]}
  ]}
};
function resolve(name){
  name=String(name||'');
  if(MOVES[name])return MOVES[name];
  if(name.indexOf('墙')>=0)return MOVES['靠墙静蹲'];
  if(name.indexOf('平板')>=0)return MOVES['平板支撑'];
  if(name.indexOf('跳')>=0)return MOVES['开合跳'];
  if(name.indexOf('弓步')>=0)return MOVES['弓步蹲'];
  if(name.indexOf('蹲')>=0)return MOVES['深蹲'];
  if(name.indexOf('卧')>=0)return MOVES['俯卧撑'];
  if(name.indexOf('撑')>=0)return MOVES['俯卧撑'];
  if(name.indexOf('腹')>=0||name.indexOf('卷')>=0)return MOVES['卷腹'];
  if(name.indexOf('抬腿')>=0||name.indexOf('跑')>=0)return MOVES['高抬腿'];
  return null;
}

/* ---------- SVG 构建 ---------- */
var st={raf:0,els:null,poses:[],cycle:2000,t0:0,generic:false};
function mkLine(color,w){
  var l=document.createElementNS(NS,'line');
  l.setAttribute('stroke',color);l.setAttribute('stroke-width',w);
  l.setAttribute('stroke-linecap','round');l.setAttribute('stroke-linejoin','round');
  return l;
}
function buildSVG(box,wall){
  box.innerHTML='';
  var svg=document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox','0 0 120 120');
  var g=document.createElementNS(NS,'line');
  g.setAttribute('x1','6');g.setAttribute('y1','105');g.setAttribute('x2','114');g.setAttribute('y2','105');
  g.setAttribute('stroke',GROUND);g.setAttribute('stroke-width','2');
  svg.appendChild(g);
  var wallEl=mkLine(GROUND,6);
  wallEl.setAttribute('x1','84');wallEl.setAttribute('y1','8');wallEl.setAttribute('x2','84');wallEl.setAttribute('y2','105');
  wallEl.setAttribute('opacity',wall?'1':'0');
  svg.appendChild(wallEl);
  var head=document.createElementNS(NS,'circle');
  head.setAttribute('r','7');head.setAttribute('fill',LINE);
  svg.appendChild(head);
  var els={head:head,wall:wallEl};
  ['torso','a1a','a1b','a2a','a2b','l1a','l1b','l2a','l2b'].forEach(function(k){els[k]=mkLine(LINE,5.5);svg.appendChild(els[k]);});
  box.appendChild(svg);
  st.els=els;
}
function setL(l,a,b){l.setAttribute('x1',a[0]);l.setAttribute('y1',a[1]);l.setAttribute('x2',b[0]);l.setAttribute('y2',b[1]);}
function apply(p){
  var e=st.els;if(!e)return;
  e.head.setAttribute('cx',p.h[0]);e.head.setAttribute('cy',p.h[1]);
  setL(e.torso,p.s,p.p);
  setL(e.a1a,p.s,p.e1);setL(e.a1b,p.e1,p.a1);
  setL(e.a2a,p.s,p.e2);setL(e.a2b,p.e2,p.a2);
  setL(e.l1a,p.p,p.k1);setL(e.l1b,p.k1,p.f1);
  setL(e.l2a,p.p,p.k2);setL(e.l2b,p.k2,p.f2);
}
function frame(){
  if(!st.els)return;
  var p=((Date.now()-st.t0)%st.cycle)/st.cycle;
  var n=st.poses.length-1,x=p*n,i=Math.min(n-1,Math.floor(x));
  apply(lerpPose(st.poses[i],st.poses[i+1],ease(x-i)));
}
/* 通用兜底：哑铃脉冲 */
var gEl=null;
function buildGeneric(box){
  box.innerHTML='';
  var svg=document.createElementNS(NS,'svg');
  svg.setAttribute('viewBox','0 0 120 120');
  gEl=document.createElementNS(NS,'g');
  function rect(x,y,w,h){var r=document.createElementNS(NS,'rect');r.setAttribute('x',x);r.setAttribute('y',y);r.setAttribute('width',w);r.setAttribute('height',h);r.setAttribute('rx','4');r.setAttribute('fill',LINE);return r;}
  gEl.appendChild(rect(36,54,48,12));
  gEl.appendChild(rect(26,40,12,40));
  gEl.appendChild(rect(82,40,12,40));
  svg.appendChild(gEl);box.appendChild(svg);
}
function frameGeneric(){
  if(!gEl)return;
  var s=1+0.22*(0.5+0.5*Math.sin(Date.now()/220));
  gEl.setAttribute('transform','translate(60 60) scale('+s.toFixed(3)+') translate(-60 -60)');
}
function stopInternal(){
  if(st.raf){clearInterval(st.raf);st.raf=0;}
  st.els=null;gEl=null;
}
window.FIT_DEMO={
  play:function(name){
    stopInternal();
    var box=document.getElementById('demo-box');
    if(!box)return;
    var mv=resolve(name);
    if(mv){buildSVG(box,!!mv.wall);st.poses=mv.poses;st.cycle=mv.cycle;st.t0=Date.now();st.raf=setInterval(frame,40);}
    else{st.generic=true;buildGeneric(box);st.raf=setInterval(frameGeneric,40);}
  },
  stop:function(){
    stopInternal();
    var box=document.getElementById('demo-box');
    if(box)box.innerHTML='';
  }
};
})();
