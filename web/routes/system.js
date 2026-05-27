// system.js — data-driven dashboard rendering agents_status.json.
// Falls back to a minimal markdown renderer when the API returns fallback: "markdown".
import { api, fmt } from '/web/app.js';

function ageLabel(mtime) {
  const min = Math.round(Date.now() / 1000 - mtime) / 60;
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 1440) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

function attentionCards(attention) {
  const esc = attention.escalations || { count: 0, items: [] };
  const drift = attention.schema_drift || { count: 0, items: [], fix_hint: '' };
  const stale = attention.stale_agents || { count: 0, items: [] };

  const cards = [
    {
      id: 'escalations',
      label: 'Escalations',
      value: esc.count,
      sub: 'in message bus',
      sev: esc.count > 0 ? 'red' : 'green',
      detail: esc.items.length ? `
        <div class="sys-detail">
          ${esc.items.map(it => `
            <div class="di">
              <span class="dot red"></span>
              <span>${fmt.htmlSafe(it.subject || it.filename)}</span>
              <span class="meta">${fmt.htmlSafe(it.from_agent || '')}</span>
            </div>`).join('')}
        </div>` : '',
    },
    {
      id: 'drift',
      label: 'Schema drift',
      value: drift.count,
      sub: 'agents with malformed state.json',
      sev: drift.count > 0 ? 'amber' : 'green',
      detail: drift.items.length ? `
        <div class="sys-detail">
          ${drift.items.map(it => `
            <div class="di">
              <span class="dot amber"></span>
              <span><code>${fmt.htmlSafe(it.agent)}</code> — missing
                ${(it.missing || []).map(m => `<code>${fmt.htmlSafe(m)}</code>`).join(', ') || '<em>none</em>'}${
                (it.malformed || []).length ? `; malformed ${(it.malformed || []).map(m => `<code>${fmt.htmlSafe(m)}</code>`).join(', ')}` : ''
              }</span>
            </div>`).join('')}
          ${drift.fix_hint ? `<div class="fix-hint">Fix: ${fmt.htmlSafe(drift.fix_hint)}</div>` : ''}
        </div>` : '',
    },
    {
      id: 'stale',
      label: 'Stale agents',
      value: stale.count,
      sub: `no run in >${stale.threshold_days || 1} day(s)`,
      sev: stale.count > 0 ? 'amber' : 'green',
      detail: stale.items.length ? `
        <div class="sys-detail">
          ${stale.items.map(it => `
            <div class="di">
              <span class="dot amber"></span>
              <span><code>${fmt.htmlSafe(it.agent)}</code></span>
              <span class="meta">${fmt.htmlSafe(it.last_run_age)}</span>
            </div>`).join('')}
        </div>` : '',
    },
  ];

  return cards.map(c => `
    <div class="sys-card" data-card="${c.id}">
      ${c.detail ? '<div class="chev">▸</div>' : ''}
      <div class="l">${c.label}</div>
      <div class="v ${c.sev}">${fmt.int(c.value)}</div>
      <div class="sub">${c.sub}</div>
      ${c.detail}
    </div>
  `).join('');
}

