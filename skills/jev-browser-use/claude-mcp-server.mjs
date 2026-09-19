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

export async function handleJevTool(name,args,callTool,config=undefined) {
  if (name === 'jev_user_tabs') return callTool('codex_user_tabs',{});
  if (name === 'jev_claim_tab') return callTool('codex_claim_tab',{tab_id:assertString(args?.tab_id,'tab_id')});
  if (name !== 'jev_browser_run') throw new Error('Unknown Jev browser tool');
  const tabId=assertString(args?.tab_id,'tab_id');
  const goal=assertString(args?.goal,'goal');
  if (!Array.isArray(args?.allowed_origins) || !args.allowed_origins.length) throw new Error('Invalid allowed_origins');
  const controls=args.controls ?? [];
  if (!Array.isArray(controls) || controls.some(control =>
    !control || !['click','scroll','reload','press'].includes(control.op) ||
    (control.op === 'click' && CONSEQUENTIAL.test(control.name ?? '')) ||
    (control.op === 'press' && !WRAPPER_KEYS.has(control.key)))) throw new Error('Unsafe Claude browser control');
  const requestedPolicy=args.policy ?? {click:true,scrollDirections:['down','up']};
  const policy={...requestedPolicy,keys:(requestedPolicy.keys ?? []).filter(key=>WRAPPER_KEYS.has(key)),requireCodexNames:[...(requestedPolicy.requireCodexNames ?? []),CONSEQUENTIAL]};
  config ??= await loadConfig();
  const session=createClaudeCodeSession({tabId,callTool},{...config,allowedOrigins:args.allowed_origins,maxSteps:args.max_steps ?? 10,minConfidence:args.min_confidence ?? 0.55});
  return session.run({goal,controls,policy});
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
