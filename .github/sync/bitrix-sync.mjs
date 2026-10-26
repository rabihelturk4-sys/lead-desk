/* Lead Desk background check, run by GitHub Actions every 5 minutes.
   Brings leads assigned to me in the chosen Bitrix stage ("Lead assigned") into Lead Desk (No answer, marked NEW),
   moves them to the matched No answer stage in Bitrix, and sends a push notification to the devices that turned them on.
   Needs repository secrets: FIREBASE_SERVICE_ACCOUNT (JSON), BITRIX_WEBHOOK; optional LEADDESK_UID. */
let admin;

const H = 3600e3, D = 24 * H;
const digits = p => String(p || '').replace(/\D/g, '').replace(/^00/, '');
const CC = {'46':['🇸🇪','Sweden','sv'],'47':['🇳🇴','Norway','en'],'45':['🇩🇰','Denmark','en'],'358':['🇫🇮','Finland','en'],'971':['🇦🇪','UAE','ar'],'966':['🇸🇦','Saudi Arabia','ar'],'965':['🇰🇼','Kuwait','ar'],'974':['🇶🇦','Qatar','ar'],'973':['🇧🇭','Bahrain','ar'],'968':['🇴🇲','Oman','ar'],'20':['🇪🇬','Egypt','ar'],'962':['🇯🇴','Jordan','ar'],'961':['🇱🇧','Lebanon','ar'],'964':['🇮🇶','Iraq','ar'],'963':['🇸🇾','Syria','ar'],'212':['🇲🇦','Morocco','ar'],'213':['🇩🇿','Algeria','ar'],'216':['🇹🇳','Tunisia','ar'],'218':['🇱🇾','Libya','ar'],'249':['🇸🇩','Sudan','ar'],'967':['🇾🇪','Yemen','ar'],'970':['🇵🇸','Palestine','ar'],'7':['🇷🇺','Russia / Kazakhstan','ru'],'375':['🇧🇾','Belarus','ru'],'380':['🇺🇦','Ukraine','ru'],'998':['🇺🇿','Uzbekistan','ru'],'996':['🇰🇬','Kyrgyzstan','ru'],'992':['🇹🇯','Tajikistan','ru'],'993':['🇹🇲','Turkmenistan','ru'],'374':['🇦🇲','Armenia','ru'],'995':['🇬🇪','Georgia','ru'],'994':['🇦🇿','Azerbaijan','ru'],'373':['🇲🇩','Moldova','ru'],'44':['🇬🇧','UK','en'],'1':['🇺🇸','USA / Canada','en'],'49':['🇩🇪','Germany','en'],'33':['🇫🇷','France','en'],'39':['🇮🇹','Italy','en'],'34':['🇪🇸','Spain','en'],'31':['🇳🇱','Netherlands','en'],'32':['🇧🇪','Belgium','en'],'41':['🇨🇭','Switzerland','en'],'43':['🇦🇹','Austria','en'],'48':['🇵🇱','Poland','en'],'353':['🇮🇪','Ireland','en'],'263':['🇿🇼','Zimbabwe','en'],'354':['🇮🇸','Iceland','en'],'977':['🇳🇵','Nepal','en'],'94':['🇱🇰','Sri Lanka','en'],'244':['🇦🇴','Angola','en'],'972':['🇮🇱','Israel','en'],'351':['🇵🇹','Portugal','en'],'30':['🇬🇷','Greece','en'],'90':['🇹🇷','Turkey','en'],'98':['🇮🇷','Iran','en'],'91':['🇮🇳','India','en'],'92':['🇵🇰','Pakistan','en'],'880':['🇧🇩','Bangladesh','en'],'86':['🇨🇳','China','en'],'852':['🇭🇰','Hong Kong','en'],'65':['🇸🇬','Singapore','en'],'60':['🇲🇾','Malaysia','en'],'61':['🇦🇺','Australia','en'],'64':['🇳🇿','New Zealand','en'],'27':['🇿🇦','South Africa','en'],'234':['🇳🇬','Nigeria','en'],'254':['🇰🇪','Kenya','en'],'55':['🇧🇷','Brazil','en'],'52':['🇲🇽','Mexico','en']};
const WIN_GROUPS = [
  [['971','968','974','965','973','966','962','961','20'], [[11,13],[16,19]], 'Gulf'],
  [['44','353','351','354'], [[13,15],[17,19]], 'UK'],
  [['31','32','33','34','39','41','43','45','46','47','48','49','358','30','36','420','40','90'], [[12,14],[17,19]], 'Europe'],
  [['91','92','94','880','977'], [[9.5,11],[14.5,16.5]], 'South Asia'],
  [['1','52','55'], [[16,17.5],[19,21]], 'Americas'],
  [['61','64','65','60','852','86'], [[7,10],[12,14]], 'Asia-Pacific'],
];

