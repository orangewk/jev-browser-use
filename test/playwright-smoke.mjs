import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createPlaywrightTab} from '../skills/jev-browser-use/playwright-adapter.mjs';

const root=await mkdtemp(join(tmpdir(),'jev-headless-smoke-'));
const server=createServer((req,res)=>{
  if(req.url==='/outside'){res.writeHead(302,{location:'http://localhost:1/blocked'});res.end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<title>人工ブラウザ</title><button onclick="this.textContent='押せた'">押す</button><textarea aria-label="本文"></textarea><input type=file aria-label="添付"><div style="height:2000px"></div><button onclick="this.textContent='下でも押せた'">下のボタン</button>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let context;
try {
  await mkdir(join(root,'profile'));
  context=await chromium.launchPersistentContext(join(root,'profile'),{headless:true,channel:'chromium',chromiumSandbox:true,env:{...process.env,DISPLAY:'',WAYLAND_DISPLAY:''}});
  const page=await context.newPage();await page.goto(origin);
  const tab=await createPlaywrightTab(page,{allowedOrigins:[origin]});
  let snapshot=await tab.getAXState();
  let line=snapshot.split('\n').find(l=>l.endsWith('button Description: 押す'));
  assert.ok(line);await tab.click(Number(line.split(' ')[0]));
  assert.equal(await page.getByRole('button',{name:'押せた',exact:true}).count(),1);
  await assert.rejects(()=>tab.click(Number(line.split(' ')[0])),/stale/);
  await page.getByRole('textbox',{name:'本文'}).fill('専用ブラウザ内の文章');
  assert.equal(await page.getByRole('textbox',{name:'本文'}).inputValue(),'専用ブラウザ内の文章');
  await page.getByLabel('添付').setInputFiles({name:'pixel.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=','base64')});
  assert.equal(await page.getByLabel('添付').evaluate(e=>e.files[0].name),'pixel.png');
  snapshot=await tab.getAXState();line=snapshot.split('\n').find(l=>l.endsWith('button Description: 下のボタン'));
  await tab.click(Number(line.split(' ')[0]));assert.equal(await page.getByRole('button',{name:'下でも押せた',exact:true}).count(),1);
  const png=await tab.getScreenshot();assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  await assert.rejects(()=>tab.navigate('https://example.com/'),/not authorized/);
  await context.addCookies([{name:'synthetic',value:'test-session',url:origin,expires:Math.floor(Date.now()/1000)+3600}]);
  await tab.close();await context.close();context=null;
  context=await chromium.launchPersistentContext(join(root,'profile'),{headless:true,channel:'chromium',chromiumSandbox:true,env:{...process.env,DISPLAY:'',WAYLAND_DISPLAY:''}});
  assert.ok((await context.cookies(origin)).some(c=>c.name==='synthetic'),'dedicated authentication state survives restart');
  const source=await readFile(new URL('../skills/jev-browser-use/playwright-adapter.mjs',import.meta.url),'utf8');
  assert.ok(!/\.bringToFront\s*\(|from\s*['"](?:node:)?child_process|cua\./.test(source),'adapter has no desktop control dependency');
  console.log('PASS real headless Chromium: AX/click/scroll/input/upload/image/profile persistence; local fixture only; model calls 0; desktop calls 0');
} finally {
  if(context)await context.close();await new Promise(r=>server.close(r));
  await rm(root,{recursive:true,force:true});
}
