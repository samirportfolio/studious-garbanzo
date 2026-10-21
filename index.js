// Personal WhatsApp Pairing Bot - FREE, no Meta app needed.
// Flow: user gives number -> dashboard shows pairing code -> user enters code in
// WhatsApp > Linked Devices > Link with phone number -> bot replies to EVERY
// individual sender, understanding Bangla (script+Roman) & English.
// Run: npm install && node index.js  (dashboard: http://localhost:3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

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

let sock = null, connected = false, lastCode = null, lastCodeAt = 0, connecting = false;
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

async function startSock() {
  if (connecting) return; connecting = true;
  const { state, saveCreds } = await useMultiFileAuthState(path.join(BASE, 'auth'));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ['Personal Bot', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') { connected = true; connecting = false; console.log('WhatsApp CONNECTED'); }
    if (connection === 'close') {
      connected = false; connecting = false;
      const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      console.log('WhatsApp closed, loggedOut=', loggedOut);
      if (!loggedOut) setTimeout(startSock, 3000);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const jid = m.key.remoteJid || '';
      // Individual chats only, skip groups/status/broadcast.
      // Accept BOTH @s.whatsapp.net and @lid (WhatsApp now sends many chats as @lid).
      if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
      const txt = m.message.conversation || m.message.extendedTextMessage?.text || '';
      if (!txt.trim()) continue;
      const ans = botReply(jid, txt);
      try { await sock.sendMessage(jid, { text: ans }); } catch (e) { console.log('send error', e.message); }
    }
  });
}
function normalizeNumber(raw) {
  let n = String(raw || '').replace(/[\s\-]/g, '').replace(/^\+/, '');
  if (/^01[3-9]\d{8}$/.test(n)) n = '880' + n.slice(1);
  return n;
}
async function getPairingCode(number) {
  if (connected) return { already: true };
  if (!sock) await startSock();
  // Wait briefly for socket to reach WhatsApp server before asking for a code
  for (let i = 0; i < 20 && !sock; i++) await new Promise(r => setTimeout(r, 500));
  const code = await sock.requestPairingCode(number);
  lastCode = code; lastCodeAt = Date.now();
  return { code };
}

