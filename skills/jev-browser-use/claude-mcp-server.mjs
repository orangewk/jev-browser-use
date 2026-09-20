#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createClaudeCodeSession } from './claude-adapter.mjs';
import { loadConfig } from './bridge.mjs';

const SAFE_COMMAND = /^[\w .:\\/@-]+(?:\.cmd|\.exe)?$/i;
const CONSEQUENTIAL = /\b(publish|send|like|follow|subscribe|purchase|buy|pay|delete|remove|logout|log out|sign out|save|submit|confirm|create|update|edit|password|account)\b/i;
const WRAPPER_KEYS = new Set(['Escape','PageUp','PageDown','Home','End']);
const tools = [
  {name:'jev_user_tabs',description:'List existing browser tabs available to claim.',inputSchema:{type:'object',properties:{}}},
  {name:'jev_claim_tab',description:'Claim one existing browser tab for bounded Jev operation.',inputSchema:{type:'object',properties:{tab_id:{type:'string'}},required:['tab_id']}},
  {name:'jev_browser_run',description:'Run the shared bounded Jev browser loop on a claimed tab. Text entry and consequential actions are not exposed.',inputSchema:{type:'object',properties:{tab_id:{type:'string'},goal:{type:'string'},allowed_origins:{type:'array',items:{type:'string'}},controls:{type:'array'},policy:{type:'object'},max_steps:{type:'integer',minimum:1,maximum:30},min_confidence:{type:'number',minimum:0.55,maximum:1}},required:['tab_id','goal','allowed_origins']}}
];

class BrowserMcpClient {
  constructor(command=process.env.CODEX_BROWSER_BRIDGE_COMMAND || 'codex-browser-bridge') {
    if (!SAFE_COMMAND.test(command)) throw new Error('Invalid CODEX_BROWSER_BRIDGE_COMMAND');
    this.child = spawn(command,['--mode','mcp','--profile','basic'],{stdio:['pipe','pipe','inherit'],shell:process.platform === 'win32'});
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
  if (origins === undefined) return null;
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
  if (allowed === undefined) return env.JEV_BROWSER_ACTOR || 'unspecified';
  if (!Array.isArray(allowed) || !allowed.length || allowed.some(value=>typeof value !== 'string' || !value)) throw new Error('Invalid configured browser actors');
  const actor=env.JEV_BROWSER_ACTOR;
  if (!actor || !allowed.includes(actor)) throw new Error('Browser actor is not authorized');
  return actor;
}

function enforceOrigins(requested,config) {
  const configured=configuredOrigins(config);
  if (!configured) return requested;
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
  if (!configured) return result;
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
    const claimed=await callTool('codex_claim_tab',{tab_id:tabId});
    const configured=configuredOrigins(config);
    if (configured) {
      const actual=originFromUrlText(toolText(await callTool('codex_get_url',{tab_id:tabId})));
      if (!configured.includes(actual)) throw new Error('Claimed tab origin is not authorized by host');
    }
    return claimed;
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
  return {...await session.run({goal,controls,policy}),actor};
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
  process.on('exit',() => browser?.close());
}

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1').replaceAll('/','\\').toLowerCase() === process.argv[1].toLowerCase()) main();
