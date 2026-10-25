import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, extname } from 'node:path';

export const X_TOOL_NAMES = ['jev_x_view', 'jev_x_prepare', 'jev_x_publish', 'jev_x_status', 'jev_x_profile'];
export const X_TOOL_DEFINITIONS = [
  {name:'jev_x_profile',description:'Edit your own public X profile. open, fill (name/bio/location/website), image (avatar/banner file in your room), apply_image after inspecting crop, then save with the exact returned revision. You choose content; no per-edit orange confirmation. Does not change handle, birthday, authentication or privacy.',inputSchema:{type:'object',properties:{tab_id:{type:'string'},action:{type:'string',enum:['open','view','fill','image','apply_image','save']},fields:{type:'object',properties:{name:{type:'string'},bio:{type:'string'},location:{type:'string'},website:{type:'string'}},additionalProperties:false},target:{type:'string',enum:['avatar','banner']},path:{type:'string'},revision:{type:'string'},image:{type:'boolean'}},required:['tab_id','action']}},
  { name: 'jev_x_view', description: 'Read the dedicated public X tab; image=true returns a screenshot to XI-ID. Does not publish.', inputSchema: { type:'object', properties:{tab_id:{type:'string'},image:{type:'boolean'}},required:['tab_id'] } },
  { name: 'jev_x_prepare', description: 'Prepare XI-ID\'s own public X post/reply/quote with optional room image paths. XI-ID chooses text and timing; orange confirmation is not required. Preserve request_id across retries. Inspect the returned draft before publishing.', inputSchema: {type:'object',properties:{tab_id:{type:'string'},request_id:{type:'string'},text:{type:'string'},kind:{type:'string',enum:['post','reply','quote']},target_url:{type:'string'},images:{type:'array',items:{type:'string'},maxItems:4}},required:['tab_id','request_id','text']} },
  { name: 'jev_x_publish', description: 'Publish the unchanged prepared public X draft once, after XI-ID decides to publish. Reusing request_id never republishes. An unknown result requires status/inspection, not a new request_id.', inputSchema:{type:'object',properties:{tab_id:{type:'string'},request_id:{type:'string'}},required:['tab_id','request_id']} },
  { name: 'jev_x_status', description: 'Inspect an existing public-post request and reconcile an unknown result with visible existing posts. Never publishes.', inputSchema:{type:'object',properties:{tab_id:{type:'string'},request_id:{type:'string'}},required:['tab_id','request_id']} },
];
const hash = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function text(result) {
  if (result?.isError) throw new Error('X browser transport failed');
  if (typeof result === 'string') return result;
  return result?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || '';
}
function localPath(path) {
  return process.platform !== 'win32' ? path.replace(/^([a-z]):[\\/]/i, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replaceAll('\\', '/') : path;
}
function capability(config, env) {
  const policy = config?.browser?.actors?.[env.JEV_BROWSER_ACTOR];
  const x = policy?.xPosting;
  if (env.JEV_BROWSER_ACTOR !== 'shii' || x?.account !== 'xi_id_room' || !policy.browserInstance || !x.stateDirectory || !x.uploadBase || !x.room) {
    throw new Error('X public posting is not configured for this actor');
  }
  return { ...x, instance: policy.browserInstance };
}
// Fixed, read-only DOM observation. No page scripts or model-supplied JS are executed.
export const X_STATE_EXPRESSION = `(() => {
  const editor = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]') || document.querySelector('[data-testid="tweetTextarea_0"]');
  const scope = editor?.closest('[role="dialog"]') || document;
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const submit = scope.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
  const statusLinks = el => Array.from(el.querySelectorAll('a[href*="/status/"]')).map(a => a.href);
  return { url: location.href, account: profile?.getAttribute('href') || null,
    editor: editor ? editor.innerText : null, submit: submit ? {testId:submit.dataset.testid,disabled:submit.disabled || submit.getAttribute('aria-disabled') === 'true'} : null,
    images: scope.querySelectorAll('[data-testid="attachments"] img').length || scope.querySelectorAll('[data-testid="attachments"] [data-testid="attachment"], [data-testid="attachments"] [data-testid="mediaPreview"]').length,
    contextLinks: statusLinks(scope), contextButtons: Array.from(scope.querySelectorAll('button, [role="button"]')).map(b=>b.innerText || '').filter(t=>t.includes('@')),
    links: statusLinks(document),
    toastLinks: Array.from(document.querySelectorAll('[data-testid="toast"] a[href*="/status/"]')).map(a => a.href),
    posts: Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map(a => ({links:statusLinks(a), text:a.querySelector('[data-testid="tweetText"]')?.innerText || ''})) };
})()`;

async function observe(browser, tabId, x, { requireAccount = true } = {}) {
  const info = await browser.info({});
  if (info.instance !== x.instance) throw new Error('Dedicated X browser is not connected');
  const url = new URL(await browser.url({tab_id:tabId}));
  const profilePage = x.profileEditing === true && url.pathname==='/settings/profile';
  if (url.origin !== 'https://x.com' || (!profilePage && /^\/(?:settings|messages|account|i\/(?:chat|grok|flow|premium))(?:\/|$)/u.test(url.pathname))) throw new Error('This is not an authorized public X page');
  const state = await browser.evaluate({tab_id:tabId,expression:X_STATE_EXPRESSION});
  // X's empty contenteditable reports one placeholder newline (observed on the live composer).
  if (state.editor === '\n') state.editor = '';
  if (state.url !== url.href) throw new Error('X tab changed during observation');
  const account = new URL(state.account || '/', 'https://x.com');
  if (requireAccount && (account.origin !== 'https://x.com' || account.pathname.replace(/^\/+|\/+$/g, '').toLowerCase() !== x.account)) throw new Error('X account mismatch or logged out; expected @xi_id_room');
  return state;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('request_id must contain 1-80 letters, digits, underscores or hyphens');
  return value;
}
function recordPath(x, id) {
  const directory = localPath(x.stateDirectory);
  mkdirSync(directory, { recursive: true });
  return join(directory, identifier(id) + '.json');
}
function ownPost(url, account) {
  try { const u = new URL(url); return u.origin === 'https://x.com' && new RegExp(`^/${account}/status/[0-9]+/?$`, 'i').test(u.pathname); } catch { return false; }
}
function statusId(url) {
  const u = new URL(url);
  const match = /^\/[a-zA-Z0-9_]+\/status\/([0-9]+)\/?$/.exec(u.pathname);
  if (u.origin !== 'https://x.com' || !match || u.search || u.hash) throw new Error('target_url must be an exact public X post URL');
  return match[1];
}
function stageImages(paths, x, id) {
  if (!Array.isArray(paths) || paths.length > 4) throw new Error('At most four images may be attached');
  const room = realpathSync(localPath(x.room));
  const base = realpathSync(localPath(x.uploadBase));
  return paths.map((input, index) => {
    if (typeof input !== 'string') throw new Error('Image path must be a string');
    const source = realpathSync(resolve(room, localPath(input)));
    const rel = relative(room, source);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Image must be inside the resident room');
    const s = statSync(source);
    if (!s.isFile() || s.size > 10_000_000) throw new Error('Image must be a regular file no larger than 10 MB');
    const bytes = readFileSync(source);
    const extension = extname(source).toLowerCase();
    const valid = (extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
      || (['.jpg','.jpeg'].includes(extension) && bytes[0] === 255 && bytes[1] === 216)
      || (extension === '.gif' && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()))
      || (extension === '.webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
    if (!valid) throw new Error('Only PNG, JPEG, GIF and WebP image files are accepted');
    const uploadRelative = relative(base, source);
    if (uploadRelative.startsWith('..') || isAbsolute(uploadRelative)) throw new Error('Image must be inside the configured upload base');
    return { path: x.uploadBase.replaceAll('\\', '/').replace(/\/$/, '') + '/' + uploadRelative.replaceAll('\\', '/'), sha256: hash(bytes) };
  });
}
function findPosted(state, record, x) {
  const newLink = url => ownPost(url, x.account) && !record.beforeLinks.includes(url);
  return state.toastLinks.find(newLink) || state.posts.find(post => hash(post.text) === record.textHash && post.links.some(newLink))?.links.find(newLink) || null;
}
function contextSignal(state, record) {
  if (!record.targetId) return '';
  const link = state.contextLinks.find(url=>{try{return statusId(url)===record.targetId;}catch{return false;}});
  if (link) return link;
  const author = new URL(record.targetUrl).pathname.split('/')[1].toLowerCase();
  const button = (state.contextButtons || []).find(t=>new RegExp(`@${author}(?:[^a-z0-9_]|$)`,'i').test(t)
    && (record.kind==='reply' ? /返信先|Replying to/i.test(t) : !/返信先|Replying to/i.test(t)));
  if (record.kind==='reply' && new URL(state.url).searchParams.get('in_reply_to')!==record.targetId) return null;
  return button || null;
}

export function createNativeXBrowser(callTool) {
  const transport = callTool;
  callTool = async (tool, input) => {
    const result = await transport(tool, input);
    if (result?.isError) {
      const detail = result.content?.filter(c=>c.type==='text').map(c=>c.text).join(' ') || '';
      const category = /timeout|timed out|not found after/i.test(detail) ? 'timeout' : /foreground|background/i.test(detail) ? 'foreground' : /owned|ownership|another.*session|already part of/i.test(detail) ? 'tab ownership' : /session.*invalid|invalid.*session|session.*not found|no session/i.test(detail) ? 'CDP session invalid; outcome may be unknown' : /disconnect|connect|pipe/i.test(detail) ? 'connection' : 'bridge rejected operation';
      const error=new Error(`X browser transport failed at ${tool}: ${category}`);
      if(tool==='codex_wait_for_element' && category==='timeout') error.code='BROWSER_WAIT_TIMEOUT';
      throw error;
    }
    return result;
  };
  const parsed = async (tool,input) => JSON.parse(text(await callTool(tool,input)));
  const command = tool => async input => { text(await callTool(tool,input)); };
  return {
    info: async input => { const i=await parsed('codex_get_info',input); return {instance:i.bridge?.selectedBrowser?.instance_id}; },
    url: async input => text(await callTool('codex_get_url',input)).trim(),
    evaluate: async input => {const r=await parsed('codex_evaluate',input);return r.result?.value ?? r.value ?? r;},
    snapshot: async input => {const r=await callTool('codex_dom_snapshot',input);return {...JSON.parse(text(r)),content:r.content};},
    screenshot: input => callTool('codex_screenshot',input),
    activate: command('codex_bring_to_front'), navigate: command('codex_navigate'),
    waitFor: command('codex_wait_for_element'), click: command('codex_click'),
    clickNode: command('codex_dom_click'), type: command('codex_cua_type'),
    files: command('codex_file_input'), fill: command('codex_fill'),
  };
}

export async function handleXPublicTool(name,args,callTool,config,env,options) {
  return handleXBrowserTool(name,args,createNativeXBrowser(callTool),capability(config,env),options);
}

export async function handleXBrowserTool(name,args,browser,x,{wait=sleep}={}) {
  const waitFor = async selector => {
    for (let attempt=0; attempt<6; attempt++) {
      try { return await browser.waitFor({tab_id:args.tab_id,selector,timeout_ms:5000}); }
      catch(error) { if(error.code!=='BROWSER_WAIT_TIMEOUT' || attempt===5) throw error; }
    }
  };
  const tabId = args.tab_id;
  if (typeof tabId !== 'string' || !tabId) throw new Error('tab_id is required');
  const state = await observe(browser, tabId, x);
  if(name==='jev_x_profile') return handleProfile(args,browser,x,state,waitFor,wait);
  if(new URL(state.url).pathname==='/settings/profile' && name!=='jev_x_view') throw new Error('Preserve the profile editor; use another X tab for posting');
  if (name === 'jev_x_view') {
    const snapshot = await browser.snapshot( { tab_id: tabId });
    if (snapshot.isError) throw new Error('Cannot read X tab');
    const screenshot = args.image ? await browser.screenshot( { tab_id: tabId, format: 'jpeg', quality: 75 }) : null;
    return { content: [{ type: 'text', text: `Browser: dedicated @${x.account}; URL: ${state.url}` }, ...(snapshot.content || []), ...(screenshot?.content || [])] };
  }
  const id = identifier(args.request_id);
  const file = recordPath(x, id);
  if (name === 'jev_x_prepare') {
    if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 64 * 1024 || (!args.text.trim() && !args.images?.length)) throw new Error('Provide text or images; text must be at most 64 KB');
    const kind = args.kind || 'post';
    if (!['post', 'reply', 'quote'].includes(kind)) throw new Error('Unknown public post kind');
    const targetId = kind === 'post' ? null : statusId(args.target_url);
    const images = stageImages(args.images || [], x, id);
    const intentHash = hash(JSON.stringify({ text: args.text, kind, targetId, images: images.map(image => image.sha256) }));
    let previous;
    if (existsSync(file)) {
      const old = JSON.parse(readFileSync(file, 'utf8'));
      if (old.intentHash !== intentHash) throw new Error('request_id already belongs to different content');
      const restore=x.persistDraft && old.browserInstance!==x.instance && ['preparing','prepared'].includes(old.status) && !existsSync(file+'.publish');
      if (old.status !== 'preparing' && !restore) return textResult({ status: old.status, request_id: id, url: old.url || null, message: 'Existing request preserved; inspect its status rather than preparing again.' });
      previous=restore?{...old,status:'preparing',tabId,browserInstance:x.instance}:old;
    }
    if (previous && previous.tabId!==tabId) throw new Error('This request belongs to another tab');
    const resumeFilled = previous && state.editor===args.text && state.images<=images.length && (!previous.composeUrl || previous.composeUrl===state.url) && (!targetId || contextSignal(state,previous));
    if (state.editor?.trim() && !resumeFilled) throw new Error('An existing draft is open; preserve it instead of overwriting it');
    const record = previous || { request_id: id, tabId, kind, targetId, targetUrl:args.target_url || null, intentHash, textHash: hash(args.text), imageCount: images.length, images, status: 'preparing', beforeLinks: state.links.filter(url => ownPost(url, x.account)), at: new Date().toISOString() };
    if(x.persistDraft){record.browserInstance=x.instance;record.draft={text:args.text,kind,target_url:args.target_url || null,images:args.images || []};}
    if (!previous) writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    else if(x.persistDraft) writeFileSync(file,JSON.stringify(record),{mode:0o600});
    await browser.activate({tab_id:tabId});
    if (!resumeFilled) {
    const url = new URL('https://x.com/compose/post');
    if (kind === 'reply') url.searchParams.set('in_reply_to', targetId);
    if (kind === 'quote') {
      // X ignores attachment_url on a direct composer URL. Open the observed post's quote menu.
      await browser.navigate({tab_id:tabId,url:args.target_url});
      const article = `article[data-testid="tweet"]:has(a[href="${new URL(args.target_url).pathname}"])`;
      await waitFor(article);
      await observe(browser,tabId,x);
      await browser.click({tab_id:tabId,selector:`${article} :is([data-testid="retweet"],[data-testid="unretweet"])`});
      const menu = await browser.snapshot({tab_id:tabId});
      const entries=(menu.nodes || []).filter(n=>['引用する','引用','Quote','Quote post'].includes(n.name?.value) && !/text/i.test(n.role?.value || '') && Number.isInteger(n.backendDOMNodeId));
      if(entries.length!==1) throw new Error('Quote menu entry is not unambiguous');
      await browser.clickNode({tab_id:tabId,node_id:String(entries[0].backendDOMNodeId)});
    } else {
      await browser.navigate({ tab_id: tabId, url: url.href });
    }
    await waitFor('[role="dialog"] [data-testid="tweetTextarea_0"]');
    let ready;
    for(let i=0;i<16;i++) { ready=await observe(browser,tabId,x); if(!targetId || contextSignal(ready,record)) break; await wait(500); }
    if (ready.editor === null || ready.editor.trim()) throw new Error('Empty X composer was not found');
    if (targetId && !contextSignal(ready,record)) throw new Error('Reply/quote context was not confirmed; nothing will be published');
    await browser.click({ tab_id: tabId, selector: '[role="dialog"] [data-testid="tweetTextarea_0"]' });
    if (args.text) await browser.type({ tab_id: tabId, text: args.text });
    if (images.length) await browser.files({ tab_id: tabId, selector: '[role="dialog"] input[type="file"][data-testid="fileInput"]', files: images.map(image => image.path) });
    }
    let preview;
    for (let i = 0; i < 60; i++) {
      preview = await observe(browser, tabId, x);
      if (preview.editor === args.text && preview.images === images.length && preview.submit && !preview.submit.disabled) break;
      await wait(500);
    }
    if (preview.editor !== args.text || preview.images !== images.length || !preview.submit || preview.submit.disabled) {
      if(images.length && preview.editor===args.text && preview.images<=images.length){
        record.composeUrl=preview.url;writeFileSync(file,JSON.stringify(record),{mode:0o600});
        return textResult({status:'preparing',request_id:id,needs_prepare:true,message:'Image upload is not ready. Inspect the draft and prepare again with the same request_id; no text or files will be added twice. Nothing was published.'});
      }
      throw new Error('X composer or attachments do not match the requested draft');
    }
    record.status = 'prepared';
    record.contextHash = hash(contextSignal(preview,record) || '');
    record.submit = preview.submit.testId;
    record.composeUrl = preview.url;
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    return textResult({ status: 'prepared', request_id: id, account: x.account, kind, target_url: args.target_url || null, text: preview.editor, images: preview.images, message: 'XI-ID chooses whether to publish. No orange confirmation is required.' });
  }
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.tabId !== tabId && name!=='jev_x_status') throw new Error('This request belongs to another tab');
  if (record.status === 'posted') return textResult({ status: 'posted', request_id: id, url: record.url });
  if (name === 'jev_x_status') {
    const url = record.status === 'unknown' ? findPosted(state, record, x) : null;
    if (url) { record.status = 'posted'; record.url = url; writeFileSync(file, JSON.stringify(record)); }
    return textResult({ status: record.status, request_id: id, url: record.url || null, ...(record.status==='preparing'?{needs_prepare:true}:{}), ...(x.persistDraft && ['preparing','prepared'].includes(record.status) ? {draft:record.draft,needs_prepare:record.status==='preparing' || record.browserInstance!==x.instance}:{}), message: record.status === 'unknown' ? 'Do not retry publishing; inspect existing posts first.' : undefined });
  }
  if (name !== 'jev_x_publish') throw new Error('Unknown X tool');
  if(x.persistDraft && record.browserInstance!==x.instance && record.status==='prepared') throw new Error('Browser restarted; inspect and prepare the same draft before publishing');
  if(record.status==='preparing')return textResult({status:'preparing',request_id:id,needs_prepare:true,message:'Nothing was published. Inspect the loading draft and prepare again with the same request_id before publishing.'});
  if (record.status !== 'prepared') return textResult({ status: record.status, request_id: id, message: 'Not publishing again. Inspect existing posts.' });
  if (state.url !== record.composeUrl || hash(state.editor || '') !== record.textHash || state.images !== record.imageCount || !state.submit || state.submit.disabled || state.submit.testId !== record.submit) throw new Error('Draft changed; nothing was published');
  if (record.targetId && (!contextSignal(state,record) || hash(contextSignal(state,record)) !== record.contextHash)) throw new Error('Reply/quote context changed');
  if (record.images.some(image => hash(readFileSync(localPath(image.path))) !== image.sha256)) throw new Error('An image changed after preparation');
  // Durable exclusive marker precedes the external effect. Uncertainty never replays a click.
  writeFileSync(file + '.publish', new Date().toISOString(), { flag: 'wx', mode: 0o600 });
  record.status = 'unknown';
  record.beforeLinks = [...new Set([...record.beforeLinks, ...state.links.filter(url => ownPost(url, x.account))])];
  writeFileSync(file, JSON.stringify(record));
  try {
    await browser.click({ tab_id: tabId, selector: `[data-testid="${record.submit}"]` });
    for (let i = 0; i < 20; i++) {
      const current = await observe(browser, tabId, x);
      const url = findPosted(current, record, x);
      if (url) {
        record.status = 'posted'; record.url = url;
        writeFileSync(file, JSON.stringify(record));
        return textResult({ status: 'posted', request_id: id, account: x.account, url });
      }
      await wait(500);
    }
  } catch { /* A transport failure cannot prove that the external effect failed. */ }
  return textResult({ status: 'unknown', request_id: id, message: 'Publishing was attempted once. Inspect existing posts; do not resubmit.' });
}

