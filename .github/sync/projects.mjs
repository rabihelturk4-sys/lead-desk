/* Reelly projects → Lead Desk. Once a day the project list is refreshed; every run fills in details
   (payment plan, bedrooms, handover) for some projects. Everything is stored compactly in users/{uid}/config/projects,
   so the app can show and send projects without calling Reelly from the browser (the key stays out of the app). */
const BASE = 'https://api-reelly.up.railway.app/api/v2/clients';
const D = 24 * 3600e3;

async function api(key, path, params = {}){
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')).toString();
  const r = await fetch(BASE + path + (q ? '?' + q : ''), {headers: {'X-API-Key': key, Accept: 'application/json'}});
  if (!r.ok) throw new Error('Reelly ' + r.status + (r.status === 401 || r.status === 403 ? ' – check the Reelly API key' : ''));
  return r.json();
}
const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((a, b) => a == null ? a : a[b], o); if (v != null && v !== '') return v; } return null; };
const toTime = v => { if (v == null) return null; if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; const t = Date.parse(v); return isNaN(t) ? null : t; };

/* One compact project as the app uses it */
export function compact(p, old = {}){
  const units = Array.isArray(p.typical_units) ? p.typical_units : [];
  const beds = [...new Set(units.map(u => u.bedrooms).filter(b => b != null))].sort((a, b) => a - b);
  const plans = Array.isArray(p.payment_plans) ? p.payment_plans : [];
  return {
    id: String(p.id),
    name: String(p.name || '').slice(0, 80),
    dev: String(pick(p, 'developer.name', 'developer_name') || old.dev || '').slice(0, 60),
    area: String(pick(p, 'location.name', 'district.name', 'district', 'area', 'location_name') || old.area || pick(p, 'region') || '').slice(0, 60),
    region: String(pick(p, 'region', 'region.name') || old.region || '').slice(0, 40),
    min: Math.round(Number(pick(p, 'min_price')) || 0) || old.min || 0,
    cur: String(pick(p, 'price_currency') || old.cur || 'AED'),
    sale: String(pick(p, 'sale_status') || old.sale || ''),
    done: toTime(pick(p, 'completion_date', 'planned_completion_date', 'completion_datetime', 'handover_date')) || old.done || null,
    img: String(pick(p, 'cover_image.url', 'cover_image_url') || old.img || ''),
    beds: beds.length ? beds : (old.beds || []),
    plan: String((plans[0] && plans[0].name) || old.plan || '').slice(0, 40),
    post: plans.some(pl => /post/i.test(pl.name || '')) || !!old.post,
    det: p.typical_units || p.payment_plans ? Date.now() : (old.det || 0)
  };
}

export async function syncProjects({fs, root, sync, set, notes, now}){
  const priv = (await root.collection('config').doc('private').get()).data() || {};
  const key = (priv.reellyKey || '').trim(); if (!key) return;
  const cfg = (await root.collection('config').doc('main').get()).data() || {};
  const ref = root.collection('config').doc('projects');
  const cur = (await ref.get()).data() || {};
  const byId = new Map((cur.items || []).map(p => [p.id, p]));
  try {
    const day = new Date(now + 4 * 3600e3).toISOString().slice(0, 10);
    if (sync.projDay !== day || !byId.size) {                           /* daily: the full list */
      const seen = new Set(); let offset = 0;
      for (let page = 0; page < 40; page++) {
        const j = await api(key, '/projects', {limit: 100, offset, country: cfg.reellyCountry || 'United Arab Emirates', region: cfg.reellyRegion || undefined, preferred_currency: 'AED'});
        for (const p of j.results || []) { seen.add(String(p.id)); byId.set(String(p.id), compact(p, byId.get(String(p.id)))); }
        if (!j.next || !(j.results || []).length) break; offset += 100;
      }
      for (const id of [...byId.keys()]) if (!seen.has(id)) byId.delete(id);   /* gone from Reelly */
      set.projDay = day;
    }
    if (process.env.REELLY_SHAPE === '1' && byId.size) {                /* field names only (no values), to map them */
      const shape = o => Object.entries(o || {}).map(([k, v]) => k + (v && typeof v === 'object' && !Array.isArray(v) ? '{' + Object.keys(v).join(',') + '}' : Array.isArray(v) ? '[' + (v[0] && typeof v[0] === 'object' ? Object.keys(v[0]).join(',') : '') + ']' : '')).join(' ');
      const id = [...byId.keys()][0], l = await api(key, '/projects', {limit: 1}), d = await api(key, '/projects/' + id, {});
      console.log('::notice::Reelly list fields: ' + shape((l.results || [])[0]).slice(0, 1800));
      console.log('::notice::Reelly detail fields: ' + shape(d).slice(0, 3500));
    }
    /* each run: details (bedrooms, payment plan, handover) for up to 25 projects */
    const todo = [...byId.values()].filter(p => !p.det || now - p.det > 14 * D).slice(0, 25);
    for (const p of todo) {
      try { const d = await api(key, '/projects/' + encodeURIComponent(p.id), {preferred_currency: 'AED'}); byId.set(p.id, {...compact(d, p), det: now}); }
      catch (e) { byId.set(p.id, {...p, det: now}); }
    }
    let items = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    while (JSON.stringify(items).length > 900000) items = items.slice(0, Math.floor(items.length * 0.9));   /* stay within one database document */
    await ref.set({at: now, items});
    set.projRun = now; set.projCount = items.length; set.projError = '';
    const has = k => items.filter(p => Array.isArray(p[k]) ? p[k].length : p[k]).length;
    notes.push(`Reelly: ${items.length} projects, ${todo.length} detailed (with price ${has('min')}, area ${has('area')}, handover ${has('done')}, plan ${has('plan')}, bedrooms ${has('beds')}, image ${has('img')})`);
  } catch (e) { set.projRun = now; set.projError = String(e.message || e); notes.push('Reelly problem: ' + set.projError); }
}
