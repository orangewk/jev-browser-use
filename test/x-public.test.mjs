import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { handleXPublicTool } from '../skills/jev-browser-use/x-public.mjs';
import { browserBridgeArgs, handleJevTool } from '../skills/jev-browser-use/claude-mcp-server.mjs';

const root = mkdtempSync(join(tmpdir(),'jev-x-public-'));
const instance = '11111111-1111-4111-8111-111111111111';
const env = {JEV_BROWSER_ACTOR:'shii'};
let sequence = 0;
function fixture() {
  const directory=join(root,String(++sequence)); mkdirSync(directory);
  const policy={browserInstance:instance,allowedOrigins:['https://x.com'],maxSteps:30,xPosting:{account:'xi_id_room',room:directory,stateDirectory:join(directory,'state'),uploadBase:directory}};
  const config={browser:{actors:{shii:policy,claude:{allowedOrigins:['https://x.com'],maxSteps:30}}}};
  const state={url:'https://x.com/home',account:'/xi_id_room',editor:null,submit:null,images:0,contextLinks:[],links:[],toastLinks:[],posts:[]};
  const fake={state,instance,publishes:0,unknown:false,noContext:false};
  const result=value=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]});
  const call=async(name,args)=>{
    if(name==='codex_get_info')return result({bridge:{selectedBrowser:{instance_id:fake.instance}}});
    if(name==='codex_get_url')return result(state.url);
    if(name==='codex_evaluate')return result({result:{type:'object',value:state}});
    if(name==='codex_navigate'){
      state.url=args.url; state.editor='\n'; state.images=0; state.toastLinks=[]; state.submit={testId:'tweetButton',disabled:true};
      const u=new URL(args.url); const id=u.searchParams.get('in_reply_to'); const quote=u.searchParams.get('attachment_url');
      state.contextLinks=fake.noContext?[]:id?[`https://x.com/other/status/${id}`]:quote?[quote]:[];
      return result('navigated');
    }
    if(name==='codex_wait_for_element')return result('ready');
    if(name==='codex_cua_type'){state.editor=args.text;state.submit.disabled=false;return result('typed');}
    if(name==='codex_file_input'){state.images=args.files.length;state.submit.disabled=false;return result('attached');}
    if(name==='codex_click'){
      if(args.selector.includes('tweetTextarea'))return result('focused');
      fake.publishes++;
      if(fake.unknown)throw new Error('response lost');
      state.toastLinks=['https://x.com/xi_id_room/status/200'];state.editor=null;state.submit=null;
      return result('clicked');
    }
    if(name==='codex_dom_snapshot')return result({nodes:[]});
    if(name==='codex_screenshot')return{content:[{type:'image',mimeType:'image/jpeg',data:'aW1hZ2U='}]};
    throw new Error(`Unexpected fake tool ${name}`);
  };
  return {fake,config,policy,directory,call,run:(name,args)=>handleXPublicTool(name,{tab_id:'7',...args},call,config,env,{wait:async()=>{}})};
}
const payload = value=>JSON.parse(value.content[0].text);
try {
  const f=fixture();
  const prepare={request_id:'one',text:'自分の言葉'};
  assert.equal(payload(await f.run('jev_x_prepare',prepare)).status,'prepared');
  assert.equal(payload(await f.run('jev_x_publish',{request_id:'one'})).url,'https://x.com/xi_id_room/status/200');
  assert.equal(payload(await f.run('jev_x_publish',{request_id:'one'})).status,'posted');
  assert.equal(f.fake.publishes,1,'同じrequest_idは一回だけ投稿');
  assert.ok(!readFileSync(join(f.directory,'state/one.json'),'utf8').includes('自分の言葉'),'台帳は本文を保持しない');

  for(const kind of ['reply','quote']){
    const t=fixture();
    const p=payload(await t.run('jev_x_prepare',{request_id:kind,text:'公開の返事',kind,target_url:'https://x.com/other/status/100'}));
    assert.equal(p.kind,kind);
    assert.equal(payload(await t.run('jev_x_publish',{request_id:kind})).status,'posted');
  }
  const mismatch=fixture(); mismatch.fake.state.account='/orangewk';
  await assert.rejects(()=>mismatch.run('jev_x_prepare',prepare),/account mismatch/);
  assert.equal(mismatch.fake.publishes,0);
  const swapped=fixture(); swapped.fake.instance='another-instance';
  await assert.rejects(()=>swapped.run('jev_x_prepare',prepare),/Dedicated X browser/);
  const changed=fixture(); await changed.run('jev_x_prepare',prepare); changed.fake.state.editor='changed by another tab';
  await assert.rejects(()=>changed.run('jev_x_publish',{request_id:'one'}),/Draft changed/);
  const accountChanged=fixture(); await accountChanged.run('jev_x_prepare',prepare);accountChanged.fake.state.account='/orangewk';
  await assert.rejects(()=>accountChanged.run('jev_x_publish',{request_id:'one'}),/account mismatch/);
  assert.equal(accountChanged.fake.publishes,0);
  const unknown=fixture();await unknown.run('jev_x_prepare',prepare);unknown.fake.unknown=true;
  assert.equal(payload(await unknown.run('jev_x_publish',{request_id:'one'})).status,'unknown');
  assert.equal(payload(await unknown.run('jev_x_publish',{request_id:'one'})).status,'unknown');
  assert.equal(unknown.fake.publishes,1,'応答不明を再投稿しない');
  unknown.fake.state.posts=[{text:prepare.text,links:['https://x.com/xi_id_room/status/300']}];
  assert.equal(payload(await unknown.run('jev_x_status',{request_id:'one'})).url,'https://x.com/xi_id_room/status/300');
  const context=fixture();context.fake.noContext=true;
  await assert.rejects(()=>context.run('jev_x_prepare',{...prepare,kind:'reply',target_url:'https://x.com/other/status/100'}),/context was not confirmed/);
  const image=fixture();writeFileSync(join(image.directory,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=','base64'));
  assert.equal(payload(await image.run('jev_x_prepare',{request_id:'image',text:'',images:['pixel.png']})).images,1);
  const viewed=await image.run('jev_x_view',{image:true});assert.equal(viewed.content.at(-1).type,'image');
  const invalid=fixture();writeFileSync(join(invalid.directory,'not-image.png'),'not an image');
  await assert.rejects(()=>invalid.run('jev_x_prepare',{...prepare,images:['not-image.png']}),/Only PNG/);
  await assert.rejects(()=>invalid.run('jev_x_prepare',{...prepare,images:[join(root,'outside.png')]}));
  await assert.rejects(()=>handleXPublicTool('jev_x_prepare',{tab_id:'7',...prepare},invalid.call,invalid.config,{JEV_BROWSER_ACTOR:'claude'}),/not configured/);
  const args=browserBridgeArgs('bridge.exe',()=>{throw new Error('must not choose fastest pipe');},env,f.config);
  assert.ok(args.includes(instance));assert.ok(!args.includes('--pipe'));assert.ok(args.includes('--upload-base'));
  assert.throws(()=>browserBridgeArgs('bridge.exe',()=>{},env,{browser:{actors:{shii:{xPosting:{}}}}}),/instance is required/);
  await assert.rejects(()=>handleJevTool('jev_claim_tab',{tab_id:'7'},f.call,f.config,env),/expected_title/);
  console.log('X public tools: post/reply/quote, account/instance, draft race, uncertainty/dedup, images, actor and v2 binding passed; model calls 0');
} finally {
  // Only this run's freshly generated fixture directory; never a user directory.
  assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
  rmSync(root,{recursive:true});
}
