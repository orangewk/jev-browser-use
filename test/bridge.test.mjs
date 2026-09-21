import assert from 'node:assert/strict';
import { createActorSession, createSession, availableActions, discoverActions, resolveBrowserPolicy, run } from '../skills/jev-browser-use/bridge.mjs';
import { createClaudeCodeSession } from '../skills/jev-browser-use/claude-adapter.mjs';
import { BrowserMcpClient, browserBridgeArgs, handleJevTool } from '../skills/jev-browser-use/claude-mcp-server.mjs';
import { chromeCandidates, profileDirectory } from '../skills/jev-browser-use/start-windows-profile.mjs';

const state = (url = 'https://chatgpt.com/') => `Browser tab: Chat URL: "${url}".\n0 button Description: Next`;
function transport(states = [state()]) {
  let reads = 0; const calls = [];
  return { calls, getAXState: async () => states[Math.min(reads++, states.length - 1)], click: async (i) => calls.push(['click', i]), navigate: async url => calls.push(['navigate',url]), scroll: async (...a) => calls.push(['scroll', ...a]), pressKey: async (...a) => calls.push(['pressKey', ...a]), reload: async () => calls.push(['reload']) };
}
function claudeTransport(url='https://chatgpt.com/') {
  const calls=[];
  const tree={nodes:[{role:{value:'button'},name:{value:'Next'},backendDOMNodeId:42}]};
  return {
    calls,
    callTool:async(name,args) => {
      calls.push([name,args]);
      if(name==='codex_get_url') return {content:[{type:'text',text:url}]};
      if(name==='codex_dom_snapshot') return {content:[{type:'text',text:JSON.stringify(tree)}]};
      return {content:[{type:'text',text:'ok'}]};
    }
  };
}
function response(choice = 'DONE') { return new Response(JSON.stringify({ model:'jev-latest', answers:{next:{type:'choice',choice,confidence:1,probabilities:{a0: choice==='a0'?1:0,DONE: choice==='DONE'?1:0,BLOCKED:0,WAIT:0}}}}), {status:200}); }

async function testSharedLoop() {
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'secret-test-key';
  const oldFetch = globalThis.fetch; globalThis.fetch = async () => response();
  try {
    const codex = transport(); const claude = claudeTransport();
    const a = await createSession(codex, { provider:'typesafe', allowedOrigins:['https://chatgpt.com'], maxSteps:1 }).run({goal:'stop', controls:[{op:'click',name:'Next'}]});
    const b = await createClaudeCodeSession({tabId:'7',callTool:claude.callTool}, { provider:'typesafe', allowedOrigins:['https://chatgpt.com'], maxSteps:1 }).run({goal:'stop', controls:[{op:'click',name:'Next'}]});
    assert.equal(a.status, 'needs_verification'); assert.equal(b.status, a.status);
    assert.equal(claude.calls.filter(([name])=>name==='codex_dom_snapshot').length,2); assert.equal(b.sessionMetrics.decisions, a.sessionMetrics.decisions);
  } finally { globalThis.fetch = oldFetch; if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; }
}

async function testStaleState() {
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='secret'; const oldFetch=globalThis.fetch; globalThis.fetch=async()=>response('a0');
  try { const t=transport([state(), state('https://chatgpt.com/?fresh=1')]); const out=await run(t,{goal:'x',controls:[{op:'click',name:'Next'}],provider:'typesafe',allowedOrigins:['https://chatgpt.com'],maxSteps:1}); assert.equal(out.history[0].reason,'stale_state'); assert.equal(t.calls.length,0); } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; }
}

async function testPageScrollContract() {
  const old=process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='secret'; const oldFetch=globalThis.fetch; globalThis.fetch=async()=>response('a0');
  try {
    const codex=transport();
    const a=await run(codex,{goal:'scroll',policy:{scrollDirections:['down']},provider:'typesafe',allowedOrigins:['https://chatgpt.com'],maxSteps:1});
    assert.equal(a.history[0].executed,true);
    assert.deepEqual(codex.calls,[['pressKey',null,'PageDown']]);
    const claude=claudeTransport();
    const b=await createClaudeCodeSession({tabId:'7',callTool:claude.callTool},{provider:'typesafe',allowedOrigins:['https://chatgpt.com'],maxSteps:1}).run({goal:'scroll',policy:{scrollDirections:['down']}});
    assert.equal(b.history[0].executed,true);
    assert.deepEqual(claude.calls.find(([name])=>name==='codex_cua_scroll')?.[1],{tab_id:'7',x:500,y:500,scroll_x:0,scroll_y:600});
  } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; }
}

