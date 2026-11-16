/* Copy every Bitrix lead assigned to you – all details and all comments – into Lead Desk. Read-only towards Bitrix:
   nothing is moved, changed or commented there. Runs a few hundred leads per background run until all are copied,
   and can be started again from Lead Desk (Settings → Bitrix24 → Copy all from Bitrix). */
import {form, nextWindowAt} from './bitrix-sync.mjs';
const D = 24 * 3600e3;
const digits = p => String(p || '').replace(/\D/g, '').replace(/^00/, '');
const plain = c => String(c || '').replace(/\[\/?[a-z]+[^\]]*\]/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\r/g, '').trim();
const flat = x => String(x || '').replace(/\s+/g, ' ').trim();
const CC = {46: ['🇸🇪', 'Sweden', 'sv'], 47: ['🇳🇴', 'Norway', 'en'], 45: ['🇩🇰', 'Denmark', 'en'], 358: ['🇫🇮', 'Finland', 'en'], 971: ['🇦🇪', 'UAE', 'ar'], 966: ['🇸🇦', 'Saudi Arabia', 'ar'], 965: ['🇰🇼', 'Kuwait', 'ar'],
  974: ['🇶🇦', 'Qatar', 'ar'], 973: ['🇧🇭', 'Bahrain', 'ar'], 968: ['🇴🇲', 'Oman', 'ar'], 962: ['🇯🇴', 'Jordan', 'ar'], 961: ['🇱🇧', 'Lebanon', 'ar'], 20: ['🇪🇬', 'Egypt', 'ar'], 44: ['🇬🇧', 'UK', 'en'], 353: ['🇮🇪', 'Ireland', 'en'],
  49: ['🇩🇪', 'Germany', 'en'], 33: ['🇫🇷', 'France', 'en'], 31: ['🇳🇱', 'Netherlands', 'en'], 32: ['🇧🇪', 'Belgium', 'en'], 41: ['🇨🇭', 'Switzerland', 'en'], 43: ['🇦🇹', 'Austria', 'en'], 39: ['🇮🇹', 'Italy', 'en'], 34: ['🇪🇸', 'Spain', 'en'],
  48: ['🇵🇱', 'Poland', 'en'], 7: ['🇷🇺', 'Russia', 'ru'], 380: ['🇺🇦', 'Ukraine', 'ru'], 375: ['🇧🇾', 'Belarus', 'ru'], 90: ['🇹🇷', 'Turkey', 'en'], 91: ['🇮🇳', 'India', 'en'], 92: ['🇵🇰', 'Pakistan', 'en'], 1: ['🇺🇸', 'USA/Canada', 'en']};
const info = p => { const d = digits(p); for (const n of [3, 2, 1]) { const c = CC[d.slice(0, n)]; if (c) return {flag: c[0], country: c[1], lang: c[2]}; } return {flag: '🌐', country: '', lang: 'en'}; };

async function bx(hook, method, params){
  const r = await fetch(hook + method + '.json', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: form(params || {})});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Bitrix ' + method + ': ' + (j.error_description || j.error || r.status));
  return j;
}

/* Comments of up to 50 leads in one Bitrix call */
async function timelineFor(hook, ids){
  const cmd = {}; ids.forEach(id => { cmd['c' + id] = 'crm.timeline.comment.list?' + new URLSearchParams({'filter[ENTITY_ID]': id, 'filter[ENTITY_TYPE]': 'lead'}).toString(); });
  const res = ((await bx(hook, 'batch', {halt: 0, cmd})).result || {}).result || {};
  const out = {}; ids.forEach(id => { out[id] = Array.isArray(res['c' + id]) ? res['c' + id] : []; }); return out;
}

