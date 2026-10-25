import { createSession } from './bridge.mjs';

// This page belongs to a separate browser process. Mouse/keyboard are browser
// protocol events, never OS input, clipboard, or the user's desktop connection.
export async function createPlaywrightTab(page, { allowedOrigins } = {}) {
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.length) throw new Error('Explicit browser origins are required');
  const assertUrl = value => {
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol) || !allowedOrigins.includes(url.origin)) throw new Error('Browser origin is not authorized');
    return url.href;
  };
  const cdp = await page.context().newCDPSession(page);
  let nodes = [], observedUrl = null;
  const invalidate = () => { nodes=[]; observedUrl=null; };
  page.on('framenavigated', frame => { if(frame===page.mainFrame()) invalidate(); });
  const target = index => {
    if(observedUrl!==page.url() || !nodes[index]) throw new Error('Browser target is stale; observe again');
    assertUrl(page.url());
    return nodes[index];
  };
  return Object.freeze({
    async getAXState() {
      assertUrl(page.url());
      const state = await cdp.send('Accessibility.getFullAXTree');
      nodes=state.nodes.filter(n=>!n.ignored && typeof n.role?.value==='string' && typeof n.name?.value==='string' && Number.isInteger(n.backendDOMNodeId));
      observedUrl=page.url();
      return `Browser tab: isolated Chromium URL: "${observedUrl}".\n`+nodes.map((n,i)=>`${i} ${n.role.value} Description: ${n.name.value}`).join('\n');
    },
    async click(index) {
      const node=target(index);
      await cdp.send('DOM.scrollIntoViewIfNeeded',{backendNodeId:node.backendDOMNodeId});
      const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId:node.backendDOMNodeId});
      const q=model.content;
      await page.mouse.click((q[0]+q[2]+q[4]+q[6])/4,(q[1]+q[3]+q[5]+q[7])/4);
      invalidate();
    },
    async pressKey(_target,key) {
      if(!['PageDown','PageUp'].includes(key)) throw new Error('Key requires host action');
      assertUrl(page.url()); await page.keyboard.press(key); invalidate();
    },
    async scroll(targetIndex,direction,amount=1) {
      if(targetIndex!==undefined) throw new Error('Targeted scroll is not supported');
      for(let i=0;i<amount;i++) await this.pressKey(null,direction==='down'?'PageDown':'PageUp');
    },
    async navigate(url) { await page.goto(assertUrl(url),{waitUntil:'domcontentloaded'}); invalidate(); },
    async reload() { assertUrl(page.url()); await page.reload({waitUntil:'domcontentloaded'}); invalidate(); },
    async getScreenshot() { assertUrl(page.url()); return page.screenshot({type:'png'}); },
    async close() { invalidate(); await cdp.detach(); },
  });
}

export async function createPlaywrightSession(page, defaults) {
  return createSession(await createPlaywrightTab(page,defaults),defaults);
}

// The X domain receives typed browser operations, not emulated native MCP tools.
export async function createPlaywrightXBrowser(page,{identity,mapFile=path=>path}) {
  const cdp=await page.context().newCDPSession(page);
  const clickNode=async({node_id})=>{
    const backendNodeId=Number(node_id);
    if(!Number.isSafeInteger(backendNodeId))throw new Error('Invalid browser node');
    await cdp.send('DOM.scrollIntoViewIfNeeded',{backendNodeId});
    const {model}=await cdp.send('DOM.getBoxModel',{backendNodeId});const q=model.content;
    await page.mouse.click((q[0]+q[2]+q[4]+q[6])/4,(q[1]+q[3]+q[5]+q[7])/4);
  };
  return {
    info:async()=>({instance:identity}), url:async()=>page.url(),
    evaluate:({expression})=>page.evaluate(expression),
    async snapshot(){
      const raw=await cdp.send('Accessibility.getFullAXTree');
      const lines=raw.nodes.filter(n=>!n.ignored && n.name?.value).map(n=>`${n.role?.value}: ${n.name.value}`);
      return {...raw,content:[{type:'text',text:lines.join('\n').slice(0,32000)}]};
    },
    async screenshot({format='jpeg',quality=75}={}){
      const data=await page.screenshot({type:format,...(format==='jpeg'?{quality}:{})});
      return {content:[{type:'image',mimeType:`image/${format}`,data:data.toString('base64')}]};
    },
    async activate(){if(page.isClosed())throw new Error('Dedicated page is closed');},
    navigate:({url})=>page.goto(url,{waitUntil:'domcontentloaded'}),
    async waitFor({selector,timeout_ms}){
      try{await page.locator(selector).first().waitFor({state:'attached',timeout:timeout_ms});}
      catch(error){if(error.name==='TimeoutError'){const e=new Error('Browser element wait timed out');e.code='BROWSER_WAIT_TIMEOUT';throw e;}throw error;}
    },
    click:({selector})=>page.locator(selector).first().click(), clickNode,
    type:({text})=>page.keyboard.insertText(text),
    files:({selector,files})=>page.locator(selector).first().setInputFiles(files.map(file=>mapFile(file))),
    fill:({selector,value})=>page.locator(selector).first().fill(value),
    close:()=>cdp.detach(),
  };
}
