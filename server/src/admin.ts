import express, { Router } from 'express';
import { PRESETS, ROUTE_TAGS, type Chaos, type RuleInput } from './chaos.js';
import type { Db } from './db.js';
import type { Storage } from './storage.js';

/** Chaos controls and an inspector view. Never gated by chaos itself. */
export function adminRoutes({ db, storage, chaos }: { db: Db; storage: Storage; chaos: Chaos }): Router {
  const r = Router();
  r.use(express.json());

  r.get('/__chaos', (_req, res) => {
    res.json({ ...chaos.get(), presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.describe])) });
  });
  r.put('/__chaos', (req, res) => {
    chaos.configure(req.body ?? {});
    res.json(chaos.get());
  });
  r.delete('/__chaos', (_req, res) => {
    chaos.clear();
    res.json(chaos.get());
  });
  r.post('/__chaos/preset/:name', (req, res) => {
    if (!chaos.applyPreset(req.params.name)) return res.status(404).json({ code: 'unknown_preset' });
    res.json(chaos.get());
  });
  r.post('/__chaos/rules', (req, res) => {
    const body = req.body as RuleInput;
    if (body?.route !== 'any' && !ROUTE_TAGS.includes(body?.route))
      return res.status(400).json({ code: 'invalid_route', routes: ['any', ...ROUTE_TAGS] });
    if (!body.fault?.kind) return res.status(400).json({ code: 'invalid_fault' });
    res.status(201).json(chaos.addRule(body));
  });
  r.delete('/__chaos/rules/:id', (req, res) => {
    chaos.removeRule(req.params.id);
    res.json(chaos.get());
  });

  /** Everything the server holds, including half-uploaded reports, for the inspector. */
  r.get('/__admin/reports', async (_req, res) => {
    const all = db.stmts.listAll.all();
    res.json(
      await Promise.all(
        all.map(async rep => ({
          id: rep.id,
          status: rep.status,
          description: rep.description,
          receivedAt: rep.received_at,
          committedAt: rep.committed_at,
          images: await Promise.all(
            db.stmts.getImages.all(rep.id).map(async i => ({
              id: i.id,
              size: i.size,
              width: i.width,
              height: i.height,
              received: await storage.offset(rep.id, i.id),
            })),
          ),
        })),
      ),
    );
  });

  r.get('/admin', (_req, res) => {
    res.type('html').send(ADMIN_HTML);
  });

  return r;
}

const ADMIN_HTML = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Field Reports · Server</title>
<style>
  :root{--ink:#16212C;--soft:#5B6873;--line:#D3DBD8;--paper:#F1F4F3;--card:#fff;--ok:#2F9160;--warn:#E08A34;--bad:#C4453D;--act:#2E7BD6}
  body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--paper);color:var(--ink)}
  main{max-width:1000px;margin:0 auto;padding:24px 16px}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:28px 0 10px}
  .muted{color:var(--soft)} .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:10px 0}
  button{font:inherit;border:1px solid var(--line);background:var(--card);border-radius:8px;padding:6px 12px;cursor:pointer}
  button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
  .presets{display:flex;flex-wrap:wrap;gap:8px}
  code{font:13px ui-monospace,monospace;background:#E3E8E6;padding:1px 5px;border-radius:4px}
  table{width:100%;border-collapse:collapse;font-size:14px} td,th{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
  .pill{font-size:12px;padding:2px 8px;border-radius:99px;color:#fff} .committed{background:var(--ok)} .pending{background:var(--warn)}
  .bar{height:6px;background:#E3E8E6;border-radius:3px;overflow:hidden;width:120px;display:inline-block;vertical-align:middle}
  .bar i{display:block;height:100%;background:var(--act)}
  .thumbs img{height:56px;border-radius:6px;margin-right:4px}
  .danger{color:var(--bad);border-color:var(--bad)}
</style></head><body><main>
<h1>Field Reports · Server</h1>
<p class="muted">Inspector and fault injection. Refreshes every 2 s.</p>

<h2>Fault injection</h2>
<div class="card">
  <div class="presets" id="presets"></div>
  <p id="state" class="muted" style="margin:12px 0 0"></p>
</div>

<h2>Reports held by the server</h2>
<div class="card"><table><thead><tr><th>Status</th><th>Description</th><th>Images (received / size)</th></tr></thead>
<tbody id="reports"></tbody></table></div>
<p><button class="danger" id="wipe">Delete every report on the server</button></p>
<script>
const $ = s => document.querySelector(s);
const kb = n => (n/1e6).toFixed(2)+' MB';
let presetNames = {};
async function refresh(){
  const chaos = await (await fetch('/__chaos')).json();
  presetNames = chaos.presets;
  $('#presets').innerHTML = Object.entries(chaos.presets).map(([k,d]) =>
    '<button title="'+d+'" data-p="'+k+'">'+k+'</button>').join('');
  const rules = chaos.rules.map(r => r.route+': '+r.fault.kind+(r.fault.status?' '+r.fault.status:'')+
    (r.rate<1?' @'+Math.round(r.rate*100)+'%':'')+(r.remaining!==null?' ×'+r.remaining:'')).join(' · ');
  $('#state').textContent = 'Latency '+chaos.latencyMs+' ms · bandwidth '+
    (chaos.bandwidthBytesPerSec? (chaos.bandwidthBytesPerSec/1000).toFixed(1)+' KB/s':'unlimited')+
    ' · rules: '+(rules||'none');
  const reports = await (await fetch('/__admin/reports')).json();
  $('#reports').innerHTML = reports.map(r => '<tr><td><span class="pill '+r.status+'">'+r.status+'</span></td><td>'+
    esc(r.description)+'<br><span class="muted"><code>'+r.id.slice(0,8)+'</code> '+(r.committedAt||r.receivedAt)+'</span></td><td>'+
    (r.status==='committed'
      ? '<div class="thumbs">'+r.images.map(i=>'<a href="/v1/images/'+i.id+'" target="_blank" title="'+kb(i.size)+' · '+i.width+'×'+i.height+'"><img src="/v1/images/'+i.id+'?w=160"></a>').join('')+'</div>'+
        r.images.map(i=>kb(i.size)+' '+i.width+'×'+i.height).join('<br>')
      : r.images.map(i=>'<span class="bar"><i style="width:'+(100*i.received/i.size)+'%"></i></span> '+kb(i.received)+' / '+kb(i.size)).join('<br>'))+
    '</td></tr>').join('') || '<tr><td colspan="3" class="muted">Nothing yet.</td></tr>';
}
function esc(s){return s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
document.addEventListener('click', async e => {
  const p = e.target.dataset && e.target.dataset.p;
  if (p) { await fetch('/__chaos/preset/'+p,{method:'POST'}); refresh(); }
});
$('#wipe').onclick = async () => { if (confirm('Delete every report on the server?')) { await fetch('/v1/reports',{method:'DELETE'}); refresh(); } };
refresh(); setInterval(refresh, 2000);
</script></main></body></html>`;