const PROFILE_FIELDS={name:['input[name="displayName"]',50],bio:['textarea[name="description"]',160],location:['input[name="location"]',30],website:['input[name="url"]',100]};
export const X_PROFILE_EXPRESSION=`(() => {
 const save=document.querySelector('[data-testid="Profile_Save_Button"]');
 const scope=save?.closest('[role="dialog"]') || document;
 const fields={}; for(const [key,name] of Object.entries({name:'displayName',bio:'description',location:'location',website:'url'})) {const el=scope.querySelector('[name="'+name+'"]');if(el) fields[key]=el.value;}
 return {open:!!save,fields,images:Array.from(scope.querySelectorAll('img')).map(e=>e.src),buttons:Array.from(scope.querySelectorAll('button')).map(e=>e.innerText)};
})()`;
async function handleProfile(args,browser,x,state,waitFor,wait){
 if(x.profileEditing!==true) throw new Error('Public profile editing is not configured');
 const tab_id=args.tab_id;
 const read=async()=>{return browser.evaluate({tab_id,expression:X_PROFILE_EXPRESSION});};
 const snapshot=async status=>{const p=await read();return {content:[{type:'text',text:JSON.stringify({status,...p,revision:hash(JSON.stringify(p)),message:'You choose the public profile. Inspect before save; no per-edit orange confirmation.'})},...(await browser.snapshot({tab_id})).content,...(args.image ? (await browser.screenshot({tab_id,format:'jpeg',quality:75})).content : [])]};};
 if(args.action==='open'){
  if(state.editor?.trim()) throw new Error('Preserve the existing post draft; use another X tab for profile editing');
  await browser.activate({tab_id});
  if(new URL(state.url).pathname!=='/settings/profile') await browser.navigate({tab_id,url:'https://x.com/settings/profile'});
  await waitFor('[data-testid="Profile_Save_Button"]');
  await observe(browser,tab_id,x);
  return snapshot('editing');
 }
 if(new URL(state.url).pathname!=='/settings/profile') throw new Error('Open your profile editor first');
 const before=await read(); if(!before.open) throw new Error('Profile editor is not ready');
 if(args.action==='view') return snapshot('editing');
 if(args.action==='fill'){
  if(!args.fields || !Object.keys(args.fields).length) throw new Error('Provide public profile fields');
  for(const [key,value] of Object.entries(args.fields)){
   const spec=PROFILE_FIELDS[key];
   if(!spec || typeof value!=='string' || [...value].length>spec[1] || (key==='name' && !value.trim())) throw new Error('Invalid public profile field');
   if(key==='website' && value && !/^https?:\/\//i.test(value)) throw new Error('Website must be an http(s) URL');
  }
  for(const [key,value] of Object.entries(args.fields)) await browser.fill({tab_id,selector:PROFILE_FIELDS[key][0],value});
  const after=await read(); if(Object.entries(args.fields).some(([k,v])=>after.fields[k]!==v)) throw new Error('Profile fields did not match; nothing was saved');
  return snapshot('editing');
 }
 if(args.action==='image'){
  if(!['avatar','banner'].includes(args.target) || typeof args.path!=='string') throw new Error('Choose avatar/banner and an image path');
  const image=stageImages([args.path],x,'profile')[0];
  if(extname(image.path).toLowerCase()==='.gif') throw new Error('Profile images accept PNG, JPEG or WebP');
  const labels=args.target==='avatar'?['プロフィール画像を追加','Add profile photo']:['バナー画像を追加','Add banner photo'];
  const selector=labels.map(label=>`div:has(> button[aria-label="${label}"]) > input[type="file"]`).join(', ');
  await browser.files({tab_id,selector,files:[image.path]});
  return snapshot('inspect_crop');
 }
 if(args.action==='apply_image'){
  const raw=await browser.snapshot({tab_id});
  const nodes=(raw.nodes||[]).filter(n=>['適用','Apply'].includes(n.name?.value) && n.role?.value==='button' && Number.isInteger(n.backendDOMNodeId));
  if(nodes.length!==1) throw new Error('Image crop Apply button is not unambiguous; inspect the screenshot');
  await browser.clickNode({tab_id,node_id:String(nodes[0].backendDOMNodeId)});
  return snapshot('editing');
 }
 if(args.action!=='save') throw new Error('Unknown public profile action');
 if(typeof args.revision!=='string' || args.revision!==hash(JSON.stringify(before))) throw new Error('Profile changed; inspect the current revision before saving');
 await browser.click({tab_id,selector:'[data-testid="Profile_Save_Button"]'});
 for(let i=0;i<20;i++){if(!(await read()).open) return textResult({status:'saved',account:x.account,fields:before.fields,message:'Save dialog closed. Inspect your public profile to confirm text and images.'});await wait(500);}
 return textResult({status:'unknown',message:'Save was attempted. Inspect your public profile before trying again.'});
}
