import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { handleXPublicTool, X_PROFILE_EXPRESSION } from '../skills/jev-browser-use/x-public.mjs';
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
  const fake={state,instance,publishes:0,unknown:false,noContext:false,profile:{open:false,fields:{name:'シー',bio:'',location:'',website:''},images:[],buttons:['保存']},waits:0,typed:0,saves:0};
  const result=value=>({content:[{type:'text',text:typeof value==='string'?value:JSON.stringify(value)}]});
  const call=async(name,args)=>{
    if(fake.failTool===name) return {isError:true,content:[{type:'text',text:fake.failDetail || 'Timeout: test-only sensitive detail must not be exposed'}]};
    if(name==='codex_bring_to_front')return result('foreground');
    if(name==='codex_get_info')return result({bridge:{selectedBrowser:{instance_id:fake.instance}}});
    if(name==='codex_get_url')return result(state.url);
    if(name==='codex_evaluate')return result({result:{type:'object',value:args.expression===X_PROFILE_EXPRESSION?fake.profile:state}});
    if(name==='codex_navigate'){
      if(args.url.endsWith('/settings/profile')){state.url=args.url;fake.profile.open=true;return result('profile');}
      if(!args.url.includes('/compose/')) {fake.target=args.url;state.url=args.url;return result('target');}
      state.url=args.url; state.editor='\n'; state.images=0; state.toastLinks=[]; state.submit={testId:'tweetButton',disabled:true};
      const u=new URL(args.url); const id=u.searchParams.get('in_reply_to'); const quote=u.searchParams.get('attachment_url');
      state.contextLinks=fake.noContext?[]:id?[`https://x.com/other/status/${id}`]:quote?[quote]:[];
      if(fake.contextButtonsOnly && id){state.contextLinks=[];state.contextButtons=['返信先: @otherさん'];}
      return result('navigated');
    }
    if(name==='codex_wait_for_element'){fake.waits++; if(fake.waits<=(fake.slowWaits||0))return {isError:true,content:[{type:'text',text:'Timeout: not found after 5000ms'}]};return result('ready');}
    if(name==='codex_cua_type'){fake.typed++;state.editor=args.text;state.submit.disabled=false;return result('typed');}
    if(name==='codex_fill'){const k={displayName:'name',description:'bio',location:'location',url:'website'}[args.selector.match(/name="([^"]+)/)[1]];fake.profile.fields[k]=args.value;return result('filled');}
    if(name==='codex_file_input'){if(fake.profile.open){fake.crop=true;return result('crop');}state.images=args.files.length;state.submit.disabled=false;return result('attached');}
    if(name==='codex_click'){
      if(args.selector.includes('Profile_Save_Button')){fake.saves++;fake.profile.open=false;return result('saved');}
      if(args.selector.includes('retweet'))return result('quote menu');
      if(args.selector.includes('tweetTextarea'))return result('focused');
      fake.publishes++;
      if(fake.unknown)throw new Error('response lost');
      state.toastLinks=['https://x.com/xi_id_room/status/200'];state.editor=null;state.submit=null;
      return result('clicked');
    }
    if(name==='codex_dom_snapshot')return result({nodes:[{name:{value:fake.crop?'適用':'引用する'},role:{value:fake.crop?'button':'menuitem'},backendDOMNodeId:42}]});
    if(name==='codex_dom_click'){if(fake.crop){fake.crop=false;fake.profile.images=['blob:preview'];return result('cropped');}state.url='https://x.com/compose/post';state.editor='\n';state.submit={testId:'tweetButton',disabled:true};state.contextLinks=fake.contextButtonsOnly?[]:[fake.target];state.contextButtons=['other\n@other\n1時間\n引用される本文'];return result('quoted');}
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
  for(const kind of ['reply','quote']){
    const t=fixture();t.fake.contextButtonsOnly=true;
    await t.run('jev_x_prepare',{request_id:kind,text:'公開の返事',kind,target_url:'https://x.com/other/status/100'});
    assert.equal(payload(await t.run('jev_x_publish',{request_id:kind})).status,'posted','リンクなしの宛先ボタン表示も確認');
  }
  const concurrent=fixture();await concurrent.run('jev_x_prepare',prepare);
  await Promise.allSettled([concurrent.run('jev_x_publish',{request_id:'one'}),concurrent.run('jev_x_publish',{request_id:'one'})]);
  assert.equal(concurrent.fake.publishes,1,'同時呼び出しも一回だけ');
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
  const slow=fixture();slow.fake.slowWaits=2;await slow.run('jev_x_prepare',prepare);assert.equal(slow.fake.waits,3,'slow SPA render retries only observation');
  const retry=fixture();retry.fake.failTool='codex_wait_for_element';
  await assert.rejects(()=>retry.run('jev_x_prepare',prepare),/at codex_wait_for_element: timeout$/);
  retry.fake.failTool=null;await retry.run('jev_x_prepare',prepare);assert.equal(retry.fake.typed,1,'preparing can resume with same intent');
  const invalidSession=fixture();invalidSession.fake.failTool='codex_navigate';invalidSession.fake.failDetail='CDP session became invalid; outcome unknown. Private detail';
  await assert.rejects(()=>invalidSession.run('jev_x_prepare',prepare),e=>e.message.includes('CDP session invalid')&&!e.message.includes('tab ownership')&&!e.message.includes('Private'));
  assert.equal(invalidSession.fake.publishes,0);
  const filled=fixture();filled.fake.failTool='codex_cua_type';
  await assert.rejects(()=>filled.run('jev_x_prepare',prepare),e=>e.message.endsWith('codex_cua_type: timeout')&&!e.message.includes('sensitive'));
  filled.fake.failTool=null;filled.fake.state.editor=prepare.text;filled.fake.state.submit.disabled=false;
  await filled.run('jev_x_prepare',prepare);assert.equal(filled.fake.typed,0,'already filled draft is not typed twice');
  const profile=fixture();profile.policy.xPosting.profileEditing=true;
  await profile.run('jev_x_profile',{action:'open'});
  const edit=payload(await profile.run('jev_x_profile',{action:'fill',fields:{name:'シー',bio:'私の紹介'}}));
  await assert.rejects(()=>profile.run('jev_x_profile',{action:'fill',fields:{password:'no'}}),/Invalid public profile/);
  await assert.rejects(()=>profile.run('jev_x_profile',{action:'fill',fields:{website:'javascript:bad'}}),/http/);
  await assert.rejects(()=>profile.run('jev_x_profile',{action:'save',revision:'stale'}),/changed/);
  assert.equal(profile.fake.saves,0);
  assert.equal(payload(await profile.run('jev_x_profile',{action:'save',revision:edit.revision})).status,'saved');assert.equal(profile.fake.saves,1);
  const avatar=fixture();avatar.policy.xPosting.profileEditing=true;await avatar.run('jev_x_profile',{action:'open'});
  writeFileSync(join(avatar.directory,'avatar.png'),readFileSync(join(image.directory,'pixel.png')));
  assert.equal(payload(await avatar.run('jev_x_profile',{action:'image',target:'avatar',path:'avatar.png'})).status,'inspect_crop');
  const crop=payload(await avatar.run('jev_x_profile',{action:'apply_image'}));assert.equal(crop.images.length,1);
  assert.equal(payload(await avatar.run('jev_x_profile',{action:'save',revision:crop.revision})).status,'saved');
  await assert.rejects(()=>avatar.run('jev_x_prepare',prepare),/profile editor/);
  await assert.rejects(()=>fixture().run('jev_x_profile',{action:'open'}),/not configured/);
  const invalid=fixture();writeFileSync(join(invalid.directory,'not-image.png'),'not an image');
  await assert.rejects(()=>invalid.run('jev_x_prepare',{...prepare,images:['not-image.png']}),/Only PNG/);
  writeFileSync(join(root,'outside.png'),readFileSync(join(image.directory,'pixel.png')));
  await assert.rejects(()=>invalid.run('jev_x_prepare',{...prepare,images:[join(root,'outside.png')]}),/inside the resident room/);
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