function activityCards(activity) {
  const d = activity.deliverables || { count: 0, by_agent: [] };
  const bus = activity.message_bus || { inbox: 0, outbox: 0, watcher_age_min: null };
  const top = activity.top_producer;

  const cards = [
    {
      id: 'deliverables',
      label: `Deliverables shipped`,
      valueHtml: fmt.int(d.count),
      sub: `across ${(d.by_agent || []).length} agents`,
      sev: '',
      detail: d.by_agent && d.by_agent.length ? `
        <div class="sys-detail">
          ${d.by_agent.slice(0, 10).map(r => `
            <div class="di">
              <span class="dot green"></span>
              <span><code>${fmt.htmlSafe(r.agent)}</code>
                ${(r.recent_titles || []).slice(0, 2).map(t => `<span class="meta" style="margin-left:8px">${fmt.htmlSafe(fmt.short(t, 50))}</span>`).join('')}
              </span>
              <span class="meta">${r.count} doc${r.count === 1 ? '' : 's'}</span>
            </div>`).join('')}
        </div>` : '',
    },
    {
      id: 'bus',
      label: 'Message bus throughput',
      valueHtml: `${fmt.int(bus.inbox)}<span style="font-size:13px;color:var(--muted)"> in / </span>${fmt.int(bus.outbox)}<span style="font-size:13px;color:var(--muted)"> out</span>`,
      sub: bus.watcher_age_min == null ? 'watcher status unknown'
           : bus.watcher_age_min < 5 ? `watcher ${bus.watcher_age_min}m ago`
           : `watcher ${bus.watcher_age_min}m ago — check`,
      sev: bus.watcher_age_min != null && bus.watcher_age_min > 60 ? 'amber' : '',
      detail: '',
    },
    {
      id: 'top',
      label: 'Top producer',
      valueHtml: top ? `<span style="font-size:14px">${fmt.htmlSafe(top.agent)}</span>` : '<span style="font-size:14px;color:var(--muted)">—</span>',
      sub: top ? `${top.count} doc${top.count === 1 ? '' : 's'}${top.last_age && top.last_age !== '-' ? ` · last ${top.last_age} ago` : ''}` : 'no deliverables this window',
      sev: '',
      detail: '',
    },
  ];

  return cards.map(c => `
    <div class="sys-card" data-card="${c.id}">
      ${c.detail ? '<div class="chev">▸</div>' : ''}
      <div class="l">${c.label}</div>
      <div class="v ${c.sev}">${c.valueHtml}</div>
      <div class="sub">${c.sub}</div>
      ${c.detail}
    </div>
  `).join('');
}

function agentTile(a) {
  const tier = a.tier || 'worker';
  const fresh = a.freshness || 'never';
  const title = `${a.display_name || a.name}\nrole: ${a.role || '?'}\nlast run: ${a.last_run_age || 'never'}${a.last_run_iso ? ` (${a.last_run_iso})` : ''}${a.open_items != null ? `\nopen items: ${a.open_items}` : ''}`;
  const meta = [a.last_run_age, a.open_items != null ? `${a.open_items} open` : null, a.phase ? `p${a.phase}` : null]
    .filter(Boolean).join(' · ');
  return `
    <a href="#/sessions?agent=${encodeURIComponent(a.name)}"
       class="sys-ag tier-${tier} ${fresh}" title="${fmt.htmlSafe(title)}">
      <div class="dot"></div>
      <div class="nm">${fmt.htmlSafe(a.display_name || a.name)}</div>
      <div class="ts">${fmt.htmlSafe(meta || '—')}</div>
    </a>`;
}

function healthGrid(agents) {
  const byTierDiv = {
    chair: [],
    csuite: [],
    personal: [],
    business: [],
    infra: [],
  };
  for (const a of agents) {
    if (a.tier === 'chair') byTierDiv.chair.push(a);
    else if (a.tier === 'csuite') byTierDiv.csuite.push(a);
    else if (a.tier === 'infra') byTierDiv.infra.push(a);
    else if (a.division === 'personal') byTierDiv.personal.push(a);
    else if (a.division === 'business' || a.tier === 'venture') byTierDiv.business.push(a);
    else byTierDiv.csuite.push(a);
  }

  const row = list => list.map(agentTile).join('');

  return `
    <div class="sys-org">
      <div class="sys-org-row">${row(byTierDiv.chair)}</div>
      ${byTierDiv.chair.length && byTierDiv.csuite.length ? '<div class="sys-org-conn"></div>' : ''}
      <div class="sys-org-row">${row(byTierDiv.csuite)}</div>

      ${(byTierDiv.personal.length || byTierDiv.business.length) ? '<div class="sys-org-conn"></div>' : ''}
      <div class="sys-org-divs">
        <div class="sys-org-div sys-org-div-personal">
          <div class="sys-org-div-h">Personal Division</div>
          <div class="sys-org-row">${row(byTierDiv.personal)}</div>
        </div>
        <div class="sys-org-div sys-org-div-business">
          <div class="sys-org-div-h">Business Division</div>
          <div class="sys-org-row">${row(byTierDiv.business)}</div>
        </div>
      </div>

      ${byTierDiv.infra.length ? `
        <div class="sys-org-conn"></div>
        <div class="sys-org-row">${row(byTierDiv.infra)}</div>` : ''}

      <div class="sys-org-legend">
        <span><span class="sw" style="background:var(--good)"></span>fresh (&lt;24h)</span>
        <span><span class="sw" style="background:var(--warn)"></span>stale (1–7d)</span>
        <span><span class="sw" style="background:var(--bad)"></span>silent (&gt;7d)</span>
        <span><span class="sw" style="background:var(--muted-2)"></span>never</span>
        <span style="margin-left:auto"><span class="ts-box" style="border-color:#ffd700"></span>chair</span>
        <span><span class="ts-box" style="border-color:#7b68ee"></span>c-suite</span>
        <span><span class="ts-box" style="border-color:#3b82f6"></span>director</span>
        <span><span class="ts-box" style="border-color:#f472b6"></span>venture</span>
        <span><span class="ts-box" style="border-color:#22c55e"></span>worker</span>
      </div>
    </div>`;
}

