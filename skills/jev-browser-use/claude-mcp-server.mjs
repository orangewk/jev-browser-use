#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createClaudeCodeSession } from './claude-adapter.mjs';
import { loadConfig } from './bridge.mjs';

const SAFE_COMMAND = /^[\w .:\\/@-]+(?:\.cmd|\.exe)?$/i;
const SAFE_PIPE = /^codex-browser-use(?:\\|-)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONSEQUENTIAL = /(?:\b(?:publish|post|send|reply|repost|retweet|quote|like|unlike|bookmark|follow|unfollow|subscribe|purchase|buy|pay|delete|remove|login|log in|sign in|logout|log out|sign out|verify|verification|2fa|two-factor|captcha|authorize|authorization|save|submit|confirm|create|update|edit|password|account|block|unblock|mute|unmute|report|dm|direct message)\b|投稿|ポスト|送信|返信|リプライ|リポスト|再投稿|引用|いいね|ブックマーク|フォロー|購読|購入|支払|削除|取り消し|ログイン|サインイン|ログアウト|認証|二要素|二段階|2段階|確認コード|キャプチャ|保存|確認|作成|更新|編集|パスワード|アカウント|ブロック|ミュート|報告|ダイレクトメッセージ)/i;
const WRAPPER_KEYS = new Set(['PageUp','PageDown']);
const tools = [
  {name:'jev_user_tabs',description:'List existing browser tabs available to claim.',inputSchema:{type:'object',properties:{}}},
  {name:'jev_claim_tab',description:'Claim one existing browser tab for bounded Jev operation.',inputSchema:{type:'object',properties:{tab_id:{type:'string'}},required:['tab_id']}},
  {name:'jev_browser_run',description:'Run the shared bounded Jev browser loop on a claimed tab. Text entry and consequential actions are not exposed.',inputSchema:{type:'object',properties:{tab_id:{type:'string'},goal:{type:'string'},allowed_origins:{type:'array',items:{type:'string'}},controls:{type:'array'},policy:{type:'object'},max_steps:{type:'integer',minimum:1,maximum:30},min_confidence:{type:'number',minimum:0.55,maximum:1}},required:['tab_id','goal','allowed_origins']}}
];

export function browserBridgeArgs(command,runDoctor=spawnSync) {
  const args=['--mode','mcp','--profile','basic'];
  try {
    const doctor=runDoctor(command,['--mode','doctor'],{
      encoding:'utf8',
      windowsHide:true,
      timeout:15000,
      shell:process.platform === 'win32' && /\.cmd$/i.test(command)
    });
    if (doctor.status !== 0) return args;
    const report=JSON.parse(doctor.stdout);
    const pipe=report?.pipes
      ?.filter(candidate=>candidate?.connected === true && SAFE_PIPE.test(candidate.name ?? ''))
      .sort((a,b)=>(a.latency_ms ?? Number.MAX_SAFE_INTEGER)-(b.latency_ms ?? Number.MAX_SAFE_INTEGER))[0]?.name;
    if (pipe) args.push('--pipe',pipe);
  } catch {}
  return args;
}

class BrowserMcpClient {
  constructor(command=process.env.CODEX_BROWSER_BRIDGE_COMMAND || 'codex-browser-bridge') {
    if (!SAFE_COMMAND.test(command)) throw new Error('Invalid CODEX_BROWSER_BRIDGE_COMMAND');
    this.child = spawn(command,browserBridgeArgs(command),{stdio:['pipe','pipe','inherit'],shell:process.platform === 'win32' && /\.cmd$/i.test(command)});
    this.pending = new Map();
    this.nextId = 1;
    createInterface({input:this.child.stdout}).on('line',line => {
      let message;
      try { message=JSON.parse(line); } catch { return; }
      const pending=this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error('Browser MCP request failed')) : pending.resolve(message.result);
    });
    this.child.on('exit',() => {
      for (const pending of this.pending.values()) pending.reject(new Error('Browser MCP exited'));
      this.pending.clear();
    });
  }
  request(method,params) {
    const id=this.nextId++;
    return new Promise((resolve,reject) => {
      this.pending.set(id,{resolve,reject});
      this.child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`);
    });
  }
  notify(method,params) { this.child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',method,params})}\n`); }
  async initialize() {
    await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'jev-browser-use',version:'0.1.0'}});
    this.notify('notifications/initialized',{});
  }
  callTool(name,args) { return this.request('tools/call',{name,arguments:args}); }
  close() { this.child.kill(); }
}

function assertString(value,name) {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
  return value;
}

function configuredOrigins(config) {
  const origins=config?.browser?.allowedOrigins;
  if (origins === undefined) throw new Error('Missing configured browser origins');
  if (!Array.isArray(origins) || !origins.length) throw new Error('Invalid configured browser origins');
  return origins.map(value => {
    if (typeof value !== 'string') throw new Error('Invalid configured browser origin');
    const url=new URL(value);
    if (url.origin !== value || !['https:','http:'].includes(url.protocol)) throw new Error('Invalid configured browser origin');
    return value;
  });
}

