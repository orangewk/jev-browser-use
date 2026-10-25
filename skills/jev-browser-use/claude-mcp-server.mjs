#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createClaudeCodeSession } from './claude-adapter.mjs';
import { assertNavigationOrigins, loadConfig, resolveBrowserPolicy } from './bridge.mjs';
import { handleXPublicTool, X_TOOL_NAMES, X_TOOL_DEFINITIONS } from './x-public.mjs';

const SAFE_COMMAND = /^[\w .:\\/@-]+(?:\.cmd|\.exe)?$/i;
const SAFE_PIPE = /^codex-browser-use(?:\\|-)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CONSEQUENTIAL = /(?:\b(?:publish|post|send|reply|repost|retweet|quote|like|unlike|bookmark|follow|unfollow|subscribe|purchase|buy|pay|delete|remove|login|log in|sign in|logout|log out|sign out|verify|verification|2fa|two-factor|captcha|authorize|authorization|save|submit|confirm|create|update|edit|password|account|block|unblock|mute|unmute|report|dm|direct message|vote|agree|accept|join)\b|投稿|ポスト|送信|返信|リプライ|リポスト|再投稿|引用|いいね|ブックマーク|フォロー|購読|購入|支払|削除|取り消し|ログイン|サインイン|ログアウト|認証|二要素|二段階|2段階|確認コード|キャプチャ|保存|確認|作成|更新|編集|パスワード|アカウント|ブロック|ミュート|報告|ダイレクトメッセージ|投票|同意|承諾|参加)/i;
const DEFAULT_REQUEST_TIMEOUT_MS = 45000;
const WRAPPER_KEYS = new Set(['PageUp','PageDown']);
const BROWSER_CHROME_ENV = 'XI_ID_BROWSER_CHROME';
const BROWSER_PROFILE_ENV = 'XI_ID_BROWSER_PROFILE';
const BROWSER_CONFIG_ENV = 'XI_ID_BROWSER_CONFIG';
const tools = [
  {name:'jev_browser_open',description:'Open an authorized origin in the configured Chrome profile.',inputSchema:{type:'object',properties:{url:{type:'string'}}}},
  {name:'jev_user_tabs',description:'List existing browser tabs available to claim.',inputSchema:{type:'object',properties:{}}},
  {name:'jev_claim_tab',description:'Claim one existing browser tab. For the dedicated browser pass expected_title and expected_url exactly as returned by jev_user_tabs.',inputSchema:{type:'object',properties:{tab_id:{type:'string'},expected_title:{type:'string'},expected_url:{type:'string'}},required:['tab_id']}},
  {name:'jev_browser_run',description:'Run the shared bounded Jev browser loop for navigation. XI-ID itself uses jev_x_* for public X text, images and publishing.',inputSchema:{type:'object',properties:{tab_id:{type:'string'},goal:{type:'string'},allowed_origins:{type:'array',items:{type:'string'}},controls:{type:'array'},policy:{type:'object'},max_steps:{type:'integer',minimum:1,maximum:30},min_confidence:{type:'number',minimum:0.55,maximum:1}},required:['tab_id','goal']}},
  ...X_TOOL_DEFINITIONS,
];