async function testLargeSnapshotCompaction() {
  const old=process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='secret';
  const oldFetch=globalThis.fetch; let sent;
  globalThis.fetch=async(_url,options)=>{sent=JSON.parse(options.body); return response();};
  const large=`${state()}\nJev article visible\n${'unrelated page text\n'.repeat(3000)}`;
  try {
    const out=await run(transport([large]),{goal:'Jev article visible',controls:[{op:'click',name:'Next'}],provider:'typesafe',allowedOrigins:['https://chatgpt.com'],maxSteps:1});
    assert.equal(out.status,'needs_verification');
    assert.ok(sent.state.browser.length<=24000);
    assert.match(sent.state.browser,/Jev article visible/);
  } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; }
}

async function testBounds() { assert.throws(()=>availableActions(state(),[{op:'press',key:'A'}]),/Unsupported action/); assert.deepEqual(discoverActions(state(),{click:true}).map(a=>a.name),['Next']); await assert.rejects(()=>run(transport([state('https://evil.test/')]), {goal:'x',controls:[{op:'click',name:'Next'}],allowedOrigins:['https://chatgpt.com']}),/authorized origins/); }
async function testCredentials() { const old=process.env.TYPESAFE_API_KEY; delete process.env.TYPESAFE_API_KEY; await assert.rejects(()=>import('../skills/jev-browser-use/bridge.mjs').then(m=>m.decide({provider:'typesafe',goal:'x',state:state(),actions:[]})),/TYPESAFE_API_KEY is missing/); process.env.TYPESAFE_API_KEY='super-secret'; const oldFetch=globalThis.fetch; globalThis.fetch=async()=>{throw new Error('leak super-secret')}; try { await assert.rejects(()=>import('../skills/jev-browser-use/bridge.mjs').then(m=>m.decide({provider:'typesafe',goal:'x',state:state(),actions:[]})),/transport failure or timeout/); } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; } }

async function testClaudeBoundary() {
  const calls=[];
  const callTool=async(name,args)=>{calls.push([name,args]); return {content:[{type:'text',text:name==='codex_get_url'?'https://x.com/home':'[]'}]};};
  const config={browser:{allowedOrigins:['https://x.com'],allowedActors:['shii']}};
  const env={JEV_BROWSER_ACTOR:'shii'};
  await handleJevTool('jev_user_tabs',{},callTool,config,env);
  await handleJevTool('jev_claim_tab',{tab_id:'9'},callTool,config,env);
  assert.deepEqual(calls.map(([name])=>name),['codex_user_tabs','codex_claim_tab','codex_get_url']);
  assert.deepEqual(calls[1][1],{tab_id:'9'});
  await assert.rejects(()=>handleJevTool('jev_browser_run',{tab_id:'9',goal:'like it',allowed_origins:['https://x.com'],controls:[{op:'click',name:'Like'}]},callTool,config,env),/Unsafe Claude browser control/);
  await assert.rejects(()=>handleJevTool('jev_browser_run',{tab_id:'9',goal:'post it',allowed_origins:['https://x.com'],controls:[{op:'click',name:'ポストする'}]},callTool,config,env),/Unsafe Claude browser control/);
}

