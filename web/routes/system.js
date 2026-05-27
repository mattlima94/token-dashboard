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
  `;

  wireCardExpansion(document.getElementById('sys-attention'));
}