function enforceActor(config,env) {
  const allowed=config?.browser?.allowedActors;
  if (allowed === undefined) throw new Error('Missing configured browser actors');
  if (!Array.isArray(allowed) || !allowed.length || allowed.some(value=>typeof value !== 'string' || !value)) throw new Error('Invalid configured browser actors');
  const actor=env.JEV_BROWSER_ACTOR;
  if (!actor || !allowed.includes(actor)) throw new Error('Browser actor is not authorized');
  return actor;
}

function enforceOrigins(requested,config) {
  const configured=configuredOrigins(config);
  if (requested.some(origin=>!configured.includes(origin))) throw new Error('Browser origin is not authorized by host');
  return requested;
}

function toolText(result) {
  if (typeof result === 'string') return result;
  const value=result?.content?.filter(item=>item?.type === 'text').map(item=>item.text).join('\n');
  if (result?.isError || typeof value !== 'string' || !value) throw new Error('Browser transport returned no text');
  return value;
}

function originFromUrlText(value) {
  const match=value.match(/https?:\/\/[^\s"']+/);
  if (!match) throw new Error('Browser transport returned no URL');
  return new URL(match[0]).origin;
}

function filterUserTabs(result,config) {
  const configured=configuredOrigins(config);
  let tabs;
  try { tabs=JSON.parse(toolText(result)); } catch { throw new Error('Browser transport returned invalid tab list'); }
  if (!Array.isArray(tabs)) throw new Error('Browser transport returned invalid tab list');
  return tabs.filter(tab=>{
    try { return typeof tab?.url === 'string' && configured.includes(new URL(tab.url).origin); }
    catch { return false; }
  });
}

export async function handleJevTool(name,args,callTool,config=undefined,env=process.env) {
  config ??= await loadConfig();
  const actor=enforceActor(config,env);
  if (name === 'jev_user_tabs') return filterUserTabs(await callTool('codex_user_tabs',{}),config);
  if (name === 'jev_claim_tab') {
    const tabId=assertString(args?.tab_id,'tab_id');
    const configured=configuredOrigins(config);
    const claimed=await callTool('codex_claim_tab',{tab_id:tabId});
    try {
      const actual=originFromUrlText(toolText(await callTool('codex_get_url',{tab_id:tabId})));
      if (!configured.includes(actual)) throw new Error('Claimed tab origin is not authorized by host');
      return claimed;
    } catch (error) {
      try { await callTool('codex_finalize',{}); } catch {}
      throw error;
    }
  }
  if (name !== 'jev_browser_run') throw new Error('Unknown Jev browser tool');
  const tabId=assertString(args?.tab_id,'tab_id');
  const goal=assertString(args?.goal,'goal');
  if (!Array.isArray(args?.allowed_origins) || !args.allowed_origins.length) throw new Error('Invalid allowed_origins');
  const allowedOrigins=enforceOrigins(args.allowed_origins,config);
  const controls=args.controls ?? [];
  if (!Array.isArray(controls) || controls.some(control =>
    !control || !['click','scroll','reload','press'].includes(control.op) ||
    (control.op === 'click' && CONSEQUENTIAL.test(control.name ?? '')) ||
    (control.op === 'press' && !WRAPPER_KEYS.has(control.key)))) throw new Error('Unsafe Claude browser control');
  const requestedPolicy=args.policy ?? {click:true,scrollDirections:['down','up']};
  const policy={...requestedPolicy,keys:(requestedPolicy.keys ?? []).filter(key=>WRAPPER_KEYS.has(key)),requireCodexNames:[...(requestedPolicy.requireCodexNames ?? []),CONSEQUENTIAL]};
  const session=createClaudeCodeSession({tabId,callTool},{...config,allowedOrigins,maxSteps:args.max_steps ?? 10,minConfidence:args.min_confidence ?? 0.55});
  try {
    return {...await session.run({goal,controls,policy}),actor};
  } finally {
    try { await callTool('codex_finalize',{}); } catch {}
  }
}

function content(value) { return {content:[{type:'text',text:typeof value === 'string' ? value : JSON.stringify(value)}]}; }

async function main() {
  let browser;
  const getBrowser=async() => {
    if (!browser) { browser=new BrowserMcpClient(); await browser.initialize(); }
    return browser;
  };
  const input=createInterface({input:process.stdin});
  input.on('line',async line => {
    let request;
    try { request=JSON.parse(line); } catch { return; }
    if (request.id === undefined) return;
    let result;
    try {
      if (request.method === 'initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'jev-browser-use',version:'0.1.0'}};
      else if (request.method === 'tools/list') result={tools};
      else if (request.method === 'tools/call') {
        const client=await getBrowser();
        result=content(await handleJevTool(request.params?.name,request.params?.arguments ?? {},(name,args)=>client.callTool(name,args)));
      } else throw new Error('Method not found');
      process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:request.id,result})}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'Jev browser request failed'}],isError:true}})}\n`);
    }
  });
  input.on('close',() => browser?.close());
  process.on('exit',() => browser?.close());
}

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1').replaceAll('/','\\').toLowerCase() === process.argv[1].toLowerCase()) main();