async function testNavigationControl() {
  const url='https://x.com/i/communities';
  const old=process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='secret'; const oldFetch=globalThis.fetch; globalThis.fetch=async()=>response('a0');
  const config={browser:{allowedOrigins:['https://x.com'],allowedActors:['shii']}};
  const calls=[];
  const callTool=async(name,args)=>{
    calls.push([name,args]);
    if(name==='codex_get_url') return {content:[{type:'text',text:'https://x.com/home'}]};
    if(name==='codex_dom_snapshot') return {content:[{type:'text',text:JSON.stringify({nodes:[]})}]};
    return {content:[{type:'text',text:'ok'}]};
  };
  try {
    await handleJevTool('jev_browser_run',{tab_id:'9',goal:'open communities',controls:[{op:'navigate',url}],policy:{},max_steps:1},callTool,config,{JEV_BROWSER_ACTOR:'shii'});
    assert.deepEqual(calls.find(([name])=>name==='codex_navigate'),['codex_navigate',{tab_id:'9',url}]);
  } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; }

  const blockedCalls=[];
  await assert.rejects(()=>handleJevTool('jev_browser_run',{tab_id:'9',goal:'open elsewhere',controls:[{op:'navigate',url:'https://example.com/'}],max_steps:1},async(name,args)=>{blockedCalls.push([name,args]);},config,{JEV_BROWSER_ACTOR:'shii'}),/navigation origin is not authorized/);
  assert.deepEqual(blockedCalls,[]);
  const direct=transport();
  await assert.rejects(()=>run(direct,{goal:'open elsewhere',controls:[{op:'navigate',url:'https://example.com/'}],allowedOrigins:['https://x.com']}),/navigation origin is not authorized/);
  assert.deepEqual(direct.calls,[]);
}

async function testLocalizedConsequentialDiscovery() {
  const old=process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='secret';
  const oldFetch=globalThis.fetch;
  const calls=[];
  globalThis.fetch=async(_url,options)=>{
    const criteria=JSON.parse(options.body).questions.next.criteria;
    assert.deepEqual(Object.keys(criteria).sort(),['BLOCKED','DONE','WAIT']);
    return new Response(JSON.stringify({model:'jev-latest',answers:{next:{type:'choice',choice:'DONE',confidence:1,probabilities:{DONE:1,BLOCKED:0,WAIT:0}}}}),{status:200});
  };
  const callTool=async(name,args)=>{
    calls.push([name,args]);
    if(name==='codex_get_url') return {content:[{type:'text',text:'https://x.com/home'}]};
    if(name==='codex_dom_snapshot') return {content:[{type:'text',text:JSON.stringify({nodes:[{role:{value:'button'},name:{value:'ポストする'},backendDOMNodeId:42}]})}]};
    return {content:[{type:'text',text:'ok'}]};
  };
  try {
    const out=await handleJevTool('jev_browser_run',{tab_id:'9',goal:'read posts',allowed_origins:['https://x.com'],policy:{click:true},max_steps:1},callTool,{browser:{allowedOrigins:['https://x.com'],allowedActors:['shii']}},{JEV_BROWSER_ACTOR:'shii'});
    assert.equal(out.status,'needs_verification');
    assert.equal(calls.some(([name])=>name==='codex_cua_click'),false);
  } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; }
}

async function testAuthenticationAndMessagingControls() {
  const controls=['Log in','Verify with 2FA','Send direct message','Vote','Agree','Accept','Join','ログイン','二段階認証','ダイレクトメッセージ','投票','同意','承諾','参加'].map(name=>({op:'click',name}));
  controls.push({op:'click',name:'Next',aliases:['Post']});
  for (const control of controls) {
    await assert.rejects(
      ()=>handleJevTool('jev_browser_run',{tab_id:'9',goal:'read',allowed_origins:['https://x.com'],controls:[control],max_steps:1},async()=>{}, {browser:{allowedOrigins:['https://x.com'],allowedActors:['shii']}},{JEV_BROWSER_ACTOR:'shii'}),
      /Unsafe Claude browser control/,
    );
  }
}

async function testClaudeRequestTimeout() {
  const client=Object.create(BrowserMcpClient.prototype);
  client.child={stdin:{write(){}}};
  client.pending=new Map();
  client.nextId=1;
  client.requestTimeoutMs=5;
  await assert.rejects(()=>client.request('tools/list',{}),/timed out/);
  assert.equal(client.pending.size,0);
}

