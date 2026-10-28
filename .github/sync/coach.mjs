/* The coach: picks who to contact today and why, a short tip, an evening wrap-up and a weekly review.
   Uses Google Gemini when a Gemini key is saved in Lead Desk (free), otherwise simple rules – works without any AI.
   Calm by design: quiet hours, days off and a daily alert limit decide what reaches the phone. */
const H = 3600e3, D = 24 * H;
const dubai = t => new Date(t + 4 * H);
const first = n => String(n || '').trim().split(/\s+/)[0] || 'lead';
const OPEN = l => !['closed', 'lost', 'junk', 'later', 'pool', 'workshop'].includes(l.stage);
const HOT = l => !!l.hot || ['hot', 'meeting', 'nego'].includes(l.stage);
const CALLS = new Set(['noanswer', 'talk', 'declined', 'badnum', 'meeting']);

export const coachCfg = cfg => ({style: 'gentle', quietFrom: 20, quietTo: 9, maxPerDay: 3, daysOff: [], ...(cfg.coach || {})});
export const isQuiet = (c, t) => { const h = dubai(t).getUTCHours(); return c.quietFrom > c.quietTo ? (h >= c.quietFrom || h < c.quietTo) : (h >= c.quietFrom && h < c.quietTo); };
export const isDayOff = (c, t) => (c.daysOff || []).includes(dubai(t).getUTCDay());

/* Who matters most today, with a plain reason */
export function candidates(leads, now){
  const end = Date.parse(dubai(now).toISOString().slice(0, 10) + 'T23:59:59+04:00'), out = [], seen = new Set();
  const add = (l, why, w) => { if (!seen.has(l.id)) { seen.add(l.id); out.push({l, why, w}); } };
  const days = l => l.lastAt ? Math.floor((now - l.lastAt) / D) : null;
  leads.filter(l => l.stage === 'meeting' && l.meetingAt > now - 2 * H && l.meetingAt <= end).forEach(l => add(l, `meeting today ${dubai(l.meetingAt).toISOString().slice(11, 16)}`, 100));
  leads.filter(l => l.fresh).forEach(l => add(l, 'new lead – first call', 90));
  leads.filter(l => OPEN(l) && HOT(l) && (!l.lastAt || l.lastAt < now - 2 * D)).forEach(l => add(l, days(l) != null ? `hot, quiet for ${days(l)} days` : 'hot, never contacted', 80 + Math.min(days(l) || 0, 10)));
  leads.filter(l => l.nextAt && l.nextAt <= end && OPEN(l)).forEach(l => add(l, l.nextAt < now - D ? 'follow-up overdue' : 'follow-up due today', 50 + (HOT(l) ? 10 : 0)));
  leads.filter(l => ['later', 'pool'].includes(l.stage) && l.nextAt && l.nextAt <= end).forEach(l => add(l, 'agreed to contact again around now', 45));
  leads.filter(l => ['talking', 'nego'].includes(l.stage) && (l.lastAt || 0) < now - 14 * D && !(l.nextAt > now)).forEach(l => add(l, `forgotten – ${days(l) ?? '?'} days without contact`, 40));
  return out.sort((a, b) => b.w - a.w);
}

/* What happened in a period, from the lead histories */
export function activity(leads, from, to){
  const s = {calls: 0, talks: 0, noAnswer: 0, meetings: 0, messages: 0, newLeads: 0, byCountry: {}};
  for (const l of leads) for (const h of l.history || []) {
    if (h.t < from || h.t >= to) continue;
    if (CALLS.has(h.k)) s.calls++;
    if (h.k === 'talk') { s.talks++; const c = l.country || 'Other'; s.byCountry[c] = (s.byCountry[c] || 0) + 1; }
    if (h.k === 'noanswer') s.noAnswer++;
    if (h.k === 'meeting') s.meetings++;
    if (['wa', 'sms', 'email'].includes(h.k)) s.messages++;
    if (h.k === 'created') s.newLeads++;
  }
  return s;
}

const TIPS = ['Start with the hardest call while your energy is high.', 'A 20-second voice note on WhatsApp often gets a reply when calls do not.',
  'Ask one question at the end of every message – it makes replying easy.', 'Block 30 minutes for follow-ups before lunch, then stop.',
  'Mention one concrete project and price – specific beats general.', 'If someone said "later", confirm a date – then the app reminds you.',
  'Two short calls a day beat one long session once a week.'];

export function rulePlan(leads, now, name){
  const top = candidates(leads, now).slice(0, 3);
  return {greeting: `Good morning${name ? ' ' + first(name) : ''} – here is a calm plan for today.`, top: top.map(c => ({id: c.l.id, name: c.l.name || 'Lead', why: c.why})),
    tip: TIPS[dubai(now).getUTCDate() % TIPS.length], ai: false};
}

