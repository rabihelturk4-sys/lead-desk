/* Phone alerts and two-way updates, run every few minutes by the background service:
   - morning summary at 9:00 Dubai
   - hot lead going cold (no contact for 2 days), max once a day per lead
   - meeting reminders: the day before and 1 hour before
   - client replied by email (Zoho inbox) → alert, comment, lead back to Contacted
   - changes made in Bitrix (stage, new comment) → copied into Lead Desk */
import {form} from './bitrix-sync.mjs';
const H = 3600e3, D = 24 * H;
const dubai = t => new Date(t + 4 * H);
const dubaiDay = t => dubai(t).toISOString().slice(0, 10);
const hhmm = t => dubai(t).toISOString().slice(11, 16);
const stamp = t => { const d = dubai(t), z = n => String(n).padStart(2, '0'); return `${z(d.getUTCDate())}-${z(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${z(d.getUTCHours())},${z(d.getUTCMinutes())}`; };
const CLOSED = ['closed', 'lost', 'junk', 'later', 'pool', 'workshop'];
const NAMES = {new: 'New', noanswer: 'No answer', talking: 'Contacted', hot: 'HOT', meeting: 'Meeting booked', nego: 'Negotiation', later: 'Buy later', pool: 'Pool', workshop: 'Workshop', closed: 'Closed', lost: 'Lost'};
export const isOpen = l => !CLOSED.includes(l.stage);
export const isHot = l => !!l.hot || ['hot', 'meeting', 'nego'].includes(l.stage);
export const goingCold = (l, now) => isOpen(l) && isHot(l) && (!l.lastAt || l.lastAt < now - 2 * D) && !(l.nextAt && l.nextAt > now);

/* What the morning alert says */
export function summary(leads, now){
  const end = Date.parse(dubaiDay(now) + 'T23:59:59+04:00');
  const hot = leads.filter(l => goingCold(l, now)).length;
  const due = leads.filter(l => l.nextAt && l.nextAt <= end && !['closed', 'lost', 'junk'].includes(l.stage)).length;
  const meets = leads.filter(l => l.stage === 'meeting' && l.meetingAt && l.meetingAt >= now - 2 * H && l.meetingAt <= end).length;
  const fresh = leads.filter(l => l.fresh).length;
  const forgot = leads.filter(l => ['talking', 'hot', 'nego', 'meeting'].includes(l.stage) && (l.lastAt || l.createdAt || 0) < now - 14 * D && !(l.nextAt && l.nextAt > now)).length;
  const parts = [hot && `${hot} hot going cold`, meets && `${meets} meeting${meets > 1 ? 's' : ''}`, due && `${due} follow-up${due > 1 ? 's' : ''}`, fresh && `${fresh} new`, forgot && `${forgot} forgotten`].filter(Boolean);
  return parts.length ? 'Today: ' + parts.join(' · ') + '. Tap to start your day.' : 'Nothing due today – a good day to call your Pool leads.';
}

/* The client's own words from an email reply: drop the quoted part and signatures */
export function replySnippet(text){
  const lines = String(text || '').replace(/\r/g, '').split('\n'); const out = [];
  for (const s of lines) {
    if (/^\s*>/.test(s) || /^\s*(On .+wrote:|Den .+skrev:|-----Original|From: |Från: |Sent from my|Skickat från|Get Outlook)/i.test(s)) break;
    out.push(s);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

/* Newest block at the top of the Bitrix Comment field, and whether Lead Desk wrote it */
export function topComment(comments){
  const t = String(comments || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\r/g, '').trim();
  return t.split(/\n\s*\n/)[0].trim();
}
export const ownComment = (block, history, known = '') => { const body = block.replace(/^\d{2}-\d{2}-\d{4} \d{2},\d{2}\n/, '').trim(); const flat = x => String(x || '').replace(/\s+/g, ' ').trim();
  return !body || /Lead Desk/.test(body) || flat(known).includes(flat(body)) || (history || []).some(h => { const t = flat(h.txt).replace(/^Bitrix comment: /, ''); return t === flat(body) || t.startsWith(flat(body).slice(0, 200)); }); };
/* Text of a Bitrix timeline comment without BB-code / HTML */
export const plainComment = c => String(c || '').replace(/\[\/?[a-z]+[^\]]*\]/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\r/g, '').trim();

async function bx(hook, method, params){
  const r = await fetch(hook + method + '.json', {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: form(params || {})});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error_description || j.error || ('Bitrix ' + r.status));
  return j;
}

