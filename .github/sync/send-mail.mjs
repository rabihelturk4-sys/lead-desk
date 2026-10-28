/* Sends the emails Lead Desk puts in users/{uid}/outbox (e.g. the email after "No answer") from your Zoho mailbox,
   with your business card (config/card) attached. Runs with the Bitrix check every few minutes. */
async function main(){
  const {FIREBASE_SERVICE_ACCOUNT, ZOHO_EMAIL, ZOHO_APP_PASSWORD} = process.env;
  if (!FIREBASE_SERVICE_ACCOUNT || !ZOHO_EMAIL || !ZOHO_APP_PASSWORD) { console.log('::notice::Secrets ZOHO_EMAIL and ZOHO_APP_PASSWORD are not set yet – no emails sent.'); return; }
  const admin = (await import('firebase-admin')).default, nodemailer = (await import('nodemailer')).default;
  admin.initializeApp({credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))});
  const fs = admin.firestore();
  let uid = (process.env.LEADDESK_UID || '').trim();
  if (!uid) { const users = await fs.collection('users').listDocuments(); if (users.length !== 1) throw new Error('Found ' + users.length + ' Lead Desk users – set the LEADDESK_UID secret.'); uid = users[0].id; }
  const root = fs.collection('users').doc(uid), syncRef = root.collection('config').doc('sync');
  const pending = (await root.collection('outbox').where('status', '==', 'pending').get()).docs;
  if (!pending.some(d => !(d.data().sendAt > Date.now()))) { console.log('::notice::No emails due.'); return; }
  const cfg = (await root.collection('config').doc('main').get()).data() || {};
  const card = (await root.collection('config').doc('card').get()).data();
  const attachments = [];
  if (card && card.data) { const m = String(card.data).match(/^data:([^;]+);base64,(.*)$/); if (m) attachments.push({filename: card.name || 'business-card.jpg', content: Buffer.from(m[2], 'base64'), contentType: m[1]}); }
  const mail = nodemailer.createTransport({host: (process.env.ZOHO_SMTP_HOST || 'smtppro.zoho.com').trim(), port: 465, secure: true, auth: {user: ZOHO_EMAIL.trim(), pass: ZOHO_APP_PASSWORD.trim()}});
  let sent = 0, lastErr = '';
  for (const d of pending) {
    const m = d.data();
    if (m.sendAt && m.sendAt > Date.now()) continue;                                   /* scheduled for later */
    if (m.leadId && m.kind !== 'invite_email') {
      const l = (await root.collection('leads').doc(m.leadId).get()).data();
      if (l && l.unsub) { await d.ref.update({status: 'cancelled', error: 'client asked to stop'}); continue; }           /* replied "stop": nothing more is sent */
      if (m.kind === 'followup_email' && (!l || (l.lastAt || 0) > m.createdAt + 60e3 || ['closed', 'lost', 'meeting'].includes(l.stage))) { await d.ref.update({status: 'cancelled'}); continue; }   /* not needed if you were in touch since */
    }
    try {
      await mail.sendMail({from: {name: cfg.myName || '', address: ZOHO_EMAIL.trim()}, to: m.to, subject: m.subject, text: m.text,
        attachments: m.kind === 'na_email' || !m.kind ? attachments : [], ...(m.ics ? {icalEvent: {method: 'REQUEST', filename: 'invite.ics', content: m.ics}} : {})});
      await d.ref.update({status: 'sent', sentAt: Date.now()});
      if (m.leadId) await root.collection('leads').doc(m.leadId).update({history: admin.firestore.FieldValue.arrayUnion({t: Date.now(), k: 'note', txt: 'Email sent automatically to ' + m.to + ': ' + m.subject})}).catch(() => {});
      sent++;
    } catch (e) {
      lastErr = String(e.message || e);
      await d.ref.update({status: (m.tries || 0) >= 2 ? 'error' : 'pending', tries: (m.tries || 0) + 1, error: lastErr});
      if (/auth|login|535|credentials/i.test(lastErr)) break;   /* wrong password: stop, try again next run */
    }
  }
  await syncRef.set({mailRun: Date.now(), mailSent: sent, mailError: lastErr}, {merge: true});
  console.log(`::notice::Emails sent: ${sent}.` + (lastErr ? ' Problem: ' + lastErr : ''));
}
main().catch(e => { console.log('::error::' + (e.message || e)); process.exit(1); });