async function gemini(key, prompt){
  for (const model of ['gemini-flash-latest', 'gemini-2.5-flash']) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({contents: [{parts: [{text: prompt}]}], generationConfig: {responseMimeType: 'application/json', temperature: 0.6}})});
      const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || r.status);
      return JSON.parse(j.candidates[0].content.parts.map(p => p.text || '').join(''));
    } catch (e) { if (model === 'gemini-2.5-flash') throw e; }
  }
}
const COACH = name => `You are a calm, supportive sales coach for ${name || 'a real estate agent'}, who sells Dubai off-plan property to international buyers by phone and WhatsApp. They forget things easily and do not like to feel pushed, so be warm, short and practical – never pushy, no guilt, at most one exclamation mark.`;

export async function aiPlan(key, leads, now, name){
  const base = rulePlan(leads, now, name), list = candidates(leads, now).slice(0, 15);
  if (!key || !list.length) return base;
  const rows = list.map(c => ({id: c.l.id, name: first(c.l.name), stage: c.l.stage, country: c.l.country || '', hot: HOT(c.l), noAnswer: c.l.noAnswer || 0, reason: c.why,
    last: String(((c.l.history || []).filter(h => h.k !== 'created').slice(-1)[0] || {}).txt || '').slice(0, 120)}));
  const y = activity(leads, now - D, now);
  const prompt = `${COACH(name)}\n\nYesterday: ${JSON.stringify(y)}\nLeads worth contacting today (JSON): ${JSON.stringify(rows)}\n\nPick the 3 most valuable to contact today and give each a reason of max 12 words that helps them start the conversation. Then one practical tip for today (max 25 words) based on the data. Greeting max 15 words.\nReply only JSON: {"greeting":"","top":[{"id":"","why":""}],"tip":""}`;
  try {
    const j = await gemini(key, prompt), byId = new Map(list.map(c => [c.l.id, c.l]));
    const top = (j.top || []).filter(t => byId.has(t.id)).slice(0, 3).map(t => ({id: t.id, name: byId.get(t.id).name || 'Lead', why: String(t.why || '').slice(0, 120)}));
    return {greeting: String(j.greeting || base.greeting).slice(0, 120), top: top.length ? top : base.top, tip: String(j.tip || base.tip).slice(0, 200), ai: true};
  } catch (e) { return {...base, aiError: String(e.message || e).slice(0, 120)}; }
}

export async function weekly(key, leads, now, name){
  const w = activity(leads, now - 7 * D, now), prev = activity(leads, now - 14 * D, now - 7 * D);
  const best = Object.entries(w.byCountry).sort((a, b) => b[1] - a[1])[0];
  const facts = `This week: ${w.calls} calls, ${w.talks} conversations, ${w.meetings} meetings, ${w.messages} messages (last week: ${prev.calls} calls, ${prev.talks} conversations, ${prev.meetings} meetings).` + (best ? ` Most conversations with ${best[0]}.` : '');
  let ideas = [w.calls < prev.calls ? 'Fewer calls than last week – two short calling blocks a day can bring it back.' : 'Good rhythm – keep the same calling blocks next week.',
    w.calls && w.talks / w.calls < 0.2 ? 'Many calls without answer – try WhatsApp first, then call at their time window.' : 'Your answer rate is fine – focus on booking the next step in every talk.'];
  if (key) {
    try {
      const j = await gemini(key, `${COACH(name)}\n\n${facts}\nCountries with conversations: ${JSON.stringify(w.byCountry)}.\nGive 3 short, concrete ideas (max 25 words each) to work smarter next week. Reply only JSON: {"ideas":["","",""]}`);
      if (Array.isArray(j.ideas) && j.ideas.length) ideas = j.ideas.slice(0, 3).map(x => String(x).slice(0, 200));
    } catch (e) {}
  }
  return {facts, ideas};
}

export function eveningText(leads, now){
  const d0 = Date.parse(dubai(now).toISOString().slice(0, 10) + 'T00:00:00+04:00'), a = activity(leads, d0, now);
  const tomorrow = candidates(leads, now + D).slice(0, 2).map(c => first(c.l.name));
  if (!a.calls && !a.messages) return {title: 'Lead Desk – tomorrow', body: tomorrow.length ? `A fresh start tomorrow with ${tomorrow.join(' and ')}. Have a good evening.` : 'Nothing urgent waiting. Have a good evening.', active: false};
  return {title: 'Nice work today', body: `${a.calls} calls, ${a.talks} conversations${a.meetings ? `, ${a.meetings} meeting${a.meetings > 1 ? 's' : ''} booked` : ''}.` + (tomorrow.length ? ` Tomorrow starts with ${tomorrow.join(' and ')}.` : '') + ' Have a good evening.', active: true};
}
