import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, extname } from 'node:path';

export const X_TOOL_NAMES = ['jev_x_view', 'jev_x_prepare', 'jev_x_publish', 'jev_x_status'];
export const X_TOOL_DEFINITIONS = [
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
  const editor = document.querySelector('[data-testid="tweetTextarea_0"]');
  const scope = editor?.closest('[role="dialog"]') || document;
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const submit = scope.querySelector('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
  const statusLinks = el => Array.from(el.querySelectorAll('a[href*="/status/"]')).map(a => a.href);
  return { url: location.href, account: profile?.getAttribute('href') || null,
    editor: editor ? editor.innerText : null, submit: submit ? {testId:submit.dataset.testid,disabled:submit.disabled || submit.getAttribute('aria-disabled') === 'true'} : null,
    images: scope.querySelectorAll('[data-testid="attachments"] [data-testid="attachment"], [data-testid="attachments"] [data-testid="mediaPreview"]').length,
    contextLinks: statusLinks(scope), links: statusLinks(document),
    toastLinks: Array.from(document.querySelectorAll('[data-testid="toast"] a[href*="/status/"]')).map(a => a.href),
    posts: Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map(a => ({links:statusLinks(a), text:a.querySelector('[data-testid="tweetText"]')?.innerText || ''})) };
})()`;

async function observe(callTool, tabId, x, { requireAccount = true } = {}) {
  const info = JSON.parse(text(await callTool('codex_get_info', {})));
  if (info.bridge?.selectedBrowser?.instance_id !== x.instance) throw new Error('Dedicated X browser is not connected');
  const url = new URL(text(await callTool('codex_get_url', { tab_id: tabId })).trim());
  if (url.origin !== 'https://x.com' || /^\/(?:settings|messages|account|i\/(?:chat|grok|flow|premium))(?:\/|$)/u.test(url.pathname)) throw new Error('This is not an authorized public X page');
  const evaluated = JSON.parse(text(await callTool('codex_evaluate', { tab_id: tabId, expression: X_STATE_EXPRESSION })));
  const state = evaluated.result?.value ?? evaluated.value ?? evaluated;
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
  const match = /^\/[^/]+\/status\/([0-9]+)\/?$/.exec(u.pathname);
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

export async function handleXPublicTool(name, args, callTool, config, env, { wait = sleep } = {}) {
  const x = capability(config, env);
  const tabId = args.tab_id;
  if (typeof tabId !== 'string' || !tabId) throw new Error('tab_id is required');
  const state = await observe(callTool, tabId, x);
  if (name === 'jev_x_view') {
    const snapshot = await callTool('codex_dom_snapshot', { tab_id: tabId });
    if (snapshot.isError) throw new Error('Cannot read X tab');
    const screenshot = args.image ? await callTool('codex_screenshot', { tab_id: tabId, format: 'jpeg', quality: 75 }) : null;
    return { content: [{ type: 'text', text: `Browser: dedicated @${x.account}; URL: ${state.url}` }, ...(snapshot.content || []), ...(screenshot?.content || [])] };
  }
  const id = identifier(args.request_id);
  const file = recordPath(x, id);
  if (name === 'jev_x_prepare') {
    if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 64 * 1024 || (!args.text.trim() && !args.images?.length)) throw new Error('Provide text or images; text must be at most 64 KB');
    const kind = args.kind || 'post';
    if (!['post', 'reply', 'quote'].includes(kind)) throw new Error('Unknown public post kind');
    const targetId = kind === 'post' ? null : statusId(args.target_url);
    if (state.editor?.trim()) throw new Error('An existing draft is open; preserve it instead of overwriting it');
    const images = stageImages(args.images || [], x, id);
    const intentHash = hash(JSON.stringify({ text: args.text, kind, targetId, images: images.map(image => image.sha256) }));
    if (existsSync(file)) {
      const old = JSON.parse(readFileSync(file, 'utf8'));
      if (old.intentHash !== intentHash) throw new Error('request_id already belongs to different content');
      return textResult({ status: old.status, request_id: id, url: old.url || null, message: 'Existing request preserved; inspect its status rather than preparing again.' });
    }
    const record = { request_id: id, tabId, kind, targetId, intentHash, textHash: hash(args.text), imageCount: images.length, images, status: 'preparing', beforeLinks: state.links.filter(url => ownPost(url, x.account)), at: new Date().toISOString() };
    writeFileSync(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    const url = new URL('https://x.com/compose/post');
    if (kind === 'reply') url.searchParams.set('in_reply_to', targetId);
    if (kind === 'quote') url.searchParams.set('attachment_url', args.target_url);
    text(await callTool('codex_navigate', { tab_id: tabId, url: url.href }));
    text(await callTool('codex_wait_for_element', { tab_id: tabId, selector: '[data-testid="tweetTextarea_0"]' }));
    const ready = await observe(callTool, tabId, x);
    if (ready.editor === null || ready.editor.trim()) throw new Error('Empty X composer was not found');
    if (targetId && !ready.contextLinks.some(url => { try { return statusId(url) === targetId; } catch { return false; } })) throw new Error('Reply/quote context was not confirmed; nothing will be published');
    text(await callTool('codex_click', { tab_id: tabId, selector: '[data-testid="tweetTextarea_0"]' }));
    if (args.text) text(await callTool('codex_cua_type', { tab_id: tabId, text: args.text }));
    if (images.length) text(await callTool('codex_file_input', { tab_id: tabId, selector: 'input[type="file"][data-testid="fileInput"]', files: images.map(image => image.path) }));
    let preview;
    for (let i = 0; i < 12; i++) {
      preview = await observe(callTool, tabId, x);
      if (preview.editor === args.text && preview.images === images.length && preview.submit && !preview.submit.disabled) break;
      await wait(500);
    }
    if (preview.editor !== args.text || preview.images !== images.length || !preview.submit || preview.submit.disabled) throw new Error('X composer or attachments do not match the requested draft');
    record.status = 'prepared';
    record.submit = preview.submit.testId;
    record.composeUrl = preview.url;
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    return textResult({ status: 'prepared', request_id: id, account: x.account, kind, target_url: args.target_url || null, text: preview.editor, images: preview.images, message: 'XI-ID chooses whether to publish. No orange confirmation is required.' });
  }
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.tabId !== tabId) throw new Error('This request belongs to another tab');
  if (record.status === 'posted') return textResult({ status: 'posted', request_id: id, url: record.url });
  if (name === 'jev_x_status') {
    const url = record.status === 'unknown' ? findPosted(state, record, x) : null;
    if (url) { record.status = 'posted'; record.url = url; writeFileSync(file, JSON.stringify(record)); }
    return textResult({ status: record.status, request_id: id, url: record.url || null, message: record.status === 'unknown' ? 'Do not retry publishing; inspect existing posts first.' : undefined });
  }
  if (name !== 'jev_x_publish') throw new Error('Unknown X tool');
  if (record.status !== 'prepared') return textResult({ status: record.status, request_id: id, message: 'Not publishing again. Inspect existing posts.' });
  if (state.url !== record.composeUrl || hash(state.editor || '') !== record.textHash || state.images !== record.imageCount || !state.submit || state.submit.disabled || state.submit.testId !== record.submit) throw new Error('Draft changed; nothing was published');
  if (record.targetId && !state.contextLinks.some(url => { try { return statusId(url) === record.targetId; } catch { return false; } })) throw new Error('Reply/quote context changed');
  if (record.images.some(image => hash(readFileSync(localPath(image.path))) !== image.sha256)) throw new Error('An image changed after preparation');
  // Durable exclusive marker precedes the external effect. Uncertainty never replays a click.
  writeFileSync(file + '.publish', new Date().toISOString(), { flag: 'wx', mode: 0o600 });
  record.status = 'unknown';
  record.beforeLinks = [...new Set([...record.beforeLinks, ...state.links.filter(url => ownPost(url, x.account))])];
  writeFileSync(file, JSON.stringify(record));
  try {
    text(await callTool('codex_click', { tab_id: tabId, selector: `[data-testid="${record.submit}"]` }));
    for (let i = 0; i < 20; i++) {
      const current = await observe(callTool, tabId, x);
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