async function testHostBrowserPolicy() {
  const calls=[];
  const callTool=async(name,args)=>{
    calls.push([name,args]);
    if(name==='codex_get_url') return {content:[{type:'text',text:'https://x.com/home'}]};
    if(name==='codex_user_tabs') return {content:[{type:'text',text:JSON.stringify([
      {id:'9',url:'https://x.com/home',title:'X'},
      {id:'10',url:'https://mail.google.com/mail/u/0/',title:'Mail'}
    ])}]};
    return {content:[{type:'text',text:'ok'}]};
  };
  const config={browser:{allowedOrigins:['https://x.com'],allowedActors:['claude']}};
  await handleJevTool('jev_claim_tab',{tab_id:'9'},callTool,config,{JEV_BROWSER_ACTOR:'claude'});
  assert.deepEqual(calls.map(([name])=>name),['codex_claim_tab','codex_get_url']);
  const tabs=await handleJevTool('jev_user_tabs',{},callTool,config,{JEV_BROWSER_ACTOR:'claude'});
  assert.deepEqual(tabs,[{id:'9',url:'https://x.com/home',title:'X'}]);
  await assert.rejects(()=>handleJevTool('jev_browser_run',{tab_id:'9',goal:'read',allowed_origins:['https://mail.google.com']},callTool,config,{JEV_BROWSER_ACTOR:'claude'}),/not authorized by host/);
  await assert.rejects(()=>handleJevTool('jev_user_tabs',{},callTool,config,{JEV_BROWSER_ACTOR:'unknown'}),/actor is not authorized/);
  await assert.rejects(()=>handleJevTool('jev_user_tabs',{},callTool,{browser:{allowedActors:['claude']}},{JEV_BROWSER_ACTOR:'claude'}),/configured browser origins/);
  await assert.rejects(()=>handleJevTool('jev_user_tabs',{},callTool,{browser:{allowedOrigins:['https://x.com']}},{}),/actor is not authorized/);

  calls.length=0;
  const wrongOrigin=async(name,args)=>{
    calls.push([name,args]);
    if(name==='codex_get_url') return {content:[{type:'text',text:'https://example.com/'}]};
    return {content:[{type:'text',text:'ok'}]};
  };
  await assert.rejects(()=>handleJevTool('jev_claim_tab',{tab_id:'9'},wrongOrigin,config,{JEV_BROWSER_ACTOR:'claude'}),/not authorized by host/);
  assert.equal(calls.at(-1)[0],'codex_finalize');
}

async function testActorBrowserPolicy() {
  const config={browser:{actors:{
    codex:{allowedOrigins:['https://x.com','https://example.com'],maxSteps:30},
    shii:{allowedOrigins:['https://x.com'],maxSteps:2}
  }}};
  assert.deepEqual(resolveBrowserPolicy(config,'shii'),{allowedOrigins:['https://x.com'],maxSteps:2});
  assert.throws(()=>resolveBrowserPolicy(config,'unknown'),/not authorized/);
  const direct=createActorSession(transport(),config,'shii');
  await assert.rejects(()=>direct.run({goal:'read',policy:{click:true},allowedOrigins:['https://example.com']}),/origin is not authorized/);
  await assert.rejects(()=>direct.run({goal:'read',policy:{click:true},maxSteps:3}),/maxSteps is not authorized/);

  const calls=[];
  const callTool=async(name,args)=>{
    calls.push([name,args]);
    if(name==='codex_user_tabs') return {content:[{type:'text',text:JSON.stringify([
      {id:'9',url:'https://x.com/home',title:'X'},
      {id:'10',url:'https://example.com/',title:'Example'}
    ])}]};
    if(name==='codex_get_url') return {content:[{type:'text',text:'https://x.com/home'}]};
    if(name==='codex_dom_snapshot') return {content:[{type:'text',text:JSON.stringify({nodes:[{role:{value:'button'},name:{value:'Next'},backendDOMNodeId:42}]})}]};
    return {content:[{type:'text',text:'ok'}]};
  };
  assert.deepEqual(await handleJevTool('jev_user_tabs',{},callTool,config,{JEV_BROWSER_ACTOR:'shii'}),[{id:'9',url:'https://x.com/home',title:'X'}]);
  await assert.rejects(()=>handleJevTool('jev_browser_run',{tab_id:'9',goal:'read',max_steps:3},callTool,config,{JEV_BROWSER_ACTOR:'shii'}),/max_steps is not authorized/);
  const old=process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='secret';
  const oldFetch=globalThis.fetch; globalThis.fetch=async(_url,options)=>{
    const criteria=JSON.parse(options.body).questions.next.criteria;
    const probabilities=Object.fromEntries(Object.keys(criteria).map(key=>[key,key==='DONE'?1:0]));
    return new Response(JSON.stringify({model:'jev-latest',answers:{next:{type:'choice',choice:'DONE',confidence:1,probabilities}}}),{status:200});
  };
  try {
    const out=await handleJevTool('jev_browser_run',{tab_id:'9',goal:'read',max_steps:1},callTool,config,{JEV_BROWSER_ACTOR:'shii'});
    assert.equal(out.status,'needs_verification');
  } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; }
}

