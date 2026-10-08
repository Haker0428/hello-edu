/* ============ 共享 Mock 数据（种子随机，刷新稳定） ============ */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const RNG=mulberry32(20260930);
const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
const rr=(rng,a,b)=>a+rng()*(b-a);

/* 知识点（含章节与前置链：有理数运算→…→方程应用题） */
const KPS=[
 {id:'kp1', name:'有理数运算',   ch:'第二章 · 整式的加减', pr:[]},
 {id:'kp2', name:'整式运算',     ch:'第二章 · 整式的加减', pr:['kp1']},
 {id:'kp3', name:'合并同类项',   ch:'第二章 · 整式的加减', pr:['kp2']},
 {id:'kp4', name:'去括号',       ch:'第二章 · 整式的加减', pr:['kp3']},
 {id:'kp5', name:'等式性质',     ch:'第三章 · 一元一次方程', pr:[]},
 {id:'kp6', name:'移项',         ch:'第三章 · 一元一次方程', pr:['kp4','kp5'], core:1},
 {id:'kp7', name:'去分母',       ch:'第三章 · 一元一次方程', pr:['kp6'], core:1, penalty:24},
 {id:'kp8', name:'系数化为1',    ch:'第三章 · 一元一次方程', pr:['kp7'], core:1},
 {id:'kp9', name:'方程求解综合', ch:'第三章 · 一元一次方程', pr:['kp8'], core:1},
 {id:'kp10',name:'实际问题列方程',ch:'第三章 · 应用', pr:['kp9']},
 {id:'kp11',name:'行程问题',     ch:'第三章 · 应用', pr:['kp10']},
 {id:'kp12',name:'工程问题',     ch:'第三章 · 应用', pr:['kp10']},
 {id:'kp13',name:'方案选择问题', ch:'第三章 · 应用', pr:['kp10']},
];

const NAMES=['李想','王雪','张浩','刘婷','陈杰','杨帆','赵磊','孙悦','周敏','吴昊','郑晓雯','冯旭','蒋雨桐','韩冰','曹阳','谢婷婷','邓超','萧静雯','程琳','罗凯','梁静','宋佳','唐悦','许峰','沈舟','潘越','卢雅雯','杜淳','江雪','董子健','白露','崔明浩','侯梦琪','邵雨','邹洁','文昊','金珊珊','魏晨','于晓萌','方远','严浩然','谭思颖'];

/* 人设：gap=前置断点 / weakall=全面弱 / forget=遗忘候选 / appweak=计算强应用弱 / strong=优秀 */
const ARCH={0:'gap',1:'gap',4:'weakall',2:'forget',3:'appweak',5:'strong'};

const STUDENTS=NAMES.map((name,i)=>{
  const t=ARCH[i]||'norm';
  const base=t=='strong'?rr(RNG,84,94):t=='weakall'?rr(RNG,30,40):rr(RNG,42,88);
  const s={name,i,cells:[]};
  KPS.forEach((k,ki)=>{
    if(ki>=10&&RNG()<(t=='appweak'?0.45:0.85)){s.cells.push(null);return}   /* 应用后三章大多未教 */
    if(ki==9&&RNG()<0.25){s.cells.push(null);return}
    let m=clamp(base+rr(RNG,-15,15));
    if(t=='gap'){if(ki<=3)m=clamp(rr(RNG,34,52));if(ki>=5&&ki<=8)m=clamp(rr(RNG,28,44))}
    if(t=='weakall')m=clamp(m-8);
    if(t=='appweak'){m=ki>=9?clamp(rr(RNG,30,48)):Math.max(m,clamp(rr(RNG,70,90)))}
    if(k.penalty)m=clamp(m-k.penalty);
    if(t=='forget'&&ki==0)m=clamp(rr(RNG,80,92));
    const n=3+Math.floor(RNG()*7);
    let c=clamp(45+n*6+rr(RNG,0,12),30,96);
    if(t=='forget'&&ki==0)c=clamp(rr(RNG,42,52),40,55);
    s.cells.push({m:Math.round(m),c:Math.round(c),n});
  });
  const core=[5,6,7,8,9].map(ki=>s.cells[ki]).filter(Boolean).map(x=>x.m);
  const avg=core.reduce((a,b)=>a+b,0)/core.length, min=Math.min(...core);
  s.risk=avg<45?'high':(min<40||avg<62)?'watch':'ok';
  return s;
});

