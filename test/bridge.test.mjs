import assert from 'node:assert/strict';
import { createSession, availableActions, discoverActions, run } from '../skills/jev-browser-use/bridge.mjs';
import { createClaudeCodeSession } from '../skills/jev-browser-use/claude-adapter.mjs';
import { handleJevTool } from '../skills/jev-browser-use/claude-mcp-server.mjs';
import { chromeCandidates, profileDirectory } from '../skills/jev-browser-use/start-windows-profile.mjs';

const state = (url = 'https://chatgpt.com/') => `Browser tab: Chat URL: "${url}".\n0 button Description: Next`;
function transport(states = [state()]) {
  let reads = 0; const calls = [];
  return { calls, getAXState: async () => states[Math.min(reads++, states.length - 1)], click: async (i) => calls.push(['click', i]), scroll: async (...a) => calls.push(['scroll', ...a]), pressKey: async (k) => calls.push(['pressKey', k]), reload: async () => calls.push(['reload']) };
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
  const callTool=async(name,args)=>{calls.push([name,args]); return {content:[{type:'text',text:'[]'}]};};
  await handleJevTool('jev_user_tabs',{},callTool,{});
  await handleJevTool('jev_claim_tab',{tab_id:'9'},callTool,{});
  assert.deepEqual(calls.map(([name])=>name),['codex_user_tabs','codex_claim_tab']);
  assert.deepEqual(calls[1][1],{tab_id:'9'});
  await assert.rejects(()=>handleJevTool('jev_browser_run',{tab_id:'9',goal:'like it',allowed_origins:['https://x.com'],controls:[{op:'click',name:'Like'}]},callTool,{}),/Unsafe Claude browser control/);
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
}

async function testWindowsProfilePaths() {
  const env={PROGRAMFILES:'C:\\Program Files',LOCALAPPDATA:'C:\\Users\\me\\AppData\\Local'};
  assert.equal(chromeCandidates(env)[0],'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(profileDirectory(env),'C:\\Users\\me\\AppData\\Local\\JevBrowser\\User Data');
  assert.equal(profileDirectory({...env,JEV_BROWSER_PROFILE_DIR:'D:\\Browser'}),'D:\\Browser');
}

for (const [name, fn] of [['shared loop',testSharedLoop],['stale state',testStaleState],['large snapshot',testLargeSnapshotCompaction],['bounds',testBounds],['credentials',testCredentials],['claude boundary',testClaudeBoundary],['host browser policy',testHostBrowserPolicy],['windows profile paths',testWindowsProfilePaths]]) {
  await fn(); console.log(`PASS ${name}`);
}
