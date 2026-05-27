import { api, fmt } from '/web/app.js';

export default async function (root) {
  const id = decodeURIComponent(location.hash.split('/')[2] || '');
  if (!id) return renderList(root);
  return renderSession(root, id);
}

function readFilter() {
  const q = location.hash.split('?')[1] || '';
  const m = /(?:^|&)filter=([^&]+)/.exec(q);
  return m ? decodeURIComponent(m[1]) : 'all';
}

function writeFilter(value) {
  const base = location.hash.replace(/^#/, '').split('?')[0] || '/sessions';
  location.hash = '#' + base + '?filter=' + encodeURIComponent(value);
}

function verdictCell(s) {
  if (s.heaviness === 'heavy') {
    const reasons = [];
    if (s.turns > 50) reasons.push(`${s.turns} turns`);
    if ((s.cache_read_tokens || 0) > 5_000_000) reasons.push(`cache ${fmt.compact(s.cache_read_tokens)}`);
    if ((s.input_share || 0) > 0.60) reasons.push(`in-share ${fmt.pct(s.input_share)}`);
    return `<span class="verdict heavy">⚠ ${fmt.htmlSafe(reasons[0] || 'heavy')}</span>`;
  }
  if (s.heaviness === 'healthy') return '<span class="verdict healthy">✓ healthy</span>';
  return '<span class="verdict closed">○ closed</span>';
}

async function renderList(root) {
  const filter = readFilter();
  const all = await api('/api/sessions?limit=100');
  const liveCount = all.filter(s => s.is_live).length;
  const rows = filter === 'live' ? all.filter(s => s.is_live) : all;

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Sessions</h2>
      <div class="spacer"></div>
    </div>

    <div class="filter-chips">
      <button class="chip ${filter === 'live' ? 'active' : ''}" data-filter="live">
        ${liveCount > 0 ? '<span class="pulse-dot" style="margin-right:5px"></span>' : ''}live (${liveCount})
      </button>
      <button class="chip all ${filter === 'all' ? 'active' : ''}" data-filter="all">
        all (${all.length})
      </button>
    </div>

    <div class="card" style="padding:0">
      <table>
        <thead>
          <tr>
            <th style="width:24px"></th>
            <th>started</th>
            <th>project</th>
            <th class="num">turns</th>
            <th class="num">cache r</th>
            <th class="num">in-share</th>
            <th>heavy?</th>
            <th>session</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0
            ? `<tr><td colspan="8" class="muted" style="padding:14px">No sessions match this filter.</td></tr>`
            : rows.map(s => `
              <tr>
                <td>${s.is_live ? '<span class="pulse-dot"></span>' : ''}</td>
                <td class="mono">${fmt.ts(s.started)}</td>
                <td title="${fmt.htmlSafe(s.project_slug)}">${fmt.htmlSafe(s.project_name || s.project_slug)}</td>
                <td class="num">${fmt.int(s.turns)}</td>
                <td class="num">${fmt.compact(s.cache_read_tokens)}</td>
                <td class="num">${fmt.pct(s.input_share)}</td>
                <td>${verdictCell(s)}</td>
                <td><a href="#/sessions/${encodeURIComponent(s.session_id)}" class="mono">${fmt.htmlSafe(s.session_id.slice(0,8))}…</a></td>
              </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  root.querySelectorAll('.filter-chips .chip').forEach(btn => {
    btn.addEventListener('click', () => writeFilter(btn.dataset.filter));
  });
}

async function renderSession(root, id) {
  const turns = await api('/api/sessions/' + encodeURIComponent(id));
  let totalIn = 0, totalOut = 0, totalCacheRd = 0;
  let modelCounts = {};
  for (const t of turns) {
    if (t.type !== 'assistant') continue;
    totalIn += t.input_tokens || 0;
    totalOut += t.output_tokens || 0;
    totalCacheRd += t.cache_read_tokens || 0;
    const m = t.model || 'unknown';
    modelCounts[m] = (modelCounts[m] || 0) + 1;
  }
  const slug = (turns[0] && turns[0].project_slug) || '';
  const cwd = (turns.find(t => t.cwd) || {}).cwd || '';
  const base = cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : '';
  const project = base || slug;
  const started = (turns[0] && turns[0].timestamp) || '';
  const ended = (turns[turns.length-1] && turns[turns.length-1].timestamp) || '';

  root.innerHTML = `
    <div class="card">
      <h2 style="display:flex;align-items:center">
        <span>Session ${fmt.htmlSafe(id.slice(0,8))}…</span>
        <span class="spacer"></span>
        <a href="#/sessions" class="muted">← all sessions</a>
      </h2>
      <div class="flex muted" style="font-family:var(--mono);font-size:12px;flex-wrap:wrap;gap:14px">
        <span>${fmt.htmlSafe(project)}</span>
        <span>${fmt.ts(started)} → ${fmt.ts(ended)}</span>
        <span>${turns.length} records</span>
        <span>${fmt.int(totalIn)} in · ${fmt.int(totalOut)} out · ${fmt.int(totalCacheRd)} cache rd</span>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Turn-by-turn</h3>
      <table>
        <thead><tr><th>time</th><th>type</th><th>model</th><th class="blur-sensitive">prompt / tools</th><th class="num">in</th><th class="num">out</th><th class="num">cache rd</th></tr></thead>
        <tbody>
          ${turns.map(t => {
            const tools = t.tool_calls_json ? JSON.parse(t.tool_calls_json) : [];
            const summary = t.prompt_text ? fmt.short(t.prompt_text, 110)
              : tools.length ? tools.map(x => x.name).join(' · ')
              : '';
            return `<tr>
              <td class="mono">${(t.timestamp || '').slice(11,19)}</td>
              <td>${t.type}${t.is_sidechain ? ' <span class="badge">side</span>' : ''}</td>
              <td>${t.model ? `<span class="badge ${fmt.modelClass(t.model)}">${fmt.htmlSafe(fmt.modelShort(t.model))}</span>` : ''}</td>
              <td class="blur-sensitive">${fmt.htmlSafe(summary)}</td>
              <td class="num">${fmt.int(t.input_tokens)}</td>
              <td class="num">${fmt.int(t.output_tokens)}</td>
              <td class="num">${fmt.int(t.cache_read_tokens)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}