function levelOf(m){
  if(m==null)return{key:'none',label:'未学习'};
  if(m<40)return{key:'weak',label:'未掌握'};
  if(m<60)return{key:'learning',label:'学习中'};
  if(m<75)return{key:'basic',label:'初步掌握'};
  if(m<90)return{key:'skilled',label:'熟练'};
  return{key:'stable',label:'稳定掌握'};
}
const RISKL={high:'高风险',watch:'需关注',ok:'正常'};

function avgByKp(ki){const v=STUDENTS.map(s=>s.cells[ki]).filter(Boolean).map(c=>c.m);return Math.round(v.reduce((a,b)=>a+b,0)/v.length)}
function weakCount(ki){return STUDENTS.filter(s=>s.cells[ki]&&s.cells[ki].m<40).length}

/* 题干素材 */
const STEMS={
 '有理数运算':['计算：(-12)+7×(-3)','计算：(-2)³-(-6)÷3','计算：-1⁴-[2-( -3)²]','计算：24÷(-4)+(-1)²⁰²⁵'],
 '整式运算':['化简：3a²b-2ab²+a²b','化简：2x²y+3x²y-5x²y','若 2xᵐy³ 与 -x²yⁿ 是同类项，求 m+n','化简：-(4ab-3a²)-2(ab-2a²)'],
 '合并同类项':['合并：4x²-3x+2x²+x-1','合并：7a+3-2a-8+a','合并：5mn-2mn+8mn-nm','合并：x⁵-x⁴+x⁵-3x⁴'],
 '去括号':['去括号并化简：2(3x-4)-3(x+2)','去括号：-(2x-5)+3(x-1)','化简：3(2a-b)-2(3a-2b)','去括号：x-2(x-y)+3(x-2y)'],
 '等式性质':['填空：若 x+3=7，两边同时___ 得 x=4','判断：由 2x=6 得 x=3 的依据是___','若 a=b，则 3a-2___3b-2','由 x/4=5 得 x=20，依据是等式性质___'],
 '移项':['解方程：3x+5=2x-1','解方程：7x-3=4x+6','解方程：5-2x=8+x','解方程：9x-8=7x+2','解方程：x/2-3=x/5+1'],
 '去分母':['解方程：(x-1)/3=(2x+1)/2','解方程：x/2-(x-1)/3=1','解方程：(3y+1)/4-1=(2y-1)/3','解方程：2(x-1)/5=x+2/3'],
 '系数化为1':['解方程：-4x=12','解方程：2/3 x=8','解方程：-0.5x=-7','解方程：5x=-1/2'],
 '方程求解综合':['解方程：2(x-3)=3(x+1)-6','解方程：3(x-2)-2(x+1)=2x+1','解方程：(2x-1)/4-1=x-(2x+1)/3','解方程：4x-3(20-x)=6x-7(x+3)'],
 '实际问题列方程':['某数的 3 倍比它大 5，设该数为 x，列方程求解','一个数的 2 倍减去 9 等于这个数的 1/3，求这个数','甲数比乙数的 2 倍少 3，两数之和为 12，求两数','男生人数比女生多 1/5，共 66 人，求女生人数'],
 '行程问题':['甲乙相距 240km，甲速 60km/h，乙速 40km/h，相向而行几小时相遇？','汽车去程 80km/h，回程 60km/h，往返平均速度？','两人同时同地反向跑步，环形单车赛道周长 400m…','火车长 200m，以 20m/s 通过长 700m 的大桥需多久？'],
 '工程问题':['一项工程甲单独 12 天完成，乙单独 18 天完成，合作几天完成？','一个水池单开进水管 6 小时注满，单开排水管 10 小时放空…','一批零件甲每小时做 15 个…','整理数据一人需 30 分钟…'],
 '方案选择问题':['租车：甲型每辆 200 元坐 30 人，乙型每辆 300 元坐 50 人…','购书：单价 8 抍 vs 团购满减方案比较…','话费套餐 A 月租 18 元 0.15 元/分钟 vs B 月租 8 元 0.25 元/分钟…','服装厂 A 方案按件计费 vs B 方案底薪加提成…'],
};

