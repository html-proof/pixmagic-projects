// Not run yet (2026-11-11): Figma's Starter plan allows 20 connector calls a month and the file used them.
// Run once with the Figma connector's `use_figma` on file oGUAW2tcWji76y18nHTHBx. It:
//   1. links the menu, tabs, buttons and dialogs between the 14 desktop screens,
//   2. sets the two prototype starting points,
//   3. makes the three dialog backdrops see-through (they are solid navy today),
//   4. softens the divider in the Sidebar component.
// It is safe to run twice: every step sets a value, none adds a node.
figma.skipInvisibleInstanceChildren = false;
const page = await figma.getNodeByIdAsync('1:5');
await figma.setCurrentPageAsync(page);
const S = { home: '7:2', sales: '7:467', abandoned: '7:810', products: '9:1182', profit: '9:1563', ads: '9:1998', automations: '9:2442', create: '9:2797', integrations: '10:2661', connect: '10:3030', team: '10:3082', invite: '10:3389', report: '10:3488', first: '10:3618' };
const frames = {}; for (const [k, id] of Object.entries(S)) frames[k] = await figma.getNodeByIdAsync(id);
const go = (dest) => [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: S[dest], navigation: 'NAVIGATE', transition: null, preserveScrollPosition: false }] }];
let ok = 0; const failed = [];
const link = async (frameKey, name, dest) => { const n = frames[frameKey].findOne(x => x.name === name); if (!n) { failed.push(`${frameKey}: no "${name}"`); return; } try { await n.setReactionsAsync(go(dest)); ok++; } catch (e) { failed.push(`${frameKey}: ${name}: ${String(e.message || e).slice(0, 80)}`); } };
// The menu, on every screen. A group goes to its first built page.
const NAV = { 'Dashboard': 'home', 'Sales & Orders': 'sales', 'Products': 'products', 'Advertising': 'ads', 'Profit & Loss': 'profit', 'Marketing': 'automations', 'Automations': 'automations', 'Settings': 'integrations', 'Integrations': 'integrations', 'Team & Access': 'team' };
for (const k of Object.keys(S)) for (const [label, dest] of Object.entries(NAV)) await link(k, 'Nav/' + label, dest);
const LINKS = [
  ['home', 'Insight/Sales', 'sales'], ['home', 'Insight/Ads', 'ads'], ['home', 'Insight/Products', 'products'], ['home', 'Action/Checkouts', 'abandoned'], ['home', 'Action/Ads', 'ads'], ['home', 'Action/Connect', 'integrations'],
  ['home', 'Metric/Total sales', 'sales'], ['home', 'Metric/Orders', 'sales'], ['home', 'Metric/Total expenses', 'profit'], ['home', 'Metric/Net profit', 'profit'],
  ['sales', 'Tab/Abandoned checkouts', 'abandoned'], ['sales', 'Download report', 'report'], ['abandoned', 'Tab/Overview', 'sales'], ['abandoned', 'Action/Reminder', 'create'],
  ['report', 'Cancel', 'sales'], ['report', 'Close', 'sales'], ['report', 'Download', 'sales'],
  ['automations', 'Create automation', 'create'], ['create', 'Cancel', 'automations'], ['create', 'Back', 'automations'], ['create', 'Continue', 'automations'],
  ['integrations', 'Integration/Google Ads', 'connect'], ['connect', 'Cancel', 'integrations'], ['connect', 'Close', 'integrations'], ['connect', 'Continue to Google', 'integrations'],
  ['team', 'Invite someone', 'invite'], ['invite', 'Cancel', 'team'], ['invite', 'Close', 'team'], ['invite', 'Send invitation', 'team'],
  ['first', 'Setup button/Connect', 'integrations'], ['first', 'Setup button/Invite', 'team'], ['first', 'Show me around', 'home'],
];
for (const [f, n, d] of LINKS) await link(f, n, d);
page.flowStartingPoints = [{ nodeId: S.first, name: 'A new client, first visit' }, { nodeId: S.home, name: 'Everyday use, from Home' }];
// Dialog backdrops: layer opacity, since an opacity on a variable-bound paint did not take.
const scrims = []; for (const k of ['connect', 'invite', 'report']) { const s = frames[k].findOne(x => x.name === 'Scrim'); if (s) { s.opacity = 0.5; scrims.push(s.id); } }
let divider = 'skipped'; try { const sb = await figma.getNodeByIdAsync('4:264'); const d = sb.findOne(x => x.name === 'Divider'); d.opacity = 0.2; divider = d.id; } catch (e) { divider = 'failed: ' + String(e.message || e).slice(0, 60); }
return { linked: ok, failed, flows: page.flowStartingPoints.length, scrims, divider };