export async function fullImport({admin, root, hook, cfg, sync, set, notes, leads, now}){
  const req = cfg.bxFullImport || 0, st = sync.fullImp || null;
  let state = st && (st.req || 0) >= req ? st : {req: req || now, start: 0, done: false, added: 0, updated: 0, comments: 0, total: 0};
  if (state.done) return;
  const me = (hook.match(/\/rest\/(\d+)\//) || [])[1], map = cfg.bxMap || {};
  const back = {}; for (const k of ['noanswer', 'talking', 'workshop', 'pool', 'later', 'new', 'hot', 'meeting', 'nego', 'closed', 'lost', 'cold']) if (map[k] && !back[map[k]]) back[map[k]] = k;
  const statuses = ((await bx(hook, 'crm.status.list', {filter: {ENTITY_ID: 'STATUS'}})).result || []);
  const failed = new Set(statuses.filter(x => (x.EXTRA || {}).SEMANTICS === 'F' || /junk/i.test(x.STATUS_ID)).map(x => x.STATUS_ID)); if (map.junk) failed.add(map.junk);
  const names = Object.fromEntries(statuses.map(x => [x.STATUS_ID, x.NAME]));
  const byBx = new Map(), byPhone = new Map(), byEmail = new Map();
  for (const l of leads) { const b = String(l.bxId || l.leadNo || ''); if (b) byBx.set(b, l); const d = digits(l.phone); if (d.length >= 7) byPhone.set(d, l); if (l.email) byEmail.set(String(l.email).toLowerCase(), l); }
  const reqIds = (cfg.bxReq || []).map(q => q.id);
  const rows = [];
  for (let page = 0; page < 4; page++) {                                   /* 200 leads per run */
    const j = await bx(hook, 'crm.lead.list', {filter: {ASSIGNED_BY_ID: me}, select: ['*', 'UF_*', 'PHONE', 'EMAIL'], order: {ID: 'ASC'}, start: state.start});
    rows.push(...(j.result || [])); state.total = j.total || state.total;
    if (j.next) state.start = j.next; else { state.start += (j.result || []).length; state.done = true; break; }
  }
  const tl = {};
  for (let i = 0; i < rows.length; i += 50) Object.assign(tl, await timelineFor(hook, rows.slice(i, i + 50).map(b => String(b.ID))));
  const ref = root.collection('leads'); let batch = root.firestore.batch(), ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = root.firestore.batch(); ops = 0; } };
  for (const b of rows) {
    const id = String(b.ID), phone = ((b.PHONE || [])[0] || {}).VALUE || '', email = ((b.EMAIL || [])[0] || {}).VALUE || '';
    const ex = byBx.get(id) || (digits(phone).length >= 7 && byPhone.get(digits(phone))) || (email && byEmail.get(email.toLowerCase()));
    const known = new Set([...(ex && ex.history || []).map(h => flat(String(h.txt || '').replace(/^Bitrix comment: /, '')).slice(0, 200)), flat((ex && (ex.note || ex.crm)) || '').slice(0, 200)]);
    const comments = (tl[id] || []).map(c => ({t: Date.parse(c.CREATED) || now, txt: plain(c.COMMENT), cid: +c.ID || 0})).filter(c => c.txt);
    const field = plain(b.COMMENTS);
    const hist = []; for (const c of comments) { const k = flat(c.txt).slice(0, 200); if (!known.has(k)) { known.add(k); hist.push({t: c.t, k: 'note', txt: 'Bitrix comment: ' + c.txt.slice(0, 1500)}); } }
    const cmax = comments.reduce((m, c) => Math.max(m, c.cid), 0);
    const answers = {}; for (const q of reqIds) if (b[q] != null && b[q] !== '' && !(Array.isArray(b[q]) && !b[q].length)) answers[q] = String(Array.isArray(b[q]) ? b[q][0] : b[q]);
    state.comments += hist.length;
    if (ex) {
      const patch = {bxId: id};
      if (!ex.email && email) patch.email = email;
      if (!digits(ex.phone) && phone) patch.phone = '+' + digits(phone);
      if (!ex.crm && field) patch.crm = field.slice(0, 4000);
      if (!ex.crmCreated && b.DATE_CREATE) patch.crmCreated = Date.parse(b.DATE_CREATE);
      if (Object.keys(answers).length) patch.bxReq = {...(ex.bxReq || {}), ...answers};
      if (cmax > (ex.bxCmtMax || 0)) patch.bxCmtMax = cmax;
      if (hist.length) patch.history = admin.firestore.FieldValue.arrayUnion(...hist);
      batch.update(ref.doc(ex.id), patch); ops++; state.updated++;
    } else {
      const name = [b.NAME, b.SECOND_NAME, b.LAST_NAME].filter(Boolean).join(' ') || b.TITLE || 'Lead ' + id, i = info(phone);
      const incoming = b.STATUS_ID === cfg.bxInStage, stage = failed.has(b.STATUS_ID) ? 'junkbx' : incoming ? 'new' : (back[b.STATUS_ID] || 'new');
      const last = Date.parse(b.LAST_ACTIVITY_TIME || b.DATE_MODIFY || '') || null;
      batch.set(ref.doc('X' + id), {name, phone: phone ? '+' + digits(phone) : '', email, flag: i.flag, country: i.country, lang: i.lang, source: b.SOURCE_ID || 'Bitrix',
        budget: null, purpose: null, ptype: null, timeline: null, project: '', note: '', crm: field.slice(0, 4000), leadNo: id, bxId: id, campaign: '', stage,
        hot: false, noAnswer: 0, said: [], todo: '', createdAt: now, lastAt: incoming ? null : last, nextAt: incoming ? nextWindowAt(phone, now) : null, meetingAt: null, meetingKind: '',
        fresh: incoming, freshAt: incoming ? now : null, crmCreated: b.DATE_CREATE ? Date.parse(b.DATE_CREATE) : null, bxStatus: names[b.STATUS_ID] || b.STATUS_ID || '',
        bxReq: answers, bxCmtMax: cmax, ...(['later', 'pool'].includes(stage) ? {needDate: true} : {}),
        history: [{t: now, k: 'created', txt: 'Copied from Bitrix (lead #' + id + ', stage ' + (names[b.STATUS_ID] || b.STATUS_ID || '?') + ')'}, ...hist.sort((x, y) => x.t - y.t)]});
      ops++; state.added++;
    }
    if (ops >= 400) await flush();
  }
  await flush();
  set.fullImp = state;
  notes.push(`Bitrix copy: ${Math.min(state.start, state.total || state.start)}/${state.total || '?'} leads (${state.added} new, ${state.updated} updated, ${state.comments} comments)${state.done ? ' – done' : ''}`);
}