/* 证据链（按 学生×知识点 确定性生成） */
function evidenceFor(si,ki){
  const rng=mulberry32(si*1009+ki*73+7);
  const cell=STUDENTS[si].cells[ki];
  if(!cell)return[];
  const n=Math.min(cell.n,8);
  const dates=['09-12','09-19','09-26','10-11','10-18','10-28'].slice(-n);
  const srcs=['作业','随堂练习','练习卷','月考'];
  const pool=STEMS[KPS[ki].name]||['综合题'];
  const out=[];
  for(let j=0;j<n;j++){
    const f=clamp(cell.m/100+rr(rng,-0.25,0.25));
    const max=[3,4,5,5,6,8][Math.floor(rng()*6)];
    out.push({date:dates[j],src:srcs[Math.floor(rng()*4)],stem:pool[Math.floor(rng()*pool.length)],
      score:Math.round(f*max),max,E:Math.round(f*100),
      alpha:(0.08+rng()*0.22).toFixed(2),mapConf:(0.7+rng()*0.25).toFixed(2)});
  }
  return out.reverse();
}

/* 前置链（DFS 到根，含自身） */
function prereqChain(ki){
  const out=[];
  (function walk(i){(KPS[i].pr||[]).forEach(id=>walk(KPS.findIndex(k=>k.id===id)));if(!out.includes(i))out.push(i)})(ki);
  return out;
}

/* 小工具 */
function toast(msg){let t=document.getElementById('toast');if(!t){t=document.createElement('div');t.id='toast';document.body.appendChild(t)}t.textContent=msg;t.classList.add('on');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('on'),2200)}
function sparkSVG(vals,w=90,h=26,stroke='#e5484d'){
  const min=Math.min(...vals),max=Math.max(...vals),sp=(max-min)||1;
  const pts=vals.map((v,i)=>`${(i/(vals.length-1))*(w-4)+2},${h-3-((v-min)/sp)*(h-8)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

/* ============ FX 动效系统（入场编排 + 数字滚动，仅首次加载执行一次） ============ */
(function(){
  function ready(fn){document.readyState!=='loading'?fn():document.addEventListener('DOMContentLoaded',fn)}
  ready(function once(){
    /* 1) 入场延迟注入：卡片/统计块/异常卡/待办依次浮现（CSS 消费 --d） */
    let i=0;
    document.querySelectorAll('.card,.stat,.anomaly,.todo,.q-head,.dr-sec')
      .forEach(el=>{el.style.setProperty('--d',Math.min(i*45,650)+'ms');i++});
    /* 2) 热力图行波浪式入场（首次渲染的行） */
    let r=0;
    document.querySelectorAll('.hm tbody tr').forEach(tr=>{tr.style.setProperty('--d',Math.min(r*16,720)+'ms');r++});
    /* 3) 统计数字滚动（支持 整数/小数/后缀，如 96%、18/42） */
    document.querySelectorAll('.stat .v').forEach(el=>{
      const t=el.textContent.trim(),m=t.match(/^(\d+(\.\d+)?)/);if(!m)return;
      const end=parseFloat(m[1]),suf=t.slice(m[1].length),dur=750,t0=performance.now();
      (function tick(now){
        const p=Math.min(1,(now-t0)/dur),e=1-Math.pow(1-p,3),v=end*e;
        el.textContent=(end%1?v.toFixed(1):Math.round(v))+(p===1?suf:'');
        if(p<1)requestAnimationFrame(tick);
      })(t0);
    });
  });
})();
