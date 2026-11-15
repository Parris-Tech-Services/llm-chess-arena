
/**
 * LLM Chess Arena: autonomous Cloudflare backend, durable across device shutdowns.
 * Chess rules: chess.js. Storage/timers: one SQLite-backed Durable Object.
 * Live models: Groq. Hidden model reasoning is never published.
 */
import { Chess } from 'chess.js';
import { computeStandings } from '../src/rating.mjs';

const FRONTEND = 'https://raw.githubusercontent.com/Parris-Tech-Services/llm-chess-arena/main/public';
const FALLBACK = { white: 'openai/gpt-oss-120b', black: 'qwen/qwen3.8-27b', referee: 'openai/gpt-oss-20b' };
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};
const MIME = {'index.html':'text/html; charset=utf-8','style.css':'text/css; charset=utf-8','app.js':'application/javascript; charset=utf-8','favicon.svg':'image/svg+xml'};
const json = (data, status=200) => new Response(JSON.stringify(data),{status,headers:{...HEADERS,'content-type':'application/json; charset=utf-8'}});
const sleep = (ms) => new Promise(resolve=>setTimeout(resolve,ms));

function emptyState(){
  const c = new Chess();
  return {
    id:null, generation:0, status:'idle', fen:c.fen(), pgn:'', turn:'w', inCheck:false, moves:[],
    fens:[c.fen()], players:{w:{name:'White',model:null},b:{name:'Black',model:null},referee:{name:'Referee',model:null}},
    clocks:{w:300000,b:300000}, timeControl:{baseMs:300000,incrementMs:1000},
    pace:700, result:null, reason:null, verdict:null, refereeLog:[],rejections:[],
    startedAt:null,finishedAt:null,moveStartedAt:null,interrupted:false,latency:{w:null,b:null},
    noProgress:0,forced:{w:0,b:0},latencyStats:{w:[],b:[]},
  };
}
function parseChess(s){
  const c=new Chess();
  if(s.pgn){try{c.loadPgn(s.pgn);}catch(e){throw new Error('Stored chess game cannot be replayed: '+e.message);}}
  return c;
}
function fromChess(s,c){
  s.fen=c.fen();s.pgn=c.pgn();s.turn=c.turn();s.inCheck=c.inCheck();
}
function publicState(s){
  const {generation,forced,latencyStats,...rest}=s;
  const v=structuredClone(rest);
  if(s.status==='playing' && s.timeControl?.baseMs>0 && s.moveStartedAt){
    v.clocks[s.turn]=Math.max(0,v.clocks[s.turn]-(Date.now()-s.moveStartedAt));
  }
  return v;
}
function keys(env){return String(env.GROQ_KEYS||'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean);}
const VALID=/^[\w./:-]{1,100}$/;
const playable=id=>!/(whisper|orpheus|prompt-guard|allam|tts|transcrib)/i.test(id);
const allowed=(m,def)=>typeof m==='string' && VALID.test(m)&&playable(m)?m:def;
function parseMove(content,chess){
  const raw=String(content||'');
  const match=raw.match(/^\s*MOVE\s*:\s*([^\s,;]+)/im);
  const fallback=raw.trim().match(/^([a-h][1-8][a-h][1-8][qrbn]?|O-O(?:-O)?|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)$/);
  const token=(match?.[1]||fallback?.[1]||'').replace(/[.!]+$/,'').trim();
  if(!token)return {token:null,move:null};
  let move=null;
  try{move=chess.move(token);}catch{}
  if(!move && /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(token)){
    try{move=chess.move({from:token.slice(0,2),to:token.slice(2,4),promotion:token[4]||'q'});}catch{}
  }
  return {token,move};
}
const thinkLine = text => String(text||'').match(/THINK\s*:\s*([\s\S]*)/i)?.[1]?.replace(/\s+/g,' ').trim().slice(0,240)||'';
function movePrompt(s,chess,side,extra=''){
 const legal=chess.moves();
 const last=chess.history().slice(-24).join(' ');
 return [
  {role:'system',content:'You are an AI competing in live chess, playing '+(side==='w'?'White':'Black')+'. Select exactly ONE move from the legal list. Respond with two short public lines: MOVE: <SAN> and THINK: <up to 25 words of broadcast-friendly chess commentary>. Do not reveal private reasoning. Do not invent moves.'},
  {role:'user',content:'FEN: '+chess.fen()+'\nMove history: '+last+'\nLegal SAN moves: '+legal.join(', ')+'\n'+extra+'\nChoose your strongest move. Reply MOVE: and THINK:.'}
 ];
}
function outcome(s,chess){
 if(chess.isCheckmate())return {result:chess.turn()==='w'?'b-wins':'w-wins',reason:'checkmate'};
 if(chess.isStalemate())return {result:'draw',reason:'stalemate'};
 if(chess.isInsufficientMaterial())return {result:'draw',reason:'insufficient material'};
 if(chess.isThreefoldRepetition())return {result:'draw',reason:'threefold repetition'};
 if(chess.isDrawByFiftyMoves())return {result:'draw',reason:'fifty-move rule'};
 if(s.noProgress>=80)return {result:'draw',reason:'arena no-progress rule'};
 if(s.moves.length>=220)return {result:'draw',reason:'220-ply exhibition limit'};
 return null;
}
function gameSummary(g){
 return {id:g.id,status:g.status,result:g.result,reason:g.reason,players:g.players,plies:g.moves.length,startedAt:g.startedAt,finishedAt:g.finishedAt};
}

export class ArenaRoom {
  constructor(ctx,env){
    this.ctx=ctx;this.env=env;this.clients=new Set();this.keyCursor=0;this.models=null;this.modelsAt=0;
  }
  async getCurrent(){return (await this.ctx.storage.get('current'))||emptyState();}
  async save(s){await this.ctx.storage.put('current',s);}
  emit(event){
    const frame='data: '+JSON.stringify(event)+'\n\n';
    for(const client of this.clients){try{client.enqueue(frame);}catch{this.clients.delete(client);}}
  }
  emitState(s){this.emit({type:'state',state:publicState(s)});}
  async modelList(){
    if(this.models && Date.now()-this.modelsAt<10*60*1000)return this.models;
    const all=keys(this.env);
    if(!all.length)return [{id:'mock',context:0,active:true}];
    try{
      const r=await fetch('https://api.groq.com/openai/v1/models',{headers:{authorization:'Bearer '+all[0]}});
      if(!r.ok)throw Error('Catalogue '+r.status);
      const d=await r.json();
      const models=(d.data||[]).filter(m=>m.active!==false&&playable(m.id)).map(m=>({id:m.id,context:m.context_window||0,active:true})).sort((a,b)=>a.id.localeCompare(b.id));
      if(models.length){this.models=models;this.modelsAt=Date.now();return models;}
    }catch(e){console.warn('Model catalogue:',e.message);}
    return Object.values(FALLBACK).map(id=>({id,context:0,active:true}));
  }
  async groq(model,messages,maxTokens=700){
    const all=keys(this.env);
    if(!all.length)throw Error('No Groq credentials configured on this Cloudflare Worker');
    let err=null,budget=maxTokens;
    for(let n=0;n<Math.min(8,all.length*2);n++){
      const key=all[(this.keyCursor++)%all.length];
      try{
        const body={model,messages,max_tokens:budget,temperature:0.5,stream:false};
        if(/gpt-oss/i.test(model))body.reasoning_effort='low';
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),45000);
        let r;
        try{r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify(body),signal:controller.signal});}
        finally{clearTimeout(timeout);}
        if(!r.ok){
          const responseText=(await r.text()).slice(0,250);
          if(r.status===429&&budget>300&&/max_tokens|output tokens|OTPM|request too large/i.test(responseText)){budget=Math.max(260,Math.floor(budget/2));continue;}
          if([401,403,429,500,502,503,504].includes(r.status)){err=new Error('Groq '+r.status);await sleep(200);continue;}
          throw Error('Groq '+r.status+' '+responseText);
        }
        const d=await r.json();
        return String(d.choices?.[0]?.message?.content||'');
      }catch(e){err=e;}
    }
    throw err||Error('Provider unavailable');
  }
  async rememberGame(s,final=false){
    if(!s.id)return;
    await this.ctx.storage.put('game:'+s.id,publicState(s));
    const list=(await this.ctx.storage.get('gameIndex'))||[];
    const next=[gameSummary(s),...list.filter(g=>g.id!==s.id)].slice(0,100);
    await this.ctx.storage.put('gameIndex',next);
    if(final&&s.result!=='aborted'&&s.result!=='error'){
      const results=(await this.ctx.storage.get('results'))||[];
      if(!results.some(r=>r.gameId===s.id)){
        results.push({gameId:s.id,white:s.players.w.model,black:s.players.b.model,referee:s.players.referee.model,
          result:s.result==='w-wins'?'w':s.result==='b-wins'?'b':'draw',reason:s.reason,
          moves:{w:s.moves.filter(m=>m.side==='w').length,b:s.moves.filter(m=>m.side==='b').length},
          rejections:{w:s.rejections.filter(x=>x.side==='w').length,b:s.rejections.filter(x=>x.side==='b').length},
          latency:s.latency,endedAt:s.finishedAt});
        await this.ctx.storage.put('results',results.slice(-400));
      }
    }
  }
  async finish(s,result,reason){
    s.status='finished';s.result=result;s.reason=reason;s.finishedAt=Date.now();s.moveStartedAt=null;
    // Referee cannot override deterministic result.
    if(result!=='aborted'&&result!=='error'&&keys(this.env).length){
      try{
        const prompt='Chess result: '+result+' ('+reason+'). White: '+s.players.w.name+'. Black: '+s.players.b.name+'. PGN: '+s.pgn.slice(-1800)+'. In one sentence explain the result, then write Player of the match: White or Black or none. Do not invent game events.';
        const note=(await this.groq(s.players.referee.model,[{role:'system',content:'You are a concise live chess referee. The rules engine decides the result; you only comment.'},{role:'user',content:prompt}],650)).slice(0,500);
        s.verdict={verdict:'agree',conduct:'clean',engineResult:result,summary:note,note,playerOfMatch:null,mismatch:false};
      }catch(e){s.verdict={verdict:'unknown',conduct:'unknown',engineResult:result,note:'Referee unavailable',summary:'',mismatch:false};}
    }
    await this.save(s);await this.rememberGame(s,true);this.emitState(s);
  }
  async alarm(){
    let s=await this.getCurrent();
    if(s.status!=='playing')return;
    const gen=s.generation;
    let chess;
    try{chess=parseChess(s);}catch(e){await this.finish(s,'error',e.message);return;}
    const side=chess.turn(),player=s.players[side],other=s.players[side==='w'?'b':'w'];
    const began=Date.now();
    if(s.timeControl.baseMs>0&&s.clocks[side]<=0){await this.finish(s,(side==='w'?'b':'w')+'-wins','time forfeit');return;}
    s.moveStartedAt=began;await this.save(s);this.emitState(s);
    this.emit({type:'turn',side,moveNumber:Math.floor(s.moves.length/2)+1});
    let selected=null;
    let explanation='',attempts=0,illegal=null,usedForced=false;
    try{
      if(!keys(this.env).length){
        const legal=chess.moves(),chosen=legal[Math.floor(Math.random()*legal.length)];
        selected=chess.move(chosen);explanation='Demo mode: deterministic legal-move selection';attempts=1;
      }else{
        for(let n=1;n<=3;n++){
          attempts=n;
          const reply=await this.groq(player.model,movePrompt(s,chess,side,illegal?'Previous answer rejected: '+illegal+'. Try again from the legal list.':''),700);
          const {token,move}=parseMove(reply,chess);
          if(move){selected=move;explanation=thinkLine(reply);break;}
          illegal=token?'Rejected illegal move '+token:'No valid MOVE: line';
          s.rejections.push({side,moveNumber:Math.floor(s.moves.length/2)+1,reason:illegal,attempt:n});
          this.emit({type:'rejection',side,reason:illegal});
        }
      }
    }catch(e){
      illegal='Provider error: '+String(e.message||e).slice(0,100);
      s.rejections.push({side,reason:illegal,moveNumber:Math.floor(s.moves.length/2)+1});
    }
    const latest=await this.getCurrent();
    if(latest.generation!==gen||latest.status!=='playing')return;
    s=latest;
    chess=parseChess(s);
    if(selected){
      // A requested move was tested on a throwaway board. Revalidate against
      // the latest authoritative position before modifying persistent state.
      try{selected=chess.move(selected.san);}catch{selected=null;}
    }
    if(!selected){
      if((s.forced[side]||0)<2){
        s.forced[side]=(s.forced[side]||0)+1;
        const legal=chess.moves();
        selected=chess.move(legal[Math.floor(Math.random()*legal.length)]);
        explanation='Arena supplied a legal move after the AI failed to reply';
        usedForced=true;
      }else{await this.finish(s,(side==='w'?'b':'w')+'-wins','forfeit: repeated missing or illegal moves');return;}
    }
    const elapsed=Date.now()-began;
    if(s.timeControl.baseMs>0){
      s.clocks[side]=Math.max(0,s.clocks[side]-elapsed);
      if(s.clocks[side]===0){await this.finish(s,(side==='w'?'b':'w')+'-wins','time forfeit');return;}
      s.clocks[side]+=s.timeControl.incrementMs;
    }
    fromChess(s,chess);
    s.fens.push(chess.fen());
    s.noProgress=selected.captured||selected.piece==='p'?0:s.noProgress+1;
    s.latencyStats[side].push(elapsed);
    s.latency[side]=Math.round(s.latencyStats[side].reduce((a,b)=>a+b,0)/s.latencyStats[side].length);
    const move={n:s.moves.length+1,san:selected.san,side,from:selected.from,to:selected.to,piece:selected.piece,
      captured:selected.captured||null,think:explanation,ms:elapsed,attempts:attempts||1,forced:usedForced};
    s.moves.push(move);
    s.moveStartedAt=null;
    await this.save(s);await this.rememberGame(s);
    this.emit({type:'move',move,state:publicState(s)});this.emitState(s);
    const win=outcome(s,chess);
    if(win){await this.finish(s,win.result,win.reason);return;}
    if(keys(this.env).length && s.players.referee.model){
      try{
        const content=await this.groq(s.players.referee.model,[
          {role:'system',content:'You are an entertaining, concise chess commentator, NOT a source of rules. Under 22 words. Never claim a move illegal: the chess rules engine decides legality. No private model reasoning.'},
          {role:'user',content:'Move '+Math.ceil(s.moves.length/2)+', '+(side==='w'?'White':'Black')+' played '+selected.san+'. Position FEN: '+s.fen+'. Player commentary: '+explanation+'. React in one sentence.'}
        ],500);
        if(content.trim()){
          const now=await this.getCurrent();
          if(now.generation===gen && now.status==='playing'){
            now.refereeLog.push({moveNumber:Math.ceil(now.moves.length/2),text:content.trim().slice(0,240),kind:'remark',at:Date.now()});
            await this.save(now);this.emit({type:'referee',entry:now.refereeLog.at(-1)});this.emitState(now);
          }
        }
      }catch(e){console.warn('Referee comment unavailable',e.message);}
    }
    s=await this.getCurrent();
    if(s.status==='playing'&&s.generation===gen){
      s.moveStartedAt=Date.now();await this.save(s);
      await this.ctx.storage.setAlarm(Date.now()+Math.max(100,s.pace));
    }
  }
  async fetch(request){
    const u=new URL(request.url),p=u.pathname,method=request.method;
    if(p==='/events'){
      const s=await this.getCurrent();
      const enc=new TextEncoder();
      let controllerRef;
      const stream=new ReadableStream({
        start:(controller)=>{
          controllerRef=controller;
          this.clients.add(controller);
          controller.enqueue(enc.encode('retry: 3000\n: '+'.'.repeat(2050)+'\n\ndata: '+JSON.stringify({type:'state',state:publicState(s)})+'\n\n'));
        },
        cancel:()=>this.clients.delete(controllerRef),
      });
      // Controller accepts Uint8Array; wrap for broadcast compatibility.
      const controller=controllerRef;
      const orig=controller.enqueue.bind(controller);
      controller.enqueue=(x)=>orig(typeof x==='string'?enc.encode(x):x);
      return new Response(stream,{headers:{...HEADERS,'content-type':'text/event-stream','connection':'keep-alive','x-accel-buffering':'no'}});
    }
    const s=await this.getCurrent();
    if(p==='/api/state')return json(publicState(s));
    if(p==='/health')return json({ok:true,version:'cloudflare-durable-v1',mode:keys(this.env).length?'groq':'mock',
      game:{id:s.id,status:s.status,plies:s.moves.length,result:s.result},keys:{total:keys(this.env).length},backend:'Cloudflare Durable Objects',independentOfPhone:true});
    if(p==='/api/keys')return json({mode:keys(this.env).length?'groq':'mock',total:keys(this.env).length,available:keys(this.env).length,cooling:0,disabled:0});
    if(p==='/api/config'){
      const models=await this.modelList();
      return json({mode:keys(this.env).length?'groq':'mock',version:'cloudflare-durable-v1',models,
        defaults:FALLBACK,limits:{maxPlies:220,startPerMinute:4},
        timeControl:{baseMs:300000,incrementMs:1000},pace:700});
    }
    if(p==='/api/standings')return json(computeStandings((await this.ctx.storage.get('results'))||[]));
    if(p==='/api/games')return json({games:((await this.ctx.storage.get('gameIndex'))||[]).slice(0,40)});
    if(p.startsWith('/api/games/')){
      const id=p.split('/').pop();
      if(!/^[a-zA-Z0-9_-]{4,40}$/.test(id))return json({error:'invalid game ID'},400);
      const g=await this.ctx.storage.get('game:'+id);
      return g?json(g):json({error:'game not found'},404);
    }
    if(method!=='POST')return json({error:'not found'},404);
    if(p==='/api/start'||p==='/api/rematch'){
      if(['playing','paused'].includes(s.status))return json({error:'a game is already running'},409);
      const history=(await this.ctx.storage.get('startTimes'))||[];
      const recently=history.filter(t=>t>Date.now()-60000);
      if(recently.length>=4)return json({error:'Too many starts. Try again shortly.'},429);
      await this.ctx.storage.put('startTimes',[...recently,Date.now()]);
      let body={};
      if(p==='/api/rematch'){
        if(!s.players.w.model||!s.players.b.model)return json({error:'No prior game'},409);
        body={white:{model:s.players.b.model},black:{model:s.players.w.model},referee:{model:s.players.referee.model}};
      }else{
        try{body=await request.json();}catch{body={};}
      }
      const next=emptyState();
      next.generation=s.generation+1;
      next.id=crypto.randomUUID().slice(0,8);
      next.players={
        w:{name:allowed(body.white?.name||body.white?.model,FALLBACK.white).split('/').pop(),model:allowed(body.white?.model,FALLBACK.white)},
        b:{name:allowed(body.black?.name||body.black?.model,FALLBACK.black).split('/').pop(),model:allowed(body.black?.model,FALLBACK.black)},
        referee:{name:'Referee',model:allowed(body.referee?.model,FALLBACK.referee)},
      };
      if(!keys(this.env).length){next.players.w.model='mock';next.players.b.model='mock';next.players.referee.model='mock';}
      const tc=body.timeControl||{};
      next.timeControl={
        baseMs:Number.isFinite(Number(tc.baseMs))?Math.max(0,Math.min(3600000,Number(tc.baseMs))):300000,
        incrementMs:Number.isFinite(Number(tc.incrementMs))?Math.max(0,Math.min(30000,Number(tc.incrementMs))):1000,
      };
      next.clocks={w:next.timeControl.baseMs,b:next.timeControl.baseMs};
      next.pace=Math.max(0,Math.min(5000,Number(body.pace)||0));
      next.status='playing';next.startedAt=Date.now();next.moveStartedAt=Date.now();
      await this.save(next);await this.rememberGame(next);this.emitState(next);
      await this.ctx.storage.setAlarm(Date.now()+250);
      return json({id:next.id,white:next.players.w,black:next.players.b,referee:next.players.referee},202);
    }
    if(p==='/api/pause'){
      if(s.status!=='playing')return json({paused:false});
      if(s.timeControl.baseMs>0&&s.moveStartedAt){s.clocks[s.turn]=Math.max(0,s.clocks[s.turn]-(Date.now()-s.moveStartedAt));}
      s.status='paused';s.moveStartedAt=null;await this.save(s);this.emitState(s);return json({paused:true});
    }
    if(p==='/api/resume'||p==='/api/resume-interrupted'){
      if(s.status!=='paused')return json({resumed:false});
      s.status='playing';s.moveStartedAt=Date.now();await this.save(s);this.emitState(s);
      await this.ctx.storage.setAlarm(Date.now()+200);return json({resumed:true});
    }
    if(p==='/api/stop'){
      if(s.status==='playing'||s.status==='paused'){s.generation++;await this.finish(s,'aborted','stopped by operator');}
      return json({stopped:true});
    }
    if(p==='/api/new'){
      if(s.id&&s.status!=='idle'&&s.status!=='finished'){await this.finish(s,'aborted','new game requested');}
      const next=emptyState();next.generation=s.generation+1;await this.save(next);this.emitState(next);return json({reset:true});
    }
    return json({error:'not found'},404);
  }
}