async function testDynamicPageScroll() {
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='secret'; const oldFetch=globalThis.fetch; globalThis.fetch=async()=>response('a0');
  try {
    const first=`${state()}\nDynamic item A`;
    const refreshed=`${state()}\nDynamic item B`;
    const t=transport([first,refreshed,refreshed]);
    const out=await run(t,{goal:'scroll once',controls:[{op:'scroll',direction:'down'}],provider:'typesafe',allowedOrigins:['https://chatgpt.com'],maxSteps:1});
    assert.equal(out.history[0].executed,true);
    assert.deepEqual(t.calls,[['pressKey',null,'PageDown']]);
  } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; }
}

async function testClaudeFinalizesRun() {
  const old=process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='secret';
  const oldFetch=globalThis.fetch; globalThis.fetch=async()=>response();
  const calls=[];
  const callTool=async(name,args)=>{
    calls.push([name,args]);
    if(name==='codex_get_url') return {content:[{type:'text',text:'https://x.com/home'}]};
    if(name==='codex_dom_snapshot') return {content:[{type:'text',text:JSON.stringify({nodes:[]})}]};
    return {content:[{type:'text',text:'ok'}]};
  };
  try {
    await handleJevTool('jev_browser_run',{tab_id:'9',goal:'stop',allowed_origins:['https://x.com'],max_steps:1},callTool,{browser:{allowedOrigins:['https://x.com'],allowedActors:['claude']}},{JEV_BROWSER_ACTOR:'claude'});
    assert.equal(calls.at(-1)[0],'codex_finalize');
  } finally { globalThis.fetch=oldFetch; if(old===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=old; }
}

async function testWindowsProfilePaths() {
  const env={PROGRAMFILES:'C:\\Program Files',LOCALAPPDATA:'C:\\Users\\me\\AppData\\Local'};
  assert.equal(chromeCandidates(env)[0],'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(profileDirectory(env),'C:\\Users\\me\\AppData\\Local\\JevBrowser\\User Data');
  assert.equal(profileDirectory({...env,JEV_BROWSER_PROFILE_DIR:'D:\\Browser'}),'D:\\Browser');
}

async function testClaudePipeRecovery() {
  const healthy='codex-browser-use\\13dec2d3-c5bb-44c8-b2c1-5f73825c7d5e';
  const args=browserBridgeArgs('bridge.exe',()=>({
    status:0,
    stdout:JSON.stringify({pipes:[
      {name:'codex-browser-use-deadbeef-dead-beef-dead-beefdeadbeef',connected:false,latency_ms:null},
      {name:healthy,connected:true,latency_ms:2}
    ]})
  }));
  assert.deepEqual(args,['--mode','mcp','--profile','basic','--pipe',healthy]);
  assert.deepEqual(browserBridgeArgs('bridge.exe',()=>({status:1,stdout:''})),['--mode','mcp','--profile','basic']);
  assert.deepEqual(browserBridgeArgs('bridge.exe',()=>({status:0,stdout:'not json'})),['--mode','mcp','--profile','basic']);
}

for (const [name, fn] of [['shared loop',testSharedLoop],['stale state',testStaleState],['dynamic page scroll',testDynamicPageScroll],['page scroll contract',testPageScrollContract],['large snapshot',testLargeSnapshotCompaction],['bounds',testBounds],['credentials',testCredentials],['claude boundary',testClaudeBoundary],['navigation control',testNavigationControl],['localized consequential discovery',testLocalizedConsequentialDiscovery],['authentication and messaging controls',testAuthenticationAndMessagingControls],['claude request timeout',testClaudeRequestTimeout],['host browser policy',testHostBrowserPolicy],['actor browser policy',testActorBrowserPolicy],['claude finalizes run',testClaudeFinalizesRun],['windows profile paths',testWindowsProfilePaths],['claude pipe recovery',testClaudePipeRecovery]]) {
  await fn(); console.log(`PASS ${name}`);
}