export function browserBridgeArgs(command,runDoctor=spawnSync,env=process.env,config) {
  const actor = config?.browser?.actors?.[env.JEV_BROWSER_ACTOR];
  if (actor?.xPosting) {
    if (env.JEV_BROWSER_ACTOR !== 'shii' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(actor.browserInstance || '')) throw new Error('Dedicated browser instance is required');
    return ['--mode','mcp','--profile','network','--browser-instance',actor.browserInstance,'--upload-base',actor.xPosting.uploadBase];
  }
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

export class BrowserMcpClient {
  constructor(command=process.env.CODEX_BROWSER_BRIDGE_COMMAND || 'codex-browser-bridge',requestTimeoutMs=DEFAULT_REQUEST_TIMEOUT_MS,{spawnProcess=spawn,runDoctor=spawnSync,env=process.env,config}={}) {
    if (!SAFE_COMMAND.test(command)) throw new Error('Invalid CODEX_BROWSER_BRIDGE_COMMAND');
    this.command=command;
    this.spawnProcess=spawnProcess;
    this.runDoctor=runDoctor;
    this.env=env;
    this.config=config;
    this.child=null;
    this.pipe=null;
    this.nextId = 1;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connecting=null;
  }
  start(args,pipe) {
    const child=this.spawnProcess(this.command,args,{stdio:['pipe','pipe','inherit'],shell:process.platform === 'win32' && /\.cmd$/i.test(this.command)});
    const pending=new Map();
    this.child=child;
    this.pipe=pipe;
    createInterface({input:this.child.stdout}).on('line',line => {
      let message;
      try { message=JSON.parse(line); } catch { return; }
      const request=pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      message.error ? request.reject(new Error('Browser MCP request failed')) : request.resolve(message.result);
    });
    child.on('error',error => {
      if (this.child === child) { this.child=null; this.pipe=null; }
      this.rejectPending(pending,error);
    });
    child.on('exit',() => {
      if (this.child === child) { this.child=null; this.pipe=null; }
      this.rejectPending(pending,new Error('Browser MCP exited'));
    });
    child.pending=pending;
  }
  rejectPending(pending,error) {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(error); }
    pending.clear();
  }
  disconnect(child,error) {
    if (this.child === child) { this.child=null; this.pipe=null; }
    this.rejectPending(child.pending,error);
  }
  request(method,params) {
    const child=this.child;
    if (!child) return Promise.reject(new Error('Browser MCP is not connected'));
    const id=this.nextId++;
    return new Promise((resolve,reject) => {
      const timeout=setTimeout(() => {
        const error=new Error(`Browser MCP request timed out after ${this.requestTimeoutMs} ms`);
        if (this.child === child) {
          this.disconnect(child,error);
          child.kill();
        } else { child.pending.delete(id); reject(error); }
      },this.requestTimeoutMs);
      child.pending.set(id,{resolve,reject,timeout});
      try { child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`); }
      catch (error) {
        clearTimeout(timeout);
        if (this.child === child) { this.disconnect(child,error); child.kill(); }
        else child.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method,params) { this.child.stdin.write(`${JSON.stringify({jsonrpc:'2.0',method,params})}\n`); }
  async initializeBridge() {
    await this.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'jev-browser-use',version:'0.1.0'}});
    this.notify('notifications/initialized',{});
  }
  async ensureConnected() {
    if (this.connecting) return this.connecting;
    if (this.child) return;
    this.connecting=(async() => {
      const args=browserBridgeArgs(this.command,this.runDoctor,this.env,this.config);
      const pipeIndex=args.indexOf('--pipe');
      const pipe=pipeIndex < 0 ? null : args[pipeIndex+1];
      this.start(args,pipe);
      try { await this.initializeBridge(); }
      catch (error) { this.close(); throw error; }
    })();
    try { await this.connecting; } finally { this.connecting=null; }
  }
  async initialize() { await this.ensureConnected(); }
  async callTool(name,args) { await this.ensureConnected(); return this.request('tools/call',{name,arguments:args}); }
  close() {
    const child=this.child;
    this.child=null;
    this.pipe=null;
    if (child) { this.rejectPending(child.pending,new Error('Browser MCP exited')); child.kill(); }
  }
}

function resolveLaunchUrl(value,allowedOrigins) {
  const url=value === undefined || value === null || value === '' ? `${allowedOrigins[0]}/` : value;
  if (typeof url !== 'string') throw new Error('url must be a string');
  let parsed;
  try { parsed=new URL(url); } catch { throw new Error('url must be an absolute http(s) URL'); }
  if (!['http:','https:'].includes(parsed.protocol)) throw new Error('url must be an absolute http(s) URL');
  if (!allowedOrigins.includes(parsed.origin)) throw new Error(JSON.stringify({status:'origin_not_allowed',origin:parsed.origin,allowedOrigins}));
  return parsed.href;
}

export async function launchBrowser(args,{config,env=process.env,spawnProcess=spawn}={}) {
  const chrome=env[BROWSER_CHROME_ENV];
  const profile=env[BROWSER_PROFILE_ENV];
  if (!chrome || !profile) throw new Error(`Browser launcher needs both ${BROWSER_CHROME_ENV} and ${BROWSER_PROFILE_ENV}`);
  const {policy}=enforceActor(config,env);
  const url=resolveLaunchUrl(args?.url,policy.allowedOrigins);
  const child=spawnProcess(chrome,[`--profile-directory=${profile}`,'--no-default-browser-check',url],{detached:true,stdio:'ignore'});
  await new Promise((resolve,reject) => {
    const onError=error => { child.removeListener('spawn',onSpawn); reject(error); };
    const onSpawn=() => { child.removeListener('error',onError); resolve(); };
    child.once('error',onError);
    child.once('spawn',onSpawn);
  });
  child.unref?.();
  return {status:'launched',pid:child.pid,profile,url};
}

function assertString(value,name) {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
  return value;
}

function enforceActor(config,env) {
  const actor=env.JEV_BROWSER_ACTOR;
  return {actor,policy:resolveBrowserPolicy(config,actor)};
}

function enforceOrigins(requested,policy) {
  if (requested === undefined) return policy.allowedOrigins;
  if (!Array.isArray(requested) || !requested.length || requested.some(origin=>typeof origin !== 'string' || !policy.allowedOrigins.includes(origin))) throw new Error('Browser origin is not authorized by host');
  return requested;
}

function toolText(result, operation='operation') {
  if (typeof result === 'string') return result;
  const value=result?.content?.filter(item=>item?.type === 'text').map(item=>item.text).join('\n');
  if (result?.isError) {
    const kind=/stale|snapshot.*changed/i.test(value || '') ? 'tab snapshot changed; enumerate again' : /owned|ownership|another.*session|already part of/i.test(value || '') ? 'tab ownership unresolved; do not reclaim blindly' : /session.*invalid|invalid.*session|session.*not found|no session/i.test(value || '') ? 'CDP session invalid; inspect before retrying' : /timeout|timed out/i.test(value || '') ? 'timeout; outcome may be unknown' : 'bridge rejected operation';
    throw new Error(`Browser ${operation} failed: ${kind}`);
  }
  if (typeof value !== 'string' || !value) throw new Error(`Browser ${operation} returned no text`);
  return value;
}

function originFromUrlText(value) {
  const match=value.match(/https?:\/\/[^\s"']+/);
  if (!match) throw new Error('Browser transport returned no URL');
  return new URL(match[0]).origin;
}

function filterUserTabs(result,policy) {
  let tabs;
  try { tabs=JSON.parse(toolText(result)); } catch { throw new Error('Browser transport returned invalid tab list'); }
  if (!Array.isArray(tabs)) throw new Error('Browser transport returned invalid tab list');
  return tabs.filter(tab=>{
    try { return typeof tab?.url === 'string' && policy.allowedOrigins.includes(new URL(tab.url).origin); }
    catch { return false; }
  });
}

export async function handleJevTool(name,args,callTool,config=undefined,env=process.env,{spawnProcess=spawn}={}) {
  if (config === undefined) {
    const configPath=env[BROWSER_CONFIG_ENV];
    config=configPath ? JSON.parse(await readFile(configPath,'utf8')) : await loadConfig();
  }
  const {actor,policy:actorPolicy}=enforceActor(config,env);
  if (X_TOOL_NAMES.includes(name)) return handleXPublicTool(name,args,callTool,config,env);
  if (name === 'jev_browser_open') return launchBrowser(args,{config,env,spawnProcess});
  if (name === 'jev_user_tabs') return filterUserTabs(await callTool('codex_user_tabs',{}),actorPolicy);
  if (name === 'jev_claim_tab') {
    const tabId=assertString(args?.tab_id,'tab_id');
    const dedicated=config?.browser?.actors?.[actor]?.xPosting;
    if (dedicated && (typeof args.expected_title !== 'string' || typeof args.expected_url !== 'string')) throw new Error('Use expected_title and expected_url from jev_user_tabs when claiming the dedicated browser');
    const claimed=await callTool('codex_claim_tab',{tab_id:tabId,...(dedicated ? {expected_title:args.expected_title,expected_url:args.expected_url} : {})});
    toolText(claimed,'tab claim');
    try {
      const actual=originFromUrlText(toolText(await callTool('codex_get_url',{tab_id:tabId})));
      if (!actorPolicy.allowedOrigins.includes(actual)) throw new Error('Claimed tab origin is not authorized by host');
      return claimed;
    } catch (error) {
      try { await callTool('codex_finalize',{}); } catch {}
      throw error;
    }
  }
  if (name !== 'jev_browser_run') throw new Error('Unknown Jev browser tool');
  const tabId=assertString(args?.tab_id,'tab_id');
  const goal=assertString(args?.goal,'goal');
  const allowedOrigins=enforceOrigins(args?.allowed_origins,actorPolicy);
  const controls=args.controls ?? [];
  if (!Array.isArray(controls) || controls.some(control =>
    !control || !['click','navigate','scroll','reload','press'].includes(control.op) ||
    (control.op === 'navigate' && typeof control.url !== 'string') ||
    (control.op === 'click' && (
      (control.aliases !== undefined && (!Array.isArray(control.aliases) || control.aliases.some(alias=>typeof alias !== 'string'))) ||
      [control.name,...(control.aliases ?? [])].some(label=>CONSEQUENTIAL.test(label ?? ''))
    )) ||
    (control.op === 'press' && !WRAPPER_KEYS.has(control.key)))) throw new Error('Unsafe Claude browser control');
  assertNavigationOrigins(controls,allowedOrigins);
  const requestedPolicy=args.policy ?? {click:true,scrollDirections:['down','up']};
  const policy={...requestedPolicy,keys:(requestedPolicy.keys ?? []).filter(key=>WRAPPER_KEYS.has(key)),requireCodexNames:[...(requestedPolicy.requireCodexNames ?? []),CONSEQUENTIAL]};
  const maxSteps=args.max_steps ?? actorPolicy.maxSteps ?? 10;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > (actorPolicy.maxSteps ?? 30)) throw new Error('Browser max_steps is not authorized by host');
  const session=createClaudeCodeSession({tabId,callTool},{...config,allowedOrigins,maxSteps,minConfidence:args.min_confidence ?? 0.55});
  try {
    return {...await session.run({goal,controls,policy}),actor};
  } finally {
    if (!config?.browser?.actors?.[actor]?.xPosting) try { await callTool('codex_finalize',{}); } catch {}
  }
}

function content(value) { return Array.isArray(value?.content) ? {content:value.content,...(value.isError === undefined ? {} : {isError:value.isError})} : {content:[{type:'text',text:typeof value === 'string' ? value : JSON.stringify(value)}]}; }

async function main() {
  let browser;
  const getBrowser=async() => {
    if (!browser) { const path=process.env[BROWSER_CONFIG_ENV]; const config=path ? JSON.parse(await readFile(path,'utf8')) : await loadConfig(); browser=new BrowserMcpClient(undefined,undefined,{config}); await browser.initialize(); }
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
        const name=request.params?.name;
        if (name === 'jev_browser_open') result=content(await handleJevTool(name,request.params?.arguments ?? {},()=>{},undefined,process.env));
        else {
          const client=await getBrowser();
          result=content(await handleJevTool(name,request.params?.arguments ?? {},(tool,args)=>client.callTool(tool,args)));
        }
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