export default {
  async fetch(request,env){
    const url=new URL(request.url),p=url.pathname;
    if(p==='/_edge-health')return json({ok:true,deployment:'cloudflare-autonomous',backend:'Durable Objects',phoneRequired:false});
    if(request.method==='GET'&&(p==='/'||p==='/index.html'||p.startsWith('/g/')||p==='/style.css'||p==='/app.js'||p==='/favicon.svg')){
      const file=(p==='/'||p==='/index.html'||p.startsWith('/g/'))?'index.html':p.slice(1);
      try{
        const upstream=await fetch(FRONTEND+'/'+file,{cf:{cacheTtl:0}});
        if(!upstream.ok)throw Error('Frontend source '+upstream.status);
        const headers={...HEADERS,'content-type':MIME[file]||'text/plain'};
        if(file==='style.css'){
          let css=await upstream.text();
          css+='\n/* Correct square board at all widths */\n.board {aspect-ratio:1/1 !important;height:auto !important;border-radius:0 !important;grid-template-columns:repeat(8,minmax(0,1fr)) !important;grid-template-rows:repeat(8,minmax(0,1fr)) !important;}\n';
          return new Response(css,{status:200,headers});
        }
        return new Response(upstream.body,{status:200,headers});
      }catch(e){return new Response('Frontend temporarily unavailable: '+e.message,{status:503,headers:HEADERS});}
    }
    if(p==='/events'||p==='/health'||p==='/api'||p.startsWith('/api/')){
      const stub=env.ARENA.getByName('public-arena');
      return stub.fetch(request);
    }
    return json({error:'not found'},404);
  },
};
