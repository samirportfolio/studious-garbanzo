// WAHA bridge - receives WAHA webhooks, replies with the same Bangla/English bot brain.
// Env: WAHA_URL (e.g. https://waha-whatsapp-bot.onrender.com), WAHA_API_KEY, PORT
// WAHA webhook: POST /webhook/waha with {event, session, payload:{from, body, ...}}
// Send: POST {WAHA_URL}/api/sendText with X-Api-Key, {session:'default', chatId:'<num>@c.us', text}
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const BASE = __dirname;
const DATA = path.join(BASE, 'data');
fs.mkdirSync(DATA, { recursive: true });
const business = JSON.parse(fs.readFileSync(path.join(BASE, 'business.json'), 'utf8'));
const products = JSON.parse(fs.readFileSync(path.join(BASE, 'products.json'), 'utf8'));
let store = { customers: {}, states: {}, orders: [], chats: [], handovers: [] };
const storeFile = path.join(DATA, 'store.json');
try { store = Object.assign(store, JSON.parse(fs.readFileSync(storeFile, 'utf8'))); } catch {}
function saveStore() { try { fs.writeFileSync(storeFile, JSON.stringify(store, null, 2)); } catch {} }

let sock = null, connected = false, lastCode = null, lastCodeAt = 0, connecting = false, wsOpen = false, lastQr = null, lastQrAt = 0, restartTimer = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = t => (t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function findProduct(text) {
  const t = norm(text);
  for (const p of products) {
    if (t.includes(norm(p.name)) || t === p.id) return p;
    const words = norm(p.name).split(' ').filter(w => w.length > 3);
    if (words.length && words.filter(w => t.includes(w)).length >= Math.max(1, words.length - 1)) return p;
  }
  return null;
}
function productList() {
  return 'Amader product/service list:\n' + products.map((p, i) => `${i + 1}. ${p.name} - ${p.price} BDT (${p.stock > 0 ? 'stock ache' : 'stock nai'})`).join('\n') + '\n\nKon ta nite chan? Nam bollei order shuru kore dibo.';
}
function helpText() {
  return "Ami ja ja korte pari:\n• 'product' - list dekhabe\n• 'dam' - product er dam bolbe\n• 'delivery' - delivery charge/time bolbe\n• 'order' - order nebe (product → name → phone → address → confirm)\n• 'amar order' - apnar order er status\n• 'human' - team member er sathe connect\n\nBangla ar English - duita tei likhte paren.";
}

// ---- Bot brain: replies to EVERY sender, no whitelist, no test-number only ----
function botReply(sender, raw) {
  const text = (raw || '').trim(), t = norm(text);
  const cust = store.customers[sender] || (store.customers[sender] = { id: sender, name: '', phone: '', address: '', last: new Date().toISOString() });
  store.chats.push({ sender, role: 'user', text, ts: new Date().toISOString() });
  const st = store.states[sender] || { step: 'idle', data: {} };
  const reply = msg => { store.chats.push({ sender, role: 'bot', text: msg, ts: new Date().toISOString() }); saveStore(); return msg; };

  if (['human', 'manush', 'মানুষ', 'agent', 'real person'].some(k => t.includes(norm(k)))) {
    store.handovers.push({ sender, reason: text, ts: new Date().toISOString() });
    return reply('Thik ache, ami ekjon human team member ke janiye dilam. Uni khub taratari apnar sathe kotha bolben. Apnar number ta ekhane diye rakhun please.');
  }
  // Order flow, per-sender independent (many customers at once)
  if (st.step === 'ask_product') {
    let p = findProduct(text); const m = text.match(/(\d+)/);
    if (!p && m && +m[1] >= 1 && +m[1] <= products.length) p = products[+m[1] - 1];
    if (!p) return reply('Product ta bujhte parlam na. List theke nam ba number ta bolun:\n' + productList());
    if (p.stock <= 0) { store.states[sender] = { step: 'idle', data: {} }; return reply(`Dukkhito, ${p.name} ekhon stock e nai. Onno kichu dekhben?`); }
    store.states[sender] = { step: 'ask_name', data: { product: p.name, price: p.price } };
    return reply(`Darun! ${p.name} - ${p.price} BDT.\nOrder er jonno apnar full name ta bolun.`);
  }
  if (st.step === 'ask_name') { st.data.name = text; st.step = 'ask_phone'; store.states[sender] = st; return reply('Dhonnobad. Ebar apnar phone number ta din.'); }
  if (st.step === 'ask_phone') {
    if (!/(\+?880|0)1[3-9]\d{8}|\d{8,}/.test(text)) return reply('Phone number ta thik mone hocche na, abar din please (11 digit).');
    st.data.phone = text; st.step = 'ask_address'; store.states[sender] = st; return reply('Ebar delivery address ta din (elaka + shohor).');
  }
  if (st.step === 'ask_address') {
    st.data.address = text;
    const inside = t.includes('dhaka') || text.includes('ঢাকা');
    const delivery = inside ? business.delivery_inside_dhaka : business.delivery_outside_dhaka;
    st.data.delivery = delivery; st.data.total = +st.data.price + +delivery; st.step = 'confirm'; store.states[sender] = st;
    return reply(`Confirm korun please:\nProduct: ${st.data.product}\nDam: ${st.data.price} BDT + Delivery: ${delivery} BDT = Total ${st.data.total} BDT\nName: ${st.data.name}\nPhone: ${st.data.phone}\nAddress: ${st.data.address}\n\nShob thik thakle 'yes' likhun, cancel korte 'no' likhun.`);
  }
  if (st.step === 'confirm') {
    if (['yes', 'ha', 'হ্যাঁ', 'ok', 'thik', 'confirm'].some(k => t.includes(norm(k)))) {
      const oid = 'ORD' + String(Date.now()).slice(-6);
      store.orders.push({ id: oid, sender, product: st.data.product, price: st.data.total, name: st.data.name, phone: st.data.phone, address: st.data.address, status: 'confirmed', ts: new Date().toISOString() });
      Object.assign(cust, { name: st.data.name, phone: st.data.phone, address: st.data.address });
      store.states[sender] = { step: 'idle', data: {} };
      return reply(`Apnar order ti shofol vabe neya hoyeche! Order ID: #${oid}\nTotal: ${st.data.total} BDT (${business.payment})\nDelivery time: ${business.delivery_time}\nDhonnobad!`);
    }
    store.states[sender] = { step: 'idle', data: {} };
    return reply("Order cancel kore dilam. Abar order korte chaile 'order' likhun.");
  }
  // Intents: specific BEFORE generic, so "delivery charge koto?" and "amar order" are not hijacked
  if (['amar order', 'track', 'order status', 'order id', 'order koi'].some(k => t.includes(norm(k)))) {
    const rows = store.orders.filter(o => o.sender === sender).slice(-3);
    return reply(rows.length ? 'Apnar shesh order:\n' + rows.map(r => `#${r.id} - ${r.product} - ${r.status}`).join('\n') : 'Ei number e ekhono kono order pai ni.');
  }
  if (['delivery', 'charge', 'ডেলিভারি', 'kobe pabo', 'koto din'].some(k => t.includes(norm(k)))) {
    return reply(`Delivery charge: Dhaka r vitore ${business.delivery_inside_dhaka} BDT, baire ${business.delivery_outside_dhaka} BDT.\nTime: ${business.delivery_time}`);
  }
  if (['payment', 'bkash', 'বিকাশ', 'nagad'].some(k => t.includes(norm(k)))) return reply(`Payment: ${business.payment}`);
  if (['help', 'ki korte paro', 'সাহায্য'].some(k => t.includes(norm(k)))) return reply(helpText());
  if (['dam', 'price', 'দাম', 'cost'].some(k => t.includes(norm(k)))) {
    const p = findProduct(text);
    return reply(p ? `${p.name} er dam ${p.price} BDT. Stock: ${p.stock > 0 ? 'ache' : 'nai'}. Order korte chaile 'order' likhun.` : productList());
  }
  if (['order korte', 'order dibo', 'order', 'kinte chai', 'কিনতে', 'অর্ডার', 'nite chai', 'buy'].some(k => t.includes(norm(k)))) {
    const p = findProduct(text);
    if (p) { store.states[sender] = { step: 'ask_name', data: { product: p.name, price: p.price } }; return reply(`${p.name} - ${p.price} BDT. Order er jonno full name ta bolun.`); }
    store.states[sender] = { step: 'ask_product', data: {} };
    return reply('Obosshoi! Kon product/service ta nite chan?\n' + productList());
  }
  if (['product', 'service', 'ki ki', 'list', 'কি আছে', 'সার্ভিস'].some(k => t.includes(norm(k)))) return reply(productList());
  if (['hello', 'hi', 'salam', 'আসসালামু', 'হ্যালো', 'hey'].some(k => t.includes(norm(k)))) {
    return reply((cust.name ? `Welcome back, ${cust.name}! ` : '') + business.welcome);
  }
  if (['thank', 'dhonnobad', 'ধন্যবাদ'].some(k => t.includes(norm(k)))) return reply('Apnakeo dhonnobad! Aro kichu lagle bolben.');
  // Fallback: never stay silent - understand what we can, otherwise help
  const p = findProduct(text);
  if (p) return reply(`${p.name} er dam ${p.price} BDT. Order korte chaile 'order' likhun, list dekhte 'product' likhun.`);
  return reply('Bujhte parlam na, dukkhito. ' + helpText());
}


function sendViaWaha(chatId, text) {
  return new Promise((resolve) => {
    const base = (process.env.WAHA_URL || '').replace(/\/$/, '');
    const key = process.env.WAHA_API_KEY || '';
    if (!base || !key) { console.log('WAHA not configured (URL/API key missing), reply not sent. Reply was:', text); return resolve(false); }
    const payload = JSON.stringify({ session: 'default', chatId, text });
    const u = new URL(base + '/api/sendText');
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => { console.log('WAHA send', r.statusCode, d.slice(0, 200)); resolve(r.statusCode >= 200 && r.statusCode < 300); }); });
    req.on('error', (e) => { console.log('WAHA send error', e.message); resolve(false); });
    req.write(payload); req.end();
  });
}
const DASH = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WAHA Bot Bridge</title><style>body{font-family:system-ui,sans-serif;background:#f0f2f5;margin:0}header{background:linear-gradient(90deg,#075e54,#25d366);color:#fff;padding:20px}.wrap{max-width:900px;margin:auto;padding:16px}.card{background:#fff;border-radius:14px;padding:18px;margin-bottom:14px}</style></head><body><header><h1>WAHA Bot Bridge</h1><p>WAHA webhook in, bot brain reply out</p></header><div class="wrap"><div class="card"><h3>Status</h3><div id="s">Checking...</div><p>Webhook URL (WAHA session e boshate hobe): <b id="wh"></b>/webhook/waha</p></div><div class="card"><h3>Orders</h3><div id="o"></div></div><div class="card"><h3>Recent Chats</h3><div id="c"></div></div></div><script>async function load(){let s=await(await fetch('/api/status')).json();document.getElementById('s').textContent=s.configured?'Configured - WAHA URL + key set':'Not configured yet - WAHA URL / key baki';document.getElementById('wh').textContent=location.origin;let o=await(await fetch('/api/orders')).json();document.getElementById('o').innerHTML=o.length?o.map(x=>'<p>#'+x.id+' - '+x.product+' - '+x.price+'</p>').join(''):'Ekhono order nai';let c=await(await fetch('/api/chats')).json();document.getElementById('c').innerHTML=c.length?c.slice(-20).map(x=>'<p><b>'+x.sender+'</b> ('+x.role+'): '+x.text+'</p>').join(''):'Ekhono chat nai';}load();setInterval(load,8000);</script></body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj, type = 'application/json') => { const b = typeof obj === 'string' ? obj : JSON.stringify(obj); res.writeHead(code, { 'Content-Type': type }); res.end(b); };
  if (req.method === 'GET' && url.pathname === '/') return send(200, DASH, 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { configured: !!(process.env.WAHA_URL && process.env.WAHA_API_KEY) });
  if (req.method === 'GET' && url.pathname === '/api/orders') return send(200, store.orders.slice(-50));
  if (req.method === 'GET' && url.pathname === '/api/chats') return send(200, store.chats.slice(-100));
  if (req.method === 'POST' && url.pathname === '/api/test-reply') {
    let d = ''; req.on('data', c => d += c); req.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch {} send(200, { reply: botReply(j.sender || 'test-sender', j.message || 'hello') }); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/webhook/waha') {
    let raw = ''; req.on('data', c => raw += c); req.on('end', async () => {
      send(200, { ok: true });
      let ev = {}; try { ev = JSON.parse(raw); } catch { return; }
      const p = ev.payload || ev;
      if (ev.event && !['message', 'message.any'].includes(ev.event)) return;
      if (p.fromMe) return;
      const fromRaw = p.from || p.chatId || '';
      const text = p.body || p.text || (p.text && p.text.body) || '';
      if (!fromRaw || !String(text).trim()) return;
      if (String(fromRaw).endsWith('@g.us') || String(fromRaw).includes('@broadcast') || String(fromRaw).includes('@newsletter')) return;
      const sender = String(fromRaw).replace(/@.*$/, '');
      const ans = botReply(sender, String(text));
      const chatId = sender + '@c.us';
      await sendViaWaha(chatId, ans);
    });
    return;
  }
  return send(404, { error: 'not found' });
});
server.listen(PORT, () => console.log('WAHA bridge: http://localhost:' + PORT));