const DASH = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personal WhatsApp Bot - Pairing</title>
<style>body{font-family:system-ui,sans-serif;background:#f0f2f5;margin:0}header{background:linear-gradient(90deg,#075e54,#25d366);color:#fff;padding:20px}header h1{margin:0}.wrap{max-width:900px;margin:auto;padding:16px}.card{background:#fff;border-radius:14px;padding:18px;box-shadow:0 1px 4px rgba(0,0,0,.1);margin-bottom:14px}
input{padding:12px;border:1px solid #ccc;border-radius:20px;width:100%;box-sizing:border-box}button{padding:12px 20px;border:0;border-radius:20px;background:#25d366;color:#fff;font-weight:700;cursor:pointer;margin-top:10px}
.code{font-size:38px;letter-spacing:6px;font-weight:800;text-align:center;background:#f0fdf4;border:2px dashed #25d366;border-radius:12px;padding:16px;margin-top:12px}
table{width:100%;font-size:13px;border-collapse:collapse}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left}</style></head><body>
<header><h1>📱 Personal WhatsApp Bot</h1><p>Number din → Code nin → Linked Devices e boshain → Bot shob customer ke reply dibe</p></header>
<div class="wrap">
<div class="card"><h3>🔗 Connect — shudhu ei 3 step</h3>
<p>Status: <b id="st">Checking...</b></p>
<p><b>Step 1:</b> Niche tomar WhatsApp Business number ta din (jemon: 017XXXXXXXX) ar <b>Get Code</b> chapo.</p>
<input id="num" placeholder="WhatsApp number: 017XXXXXXXX">
<button onclick="pair()">Get Pairing Code</button>
<div id="codeBox"></div>
<p><b>Step 2:</b> Phone e WhatsApp khulo → <b>⋮ → Linked Devices → Link a Device → Link with phone number</b> → uporer code ta boshain. Code taratari boshate hobe, na hole abar Get Code chapo.</p>
<p><b>Step 3:</b> Status <b>✅ Connected</b> holei hoye geche. Tarpor jekono number theke message ashle bot nije bujhe reply dibe.</p>
<p style="font-size:13px;color:#92400e">Note: Code kauke dio na, shudhu nijer phone e boshio. Code expire hole notun code nao.</p></div>
<div class="card"><h3>🧾 Orders</h3><div id="orders"></div></div>
<div class="card"><h3>💬 Recent Chats (shob ID theke)</h3><div id="chats"></div></div>
</div><script>
async function st(){let j=await(await fetch('/api/status')).json();document.getElementById('st').textContent=j.connected?'✅ Connected — bot shob message e reply dicche':'❌ Not connected — upore number diye code nin';}
async function pair(){let n=document.getElementById('num').value.trim();if(!n){alert('Number din age');return;}
document.getElementById('codeBox').innerHTML='Code ana hocche...';
let r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:n})});let j=await r.json();
if(j.already){document.getElementById('codeBox').innerHTML='<p>✅ Agei connected ache, code lagbe na.</p>';}
else if(j.code){document.getElementById('codeBox').innerHTML='<div class="code">'+j.code+'</div><p style="text-align:center">Ei code ta phone er Linked Devices e boshain — taratari!</p>';}
else{document.getElementById('codeBox').innerHTML='<p>❌ '+(j.error||'Code ashe nai, abar try korun')+'</p>';} st();}
async function load(){let o=await(await fetch('/api/orders')).json();document.getElementById('orders').innerHTML=o.length?'<table><tr><th>ID</th><th>Product</th><th>Total</th><th>Name</th></tr>'+o.map(x=>'<tr><td>'+x.id+'</td><td>'+x.product+'</td><td>'+x.price+'</td><td>'+(x.name||'')+'</td></tr>').join('')+'</table>':'Ekhono order nai';
let c=await(await fetch('/api/chats')).json();document.getElementById('chats').innerHTML=c.length?c.slice(-20).map(x=>'<p><b>'+x.sender+'</b> ('+x.role+'): '+x.text+'</p>').join(''):'Ekhono chat nai';}
st();load();setInterval(()=>{st();load();},8000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, obj, type = 'application/json') => { const b = typeof obj === 'string' ? obj : JSON.stringify(obj); res.writeHead(code, { 'Content-Type': type }); res.end(b); };
  const body = () => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });
  if (req.method === 'GET' && url.pathname === '/') return send(200, DASH, 'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { connected, code: lastCode && Date.now() - lastCodeAt < 60000 ? lastCode : null });
  if (req.method === 'GET' && url.pathname === '/api/orders') return send(200, store.orders.slice(-50));
  if (req.method === 'GET' && url.pathname === '/api/chats') return send(200, store.chats.slice(-100));
  if (req.method === 'POST' && url.pathname === '/api/pair') {
    const { number } = await body(); const n = normalizeNumber(number);
    if (!/^8801[3-9]\d{8}$/.test(n)) return send(400, { error: 'Number thik na. Bangladesh number din: 017XXXXXXXX ba 88017XXXXXXXX' });
    try { const out = await getPairingCode(n); return send(200, out); }
    catch (e) { console.log('pair error', e.message); return send(500, { error: 'Code ana jay nai: ' + e.message + '. Abar try korun, ar number thik ache kina dekhun.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/test-reply') {
    const { sender, message } = await body();
    return send(200, { reply: botReply(sender || 'test-sender', message || 'hello') });
  }
  return send(404, { error: 'not found' });
});
server.listen(PORT, () => console.log('Personal bot dashboard: http://localhost:' + PORT));
startSock().catch(e => console.log('start error', e.message));
module.exports = { botReply };
