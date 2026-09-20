import { createSession } from './bridge.mjs';

function textFrom(result) {
  if (typeof result === 'string') return result;
  if (result?.isError) throw new Error('Claude browser transport failed');
  const value = result?.content?.filter(item => item?.type === 'text').map(item => item.text).join('\n');
  if (typeof value !== 'string' || !value) throw new Error('Claude browser transport returned no text');
  return value;
}

function parseAxTree(raw) {
  let tree;
  try { tree = JSON.parse(raw); } catch { throw new Error('Claude browser transport returned invalid AX state'); }
  if (!Array.isArray(tree?.nodes)) throw new Error('Claude browser transport returned invalid AX state');
  return tree.nodes.flatMap(node => {
    const role = node?.role?.value;
    const name = node?.name?.value;
    const backendId = node?.backendDOMNodeId;
    return typeof role === 'string' && typeof name === 'string' && Number.isInteger(backendId)
      ? [{role,name,backendId}]
      : [];
  });
}

// Adapt the real DeliciousBuding/codex-browser-bridge MCP tool surface to the
// same tab contract used by Codex CUA. No browser driver or second Jev loop.
export function createClaudeCodeTab({tabId,callTool}) {
  if (typeof tabId !== 'string' || !tabId || typeof callTool !== 'function') throw new Error('Claude browser transport requires tabId and callTool');
  let nodeIds = [];
  const call = async (name,args={}) => textFrom(await callTool(name,{tab_id:tabId,...args}));
  const pageScroll = direction => call('codex_cua_scroll',{
    x:500,
    y:500,
    scroll_x:0,
    scroll_y:direction === 'down' ? 600 : -600
  });
  return Object.freeze({
    async getAXState() {
      const [url,raw] = await Promise.all([call('codex_get_url'),call('codex_dom_snapshot')]);
      const nodes = parseAxTree(raw);
      nodeIds = nodes.map(node => String(node.backendId));
      const lines = nodes.map((node,index) => `${index} ${node.role} Description: ${node.name}`);
      return `Browser tab: Claude bridge URL: "${url.trim()}".\n${lines.join('\n')}`;
    },
    async click(index) {
      const nodeId = nodeIds[index];
      if (!nodeId) throw new Error('Claude browser target is stale');
      await call('codex_dom_click',{node_id:nodeId});
    },
    async scroll(target,direction,amount=1) {
      if (target !== undefined) throw new Error('Claude browser targeted scroll requires host handback');
      for (let i=0;i<amount;i++) await pageScroll(direction);
    },
    pressKey: (_target,key) => {
      if (!['PageDown','PageUp'].includes(key)) throw new Error('Claude browser key requires host handback');
      return pageScroll(key === 'PageDown' ? 'down' : 'up');
    },
    reload: () => call('codex_reload')
  });
}

export function createClaudeCodeSession(transport,defaults={}) {
  return createSession(createClaudeCodeTab(transport),defaults);
}