function callWindows(phone){ const d = digits(phone); for (const n of [3, 2, 1]) { const g = WIN_GROUPS.find(w => w[0].includes(d.slice(0, n))); if (g) return g[1]; } return [[11, 13], [16, 19]]; }
export function nextWindowAt(phone, from = Date.now()){
  const off = 4 * H, day0 = Math.floor((from + off) / D) * D;
  for (let k = 0; k < 3; k++) for (const [a] of callWindows(phone)) { const t = day0 + k * D + a * H - off; if (t > from + 30 * 60e3) return t; }
  return from + D;
}
function phoneInfo(p){ const d = digits(p); for (const n of [3, 2, 1]) { const c = CC[d.slice(0, n)]; if (c) return {flag: c[0], country: c[1], lang: c[2]}; } return {flag: '🌐', country: '', lang: 'en'}; }
const stamp = t => { const d = new Date(t + 4 * H), z = n => String(n).padStart(2, '0'); return `${z(d.getUTCDate())}-${z(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${z(d.getUTCHours())},${z(d.getUTCMinutes())}`; };

/* Decide what to do with the Bitrix leads, given the leads already in Lead Desk. Pure: no network. */
export function plan(bxLeads, existing, now = Date.now()){
  const byBx = new Map(), byPhone = new Map(), byEmail = new Map();
  for (const l of existing) {
    const b = String(l.bxId || l.leadNo || ''); if (b) byBx.set(b, l);
    const d = digits(l.phone); if (d.length >= 7) byPhone.set(d, l);
    if (l.email) byEmail.set(String(l.email).toLowerCase(), l);
  }
  const creates = [], updates = [], moves = [];
  for (const b of bxLeads) {
    const id = String(b.ID);
    moves.push(id);                                   /* every lead still in the incoming stage moves to No answer */
    if (byBx.has(id)) continue;                       /* already in Lead Desk */
    const phone = ((b.PHONE || [])[0] || {}).VALUE || '', email = ((b.EMAIL || [])[0] || {}).VALUE || '';
    const name = [b.NAME, b.LAST_NAME].filter(Boolean).join(' ') || b.TITLE || 'New lead';
    const ex = (digits(phone).length >= 7 && byPhone.get(digits(phone))) || (email && byEmail.get(email.toLowerCase()));
    if (ex) { updates.push({docId: ex.id, name: ex.name, patch: {bxId: id, leadNo: ex.leadNo || id, stage: 'noanswer', fresh: true, freshAt: now, nextAt: nextWindowAt(ex.phone, now)},
      hist: {t: now, k: 'note', txt: 'Came in again from Bitrix (lead #' + id + ')'}}); continue; }
    const info = phoneInfo(phone);
    const note = [b.COMMENTS && String(b.COMMENTS).replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').trim(), b.SOURCE_DESCRIPTION].filter(Boolean).join('\n');
    creates.push({docId: 'X' + id, name, doc: {name, phone: phone ? '+' + digits(phone) : '', email, flag: info.flag, country: info.country, lang: info.lang,
      source: b.SOURCE_ID || 'Bitrix', budget: null, purpose: null, ptype: null, timeline: null, project: '', note, crm: '', leadNo: id, campaign: '', rule: '',
      stage: 'noanswer', hot: false, noAnswer: 0, said: [], todo: '', createdAt: now, lastAt: null, nextAt: nextWindowAt(phone, now), meetingAt: null, meetingKind: '',
      fresh: true, freshAt: now, bxId: id, crmCreated: b.DATE_CREATE ? Date.parse(b.DATE_CREATE) : now, crmTimeKnown: false,
      history: [{t: now, k: 'created', txt: 'New lead from Bitrix (lead #' + id + ') – brought in automatically ' + stamp(now)}]}});
  }
  return {creates, updates, moves};
}

function form(obj, pre = '', out = []){
  for (const [k, v] of Object.entries(obj)) { if (v === undefined || v === null) continue; const key = pre ? pre + '[' + k + ']' : k;
    if (typeof v === 'object') form(v, key, out); else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v)); }
  return out.join('&');
}
async function bx(hook, method, params){
  const r = await fetch(hook + method + '.json', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: form(params)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Bitrix ' + method + ': ' + (j.error_description || j.error || r.status));
  return j.result;
}

async function main(){
  if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.BITRIX_WEBHOOK) { console.log('::notice::Secrets FIREBASE_SERVICE_ACCOUNT and BITRIX_WEBHOOK are not set yet – nothing to do.'); return; }
  admin = (await import('firebase-admin')).default;
  admin.initializeApp({credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});
  const fs = admin.firestore();
  const hook = process.env.BITRIX_WEBHOOK.trim().replace(/\/?$/, '/');
  let uid = (process.env.LEADDESK_UID || '').trim();
  if (!uid) { const users = await fs.collection('users').listDocuments(); if (users.length !== 1) throw new Error('Found ' + users.length + ' Lead Desk users – set the LEADDESK_UID secret.'); uid = users[0].id; }
  const root = fs.collection('users').doc(uid), syncRef = root.collection('config').doc('sync');
  try {
    const cfg = (await root.collection('config').doc('main').get()).data() || {};
    if (!cfg.bxInStage) { console.log('::notice::No incoming Bitrix stage chosen in Lead Desk'); await syncRef.set({lastRun: Date.now(), lastAdded: 0, lastError: 'Choose the incoming Bitrix stage in Lead Desk → Messages → Bitrix24.'}, {merge: true}); return; }
    const me = (hook.match(/\/rest\/(\d+)\//) || [])[1];
    const list = await bx(hook, 'crm.lead.list', {filter: {STATUS_ID: cfg.bxInStage, ASSIGNED_BY_ID: me},
      select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'COMMENTS', 'DATE_CREATE'], order: {DATE_CREATE: 'DESC'}}) || [];
    const existing = (await root.collection('leads').get()).docs.map(d => ({...d.data(), id: d.id}));
    const {creates, updates, moves} = plan(list, existing);
    for (const c of creates) await root.collection('leads').doc(c.docId).set(c.doc, {merge: true});
    for (const u of updates) await root.collection('leads').doc(u.docId).update({...u.patch, history: admin.firestore.FieldValue.arrayUnion(u.hist)});
    const target = (cfg.bxMap || {}).noanswer;
    if (target && target !== cfg.bxInStage) for (const id of moves) {
      try { await bx(hook, 'crm.lead.update', {id, fields: {STATUS_ID: target}}); } catch (e) { console.log(e.message); }
    }
    const names = [...creates, ...updates].map(x => x.name);
    if (names.length) {
      const title = names.length === 1 ? 'New lead: ' + names[0] : names.length + ' new leads';
      const body = (names.length === 1 ? 'In No answer – call now.' : names.slice(0, 4).join(', ') + ' – in No answer, call now.');
      const devices = await root.collection('devices').get();
      for (const d of devices.docs) {
        try { await admin.messaging().send({token: d.data().token, data: {title, body, url: './'}, webpush: {headers: {Urgency: 'high', TTL: '86400'}}}); }
        catch (e) { if (/registration-token-not-registered|invalid-argument|invalid-registration/.test(e.code || '')) await d.ref.delete(); else console.log('push:', e.code || e.message); }
      }
    }
    await syncRef.set({lastRun: Date.now(), lastAdded: names.length, lastError: '', checked: list.length}, {merge: true});
    console.log(`::notice::Checked ${list.length} Bitrix leads, added ${creates.length}, updated ${updates.length}, moved ${moves.length}.`);
  } catch (e) {
    await syncRef.set({lastRun: Date.now(), lastError: String(e.message || e)}, {merge: true}).catch(() => {});
    throw e;
  }
}
if (process.argv[1] && process.argv[1].endsWith('bitrix-sync.mjs')) main().catch(e => { console.log('::error::' + (e.message || e)); process.exit(1); });