async function main(){
  const {FIREBASE_SERVICE_ACCOUNT, ZOHO_EMAIL, ZOHO_APP_PASSWORD} = process.env;
  if (!FIREBASE_SERVICE_ACCOUNT) { console.log('::notice::FIREBASE_SERVICE_ACCOUNT not set.'); return; }
  const admin = (await import('firebase-admin')).default;
  admin.initializeApp({credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))});
  const fs = admin.firestore(), now = Date.now(), notes = [];
  let uid = (process.env.LEADDESK_UID || '').trim();
  if (!uid) { const users = await fs.collection('users').listDocuments(); if (users.length !== 1) throw new Error('Found ' + users.length + ' Lead Desk users – set the LEADDESK_UID secret.'); uid = users[0].id; }
  const root = fs.collection('users').doc(uid), syncRef = root.collection('config').doc('sync'), leadsRef = root.collection('leads');
  const sync = (await syncRef.get()).data() || {}, cfg = (await root.collection('config').doc('main').get()).data() || {};
  const leads = (await leadsRef.get()).docs.map(d => ({...d.data(), id: d.id}));
  const devices = (await root.collection('devices').get()).docs;
  const push = async (title, body, url = './') => {
    for (const d of devices) {
      try { await admin.messaging().send({token: d.data().token, data: {title, body, url}, webpush: {headers: {Urgency: 'high', TTL: '86400'}}}); }
      catch (e) { if (/registration-token-not-registered|invalid-argument|invalid-registration/.test(e.code || '')) await d.ref.delete().catch(() => {}); }
    }
  };
  const hist = (txt, k = 'note') => admin.firestore.FieldValue.arrayUnion({t: Date.now(), k, txt});
  const hour = dubai(now).getUTCHours(), day = dubaiDay(now), set = {};
  const hook = (process.env.BITRIX_WEBHOOK || '').trim().replace(/\/?$/, '/'), hasHook = /\/rest\/\d+\//.test(hook), map = cfg.bxMap || {};
  const bxComment = async (id, text) => {
    const cur = (await bx(hook, 'crm.lead.get', {id})).result || {}, old = cur.COMMENTS ? String(cur.COMMENTS) : '';
    await bx(hook, 'crm.lead.update', {id, fields: {COMMENTS: text + (old.trim() ? '\n\n' + old : '')}});
    await bx(hook, 'crm.timeline.comment.add', {fields: {ENTITY_ID: id, ENTITY_TYPE: 'lead', COMMENT: text}}).catch(() => {});
  };

  /* 1. Morning summary */
  if (hour >= 9 && hour < 12 && sync.morningDay !== day) {
    await push('Good morning – your Lead Desk day', summary(leads, now)); set.morningDay = day; notes.push('morning summary sent');
  }

  /* 2. Hot leads going cold (9:00–21:00 Dubai) */
  if (hour >= 9 && hour < 21) {
    let n = 0;
    for (const l of leads.filter(l => goingCold(l, now) && (l.hotAlertAt || 0) < now - D)) {
      if (n++ >= 3) break;
      const days = l.lastAt ? Math.floor((now - l.lastAt) / D) : null;
      await push(`🔥 ${l.name || 'Hot lead'} is going cold`, days ? `No contact for ${days} days – call or message now.` : 'Never contacted – call now.', './?lead=' + l.id);
      await leadsRef.doc(l.id).update({hotAlertAt: now});
    }
    if (n) notes.push(n + ' hot alerts');
  }

  /* 3. Meeting reminders */
  for (const l of leads.filter(l => l.stage === 'meeting' && l.meetingAt > now)) {
    const left = l.meetingAt - now, who = l.name || 'your client';
    if (left <= 75 * 60e3 && l.meet1hAt !== l.meetingAt) {
      await push(`Meeting in 1 hour with ${who}`, `${hhmm(l.meetingAt)} Dubai time${l.meetLink ? ' – link is in the lead' : ''}.`, './?lead=' + l.id);
      await leadsRef.doc(l.id).update({meet1hAt: l.meetingAt, meetRemindAt: l.meetingAt});
    } else if (left <= 26 * H && left > 3 * H && l.meetRemindAt !== l.meetingAt && hour >= 9 && hour < 21) {
      await push(`Meeting ${dubaiDay(l.meetingAt) === day ? 'today' : 'tomorrow'} ${hhmm(l.meetingAt)} with ${who}`, 'Tap to send the reminder message to the client.', './?lead=' + l.id);
      await leadsRef.doc(l.id).update({meetRemindAt: l.meetingAt});
    }
  }

  /* 4. Client replied by email */
  if (ZOHO_EMAIL && ZOHO_APP_PASSWORD) {
    try {
      const {ImapFlow} = await import('imapflow'), {simpleParser} = await import('mailparser');
      const imap = new ImapFlow({host: (process.env.ZOHO_IMAP_HOST || 'imappro.zoho.com').trim(), port: 993, secure: true, auth: {user: ZOHO_EMAIL.trim(), pass: ZOHO_APP_PASSWORD.trim()}, logger: false});
      await imap.connect(); const lock = await imap.getMailboxLock('INBOX');
      try {
        const next = imap.mailbox.uidNext, last = sync.imapUid;
        if (!last || next < last) set.imapUid = next;                       /* first run: start from now, no alerts for old mail */
        else if (next > last) {
          const byMail = new Map(leads.filter(l => l.email).map(l => [l.email.toLowerCase().trim(), l]));
          const found = [];
          for await (const m of imap.fetch(`${last}:*`, {envelope: true, uid: true}, {uid: true})) {
            if (m.uid < last) continue;
            const from = ((m.envelope.from || [])[0] || {}).address || '', l = byMail.get(from.toLowerCase());
            if (l) found.push({uid: m.uid, l, subject: m.envelope.subject || '', date: m.envelope.date ? +new Date(m.envelope.date) : now});
          }
          for (const f of found) {
            const src = await imap.download(String(f.uid), undefined, {uid: true}); const parsed = await simpleParser(src.content);
            const words = replySnippet(parsed.text) || f.subject, stop = /^\s*(stop|stopp|unsubscribe)\b/i.test(words), l = f.l;
            const toPipeline = !stop && ['new', 'noanswer', 'pool', 'later', 'workshop', 'lost'].includes(l.stage);
            const patch = {lastAt: f.date, history: hist('Client replied by email: ' + words, 'email'), ...(stop ? {unsub: true} : {}), ...(toPipeline ? {stage: 'talking', stageAt: now, nextAt: now, fresh: false, ...((cfg.bxReq || []).some(q => !(l.bxReq || {})[q.id]) ? {bxReqPending: 'talking'} : {})} : {})};
            await leadsRef.doc(l.id).update(patch);
            await push(stop ? `${l.name} asked to stop emails` : `✉️ ${l.name || from} replied`, stop ? 'No more update emails will be sent.' : words.slice(0, 140), './?lead=' + l.id);
            const bid = l.bxId || l.leadNo;
            if (hasHook && bid) {
              await bxComment(bid, stamp(now) + '\nClient replied by email: ' + words).catch(e => console.log('bitrix comment: ' + e.message));
              if (toPipeline && map.talking) await bx(hook, 'crm.lead.update', {id: bid, fields: {STATUS_ID: map.talking, ...(l.bxReq || {})}}).catch(() => {});
            }
          }
          set.imapUid = next; if (found.length) notes.push(found.length + ' replies');
        }
      } finally { lock.release(); await imap.logout().catch(() => {}); }
      set.imapError = '';
    } catch (e) { set.imapError = String(e.message || e); notes.push('inbox problem: ' + set.imapError); }
  }

  /* 5. Changes made in Bitrix come back */
  if (hasHook && Object.keys(map).length) {
    try {
      const since = sync.bxBackAt;
      if (!since) set.bxBackAt = now;
      else {
        const me = (hook.match(/\/rest\/(\d+)\//) || [])[1], rows = [];
        for (let start = 0; ; ) {
          const j = await bx(hook, 'crm.lead.list', {filter: {ASSIGNED_BY_ID: me, '>DATE_MODIFY': new Date(since - 60e3).toISOString()}, select: ['ID', 'STATUS_ID', 'COMMENTS', 'DATE_MODIFY', ...(cfg.bxDateField ? [cfg.bxDateField] : [])], order: {ID: 'ASC'}, start});
          rows.push(...(j.result || [])); if (!j.next) break; start = j.next;
        }
        const byBx = new Map(leads.filter(l => l.bxId || l.leadNo).map(l => [String(l.bxId || l.leadNo), l]));
        let changed = 0;
        for (const b of rows) {
          const l = byBx.get(String(b.ID)); if (!l || b.STATUS_ID === cfg.bxInStage) continue;
          const patch = {}, notesHere = [];
          const fits = Object.keys(map).filter(k => k !== 'junk' && map[k] === b.STATUS_ID);
          const bxDate = cfg.bxDateField && b[cfg.bxDateField] ? Date.parse(b[cfg.bxDateField]) : NaN, dated = bxDate > now;
          const fresh = (l.stageAt && l.stageAt > now - 2 * H) || l.bxReqPending;                /* you changed it in Lead Desk just now: Lead Desk wins */
          if (fits.length && !fits.includes(l.stage) && !fresh) { patch.stage = fits[0]; notesHere.push('Stage changed in Bitrix → ' + (NAMES[fits[0]] || fits[0]));
            if (['later', 'pool'].includes(fits[0])) {                 /* use the next contact date from Bitrix, or Lead Desk asks for one */
              Object.assign(patch, {hot: false, needDate: !dated, nextAt: dated ? bxDate : null});
              if (dated) notesHere.push('Contact again ' + dubaiDay(bxDate) + ' (date from Bitrix)'); } }
          else if (map.junk && b.STATUS_ID === map.junk && l.stage !== 'lost') { patch.stage = 'lost'; patch.hot = false; patch.nextAt = null; notesHere.push('Set to Junk in Bitrix'); }
          else if (['later', 'pool'].includes(l.stage) && dated && Math.abs(bxDate - (l.nextAt || 0)) > D) {   /* date changed in Bitrix */
            Object.assign(patch, {nextAt: bxDate, needDate: false}); notesHere.push('Contact again date changed in Bitrix → ' + dubaiDay(bxDate)); }
          const top = topComment(b.COMMENTS);
          if (top && top !== l.bxTop) { patch.bxTop = top; if (!ownComment(top, l.history, (l.crm || '') + ' ' + (l.note || ''))) notesHere.push('Bitrix comment: ' + top.slice(0, 500)); }
          if (!Object.keys(patch).length) continue;
          if (notesHere.length) patch.history = admin.firestore.FieldValue.arrayUnion(...notesHere.map(txt => ({t: Date.now(), k: 'note', txt})));
          await leadsRef.doc(l.id).update(patch); if (notesHere.length) changed++;
        }
        set.bxBackAt = now; if (changed) notes.push(changed + ' leads updated from Bitrix');
      }
    } catch (e) { notes.push('Bitrix read problem: ' + e.message); }

    /* Comments you add on the lead's timeline in Bitrix → Lead Desk (50 leads per Bitrix call; the first look only remembers what is there) */
    try {
      const linked = leads.filter(l => (l.bxId || l.leadNo) && !['junk'].includes(l.stage)); let added = 0;
      for (let i = 0; i < linked.length; i += 50) {
        const part = linked.slice(i, i + 50), cmd = {};
        for (const l of part) cmd['c' + l.id.replace(/\W/g, '_')] = 'crm.timeline.comment.list?' + new URLSearchParams({'filter[ENTITY_ID]': String(l.bxId || l.leadNo), 'filter[ENTITY_TYPE]': 'lead'}).toString();
        const res = ((await bx(hook, 'batch', {halt: 0, cmd})).result || {}).result || {};
        for (const l of part) {
          const list = res['c' + l.id.replace(/\W/g, '_')]; if (!Array.isArray(list) || !list.length) continue;
          const max = Math.max(...list.map(c => +c.ID || 0)); if (l.bxCmtMax === max) continue;
          const fresh = l.bxCmtMax === undefined ? [] : list.filter(c => +c.ID > l.bxCmtMax).sort((a, b) => a.ID - b.ID);
          const texts = fresh.map(c => plainComment(c.COMMENT)).filter(t => t && !ownComment(t, l.history, (l.crm || '') + ' ' + (l.note || '')));
          const patch = {bxCmtMax: max};
          if (texts.length) { patch.history = admin.firestore.FieldValue.arrayUnion(...texts.map((txt, k) => ({t: Date.now() + k, k: 'note', txt: 'Bitrix comment: ' + txt.slice(0, 1000)}))); added += texts.length; }
          await leadsRef.doc(l.id).update(patch);
        }
        await new Promise(r => setTimeout(r, 600));
      }
      if (added) notes.push(added + ' Bitrix comments copied');
    } catch (e) { notes.push('Bitrix comments problem: ' + e.message); }
  }

  set.alertsRun = now;
  await syncRef.set(set, {merge: true});
  console.log('::notice::Alerts: ' + (notes.join(', ') || 'nothing to do'));
}
if (process.argv[1] && process.argv[1].endsWith('alerts.mjs')) main().catch(e => { console.log('::error::' + (e.message || e)); process.exit(1); });
