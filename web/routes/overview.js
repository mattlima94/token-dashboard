import { api, fmt, state } from '/web/app.js';
import { barChart, donutChart, groupedBarChart, stackedBarChart } from '/web/charts.js';

const RANGES = [
  { key: '7d',  label: '7d',  days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];

function readRange() {
  const q = (location.hash.split('?')[1] || '');
  const m = /(?:^|&)range=([^&]+)/.exec(q);
  const k = m && decodeURIComponent(m[1]);
  return RANGES.find(r => r.key === k) || RANGES[1];
}

function writeRange(key) {
  const base = (location.hash.replace(/^#/, '').split('?')[0]) || '/overview';
  location.hash = '#' + base + '?range=' + encodeURIComponent(key);
}

function sinceIso(range) {
  if (!range.days) return null;
  return new Date(Date.now() - range.days * 86400 * 1000).toISOString();
}

function withSince(url, since) {
  if (!since) return url;
  return url + (url.includes('?') ? '&' : '?') + 'since=' + encodeURIComponent(since);
}

function liveRowHtml(live, liveCacheR, liveTurns, maxInShare) {
  const liveCount = live.length;
  const idleClass = liveCount === 0 ? ' idle' : '';
  const pulse = liveCount > 0 ? '<span class="pulse-dot"></span>' : '';
  const heavyShare = maxInShare > 0.60;
  return `
    <div class="live-row">
      <div class="live-kpi${idleClass}">
        <div class="label">${pulse}Sessions live</div>
        <div class="value">${liveCount}</div>
        <div class="sub">${liveCount === 0 ? 'no live sessions' : 'mtime &lt; 5min'}</div>
      </div>
      <div class="live-kpi${idleClass}">
        <div class="label">Live cache R</div>
        <div class="value">${fmt.compact(liveCacheR)}</div>
        <div class="sub">across live sessions</div>
      </div>
      <div class="live-kpi${idleClass}">
        <div class="label">Live turns</div>
        <div class="value">${fmt.int(liveTurns)}</div>
        <div class="sub">combined</div>
      </div>
      <div class="live-kpi${idleClass}">
        <div class="label">Heaviest in-share</div>
        <div class="value" style="${heavyShare ? 'color:var(--warn)' : ''}">${fmt.pct(maxInShare)}</div>
        <div class="sub">${heavyShare ? 'over 60% threshold' : 'within budget'}</div>
      </div>
    </div>`;
}

function heaviestListHtml(heaviest) {
  if (!heaviest.length) {
    return '<div class="card" style="padding:12px"><span class="muted" style="font-size:12px">No live sessions right now.</span></div>';
  }
  return `
    <div class="card" style="padding:14px">
      <h3 style="margin:0 0 8px;font-size:13px">Heaviest live</h3>
      <div class="heaviest-list">
        ${heaviest.map(s => `
          <div class="heaviest-row">
            <span class="sev ${s.heaviness}"></span>
            <span><a href="#/sessions/${encodeURIComponent(s.session_id)}"><code>${fmt.htmlSafe(s.project_name || s.project_slug)}</code></a>
              · ${s.turns || 0} turns · in-share ${fmt.pct(s.input_share)}</span>
            <span class="meta">${fmt.compact(s.cache_read_tokens)} cache · ${fmt.ts(s.started)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function usageRowHtml(usage) {
  const b = Object.fromEntries((usage.buckets || []).map(x => [x.window, x]));
  const card = (label, key) => `
    <div class="card kpi">
      <div class="label">Tokens ${label}</div>
      <div class="value" title="${fmt.int(b[key]?.tokens || 0)}">${fmt.compact(b[key]?.tokens || 0)}</div>
      <div class="sub">${b[key]?.sessions || 0} sessions · ${b[key]?.turns || 0} turns</div>
    </div>`;
  return `<div class="row cols-3">${card('24h', '24h')}${card('7d', '7d')}${card('30d', '30d')}</div>`;
}

export default async function (root) {
  const range = readRange();
  const since = sinceIso(range);

  const [totals, projects, sessions, sessionsAll, tools, daily, byModel, usage] = await Promise.all([
    api(withSince('/api/overview', since)),
    api(withSince('/api/projects', since)),
    api(withSince('/api/sessions?limit=10', since)),
    api('/api/sessions?limit=50'),
    api(withSince('/api/tools', since)),
    api(withSince('/api/daily', since)),
    api(withSince('/api/by-model', since)),
    api('/api/usage-volume'),
  ]);

  const live = sessionsAll.filter(s => s.is_live);
  const liveCacheR = live.reduce((sum, s) => sum + (s.cache_read_tokens || 0), 0);
  const liveTurns = live.reduce((sum, s) => sum + (s.turns || 0), 0);
  const maxInShare = live.reduce((m, s) => Math.max(m, s.input_share || 0), 0);
  const heaviest = live
    .slice()
    .sort((a, b) => (b.input_share || 0) - (a.input_share || 0))
    .slice(0, 3);

  const showCost = localStorage.getItem('td.show_cost') === '1';

  const cacheCreate =
    (totals.cache_create_5m_tokens || 0) +
    (totals.cache_create_1h_tokens || 0);

  const kpi = (label, compactVal, fullVal, cls = '') => `
    <div class="card kpi ${cls}">
      <div class="label">${label}</div>
      <div class="value" title="${fullVal}">${compactVal}</div>
    </div>`;

  const rangeTabs = `
    <div class="range-tabs" role="tablist">
      ${RANGES.map(r => `<button data-range="${r.key}" class="${r.key === range.key ? 'active' : ''}">${r.label}</button>`).join('')}
    </div>`;

  root.innerHTML = `
    <div class="flex" style="margin-bottom:14px">
      <h2 style="margin:0;font-size:16px;letter-spacing:-0.01em">Overview</h2>
      <span class="muted" style="font-size:12px">${range.days ? `last ${range.days} days` : 'all time'}</span>
      <div class="spacer"></div>
      ${rangeTabs}
    </div>

    <div style="margin-bottom:14px">
      ${liveRowHtml(live, liveCacheR, liveTurns, maxInShare)}
    </div>

    <div style="margin-bottom:14px">
      ${heaviestListHtml(heaviest)}
    </div>

    <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin:4px 0 8px;font-weight:600">Usage volume</div>
    <div style="margin-bottom:14px">
      ${usageRowHtml(usage)}
    </div>

    <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;margin:18px 0 8px;font-weight:600">${range.days ? `Last ${range.days} days` : 'All time'}</div>
    <div class="row cols-4 ${showCost ? '' : 'dim'}">
      ${kpi('Sessions', fmt.int(totals.sessions), fmt.int(totals.sessions))}
      ${kpi('Turns', fmt.int(totals.turns), fmt.int(totals.turns))}
      ${kpi('Billable', fmt.compact((totals.input_tokens||0)+(totals.output_tokens||0)+cacheCreate),
                       fmt.int((totals.input_tokens||0)+(totals.output_tokens||0)+cacheCreate) + ' tokens')}
      <div class="card kpi cost">
        <div class="label">Est. cost</div>
        <div class="value" title="${fmt.usd(totals.cost_usd)}">${fmt.usd(totals.cost_usd)}</div>
        ${planSubtitle()}
      </div>
    </div>
    ${showCost ? '' : '<div class="muted" style="font-size:10px;margin-top:4px">Cost framing dimmed — toggle in Settings to re-enable.</div>'}

    <details class="card glossary" style="margin-top:16px">
      <summary><h3 style="display:inline-block;margin:0">What do these numbers mean?</h3><span class="muted" style="font-size:12px">— click to expand</span></summary>
      <dl>
        <dt>Session</dt><dd>One run of Claude Code (from <code>claude</code> to exit). Each session is a single <code>.jsonl</code> file.</dd>
        <dt>Turn</dt><dd>One message you sent to Claude. Each turn triggers a response (possibly with tool calls in between).</dd>
        <dt>Input tokens</dt><dd>The new text you (and tool results) sent to Claude this turn. Billed at the full input rate.</dd>
        <dt>Output tokens</dt><dd>The text Claude wrote back. Billed at the highest rate — usually the biggest cost driver per turn.</dd>
        <dt>Cache read</dt><dd>Tokens Claude re-used from a cache (your CLAUDE.md, previously-read files, the conversation so far). ~10× cheaper than fresh input. High cache-read counts = good cost hygiene.</dd>
        <dt>Cache create</dt><dd>Writing something into the cache for the first time. One-time cost; pays off on the next turn.</dd>
        <dt>Billable tokens</dt><dd>Input + Output + Cache create. Cache reads are billed separately (and much cheaper).</dd>
      </dl>
    </details>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card">
        <h3>Your daily work</h3>
        <p class="muted" style="margin:-4px 0 10px;font-size:12px">Tokens you paid for: what you sent (<b>input</b>), what Claude wrote (<b>output</b>), and what got stored for re-use (<b>cache create</b>).</p>
        <div id="ch-daily-billable" style="height:260px"></div>
      </div>
      <div class="card">
        <h3>Daily cache reads</h3>
        <p class="muted" style="margin:-4px 0 10px;font-size:12px"><b>Cache reads</b> are cheap re-uses of things Claude already saw (like your CLAUDE.md). They cost ~10× less than regular input tokens — high numbers here are a good thing.</p>
        <div id="ch-daily-cache" style="height:260px"></div>
      </div>
    </div>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card"><h3>Tokens by project</h3><div id="ch-projects" style="height:320px"></div></div>
      <div class="card">
        <h3>Token usage by model</h3>
        <p class="muted" style="margin:-4px 0 4px;font-size:12px">Share of billable tokens per Claude model.</p>
        <div id="ch-model" style="height:300px"></div>
      </div>
    </div>

    <div class="row cols-2" style="margin-top:16px">
      <div class="card"><h3>Top tools (by call count)</h3><div id="ch-tools" style="height:320px"></div></div>
      <div class="card">
        <h3 style="display:flex;align-items:center"><span>Recent sessions</span><span class="spacer"></span><a href="#/sessions" style="font-weight:400;font-size:12px">all →</a></h3>
        <table>
          <thead><tr><th>started</th><th>project</th><th class="num">tokens</th></tr></thead>
          <tbody>
            ${sessions.map(s => `
              <tr>
                <td class="mono">${fmt.ts(s.started)}</td>
                <td><a href="#/sessions/${encodeURIComponent(s.session_id)}">${fmt.htmlSafe(s.project_name || s.project_slug)}</a></td>
                <td class="num">${fmt.compact(s.tokens)}</td>
              </tr>`).join('') || '<tr><td colspan="3" class="muted">no sessions in this range</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // range buttons
  root.querySelectorAll('.range-tabs button').forEach(btn => {
    btn.addEventListener('click', () => writeRange(btn.dataset.range));
  });

  // Your daily work — billable tokens (input + output + cache create)
  stackedBarChart(document.getElementById('ch-daily-billable'), {
    categories: daily.map(d => d.day),
    series: [
      { name: 'input',        values: daily.map(d => d.input_tokens),        color: '#4A9EFF' },
      { name: 'output',       values: daily.map(d => d.output_tokens),       color: '#7C5CFF' },
      { name: 'cache create', values: daily.map(d => d.cache_create_tokens), color: '#E8A23B' },
    ],
  });

  // Daily cache reads (separate — scale is 100× larger)
  stackedBarChart(document.getElementById('ch-daily-cache'), {
    categories: daily.map(d => d.day),
    series: [
      { name: 'cache read', values: daily.map(d => d.cache_read_tokens), color: '#3FB68B' },
    ],
  });

  // by-model doughnut
  donutChart(document.getElementById('ch-model'),
    byModel.map(m => ({
      name: fmt.modelShort(m.model) || 'unknown',
      value: (m.input_tokens || 0) + (m.output_tokens || 0)
           + (m.cache_create_5m_tokens || 0) + (m.cache_create_1h_tokens || 0),
    })).filter(d => d.value > 0),
  );

  // tokens by project — input vs output
  const topProjects = projects.slice(0, 8);
  groupedBarChart(document.getElementById('ch-projects'), {
    categories: topProjects.map(p => {
      const name = p.project_name || p.project_slug;
      return name.length > 20 ? name.slice(0, 19) + '…' : name;
    }),
    series: [
      { name: 'input',  values: topProjects.map(p => p.input_tokens  || 0), color: '#4A9EFF' },
      { name: 'output', values: topProjects.map(p => p.output_tokens || 0), color: '#7C5CFF' },
    ],
  });

  // top tools
  const topTools = tools.slice(0, 8);
  barChart(document.getElementById('ch-tools'), {
    categories: topTools.map(t => t.tool_name),
    values: topTools.map(t => t.calls),
    color: '#7C5CFF',
  });
}

function planSubtitle() {
  if (!state.pricing || state.plan === 'api') return '';
  const p = state.pricing.plans[state.plan];
  if (!p || !p.monthly) return '';
  return `<div class="sub">pay $${p.monthly}/mo on ${fmt.htmlSafe(p.label)}</div>`;
}