function wireCardExpansion(root) {
  root.querySelectorAll('.sys-card').forEach(card => {
    if (!card.querySelector('.sys-detail')) return;
    card.addEventListener('click', () => {
      const wasExpanded = card.classList.contains('expanded');
      root.querySelectorAll('.sys-card.expanded').forEach(c => c.classList.remove('expanded'));
      if (!wasExpanded) card.classList.add('expanded');
    });
  });
}

function renderLegacyMarkdown(root, body) {
  const text = body.markdown || '';
  root.innerHTML = `
    <div class="card">
      <h2 style="margin:0 0 12px">System Dashboard <span class="muted" style="font-size:12px;font-weight:400">— markdown fallback</span></h2>
      <p class="muted" style="font-size:12px;margin:-4px 0 12px">
        <code>${fmt.htmlSafe(body.path || '')}</code> · regenerated ${ageLabel(body.mtime)}
      </p>
      <pre style="white-space:pre-wrap;font-family:var(--mono);font-size:12px;background:var(--panel-2);padding:12px;border-radius:6px;border:1px solid var(--border)">${fmt.htmlSafe(text)}</pre>
    </div>`;
}

export default async function (root) {
  const body = await api('/api/system');

  if (!body.configured) {
    root.innerHTML = `
      <div class="card">
        <h2>System Dashboard</h2>
        <p class="muted">${fmt.htmlSafe(body.hint || 'Not configured.')}</p>
      </div>`;
    return;
  }
  if (body.error) {
    root.innerHTML = `
      <div class="card">
        <h2>System Dashboard</h2>
        <p class="muted">Failed to read <code>${fmt.htmlSafe(body.path)}</code>: ${fmt.htmlSafe(body.error)}</p>
      </div>`;
    return;
  }
  if (body.fallback === 'markdown') {
    return renderLegacyMarkdown(root, body);
  }

  const data = body.data;
  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">System Dashboard</h2>
      <span class="muted" style="font-size:12px">regenerated ${ageLabel(body.mtime)}</span>
    </div>

    <div class="sys-section-h">Attention</div>
    <div class="sys-grid-3" id="sys-attention">${attentionCards(data.attention || {})}</div>

    <div class="sys-section-h">Activity · last ${(data.activity || {}).window_days || 7} days</div>
    <div class="sys-grid-3" id="sys-activity">${activityCards(data.activity || {})}</div>

    <div class="sys-section-h">Health · ${(data.agents || []).length} agents, by org tier</div>
    <div class="card" style="cursor:default">${healthGrid(data.agents || [])}</div>
  `;

  wireCardExpansion(document.getElementById('sys-attention'));
  wireCardExpansion(document.getElementById('sys-activity'));
}
