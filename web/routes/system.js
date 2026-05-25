// system.js — renders SYSTEM_DASHBOARD.md (or any configured markdown) as a tab.
import { api, fmt } from '/web/app.js';

function escapeHtml(s) {
  return (s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(s) {
  // Inline code first so markdown inside it is left alone.
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

function isTableHeader(line, nextLine) {
  return line && nextLine && line.includes('|') &&
    /^\s*\|?[\s\-:|]+\|[\s\-:|]+/.test(nextLine);
}

function splitRow(line) {
  return line.split('|')
    .map(c => c.trim())
    .filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === ''));
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]); i++;
      }
      i++; // closing ```
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(escapeHtml(h[2]))}</h${lvl}>`);
      i++; continue;
    }

    // Table
    if (isTableHeader(line, lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        '<table><thead><tr>' +
        header.map(c => `<th>${inline(escapeHtml(c))}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map(r =>
          '<tr>' + r.map(c => `<td>${inline(escapeHtml(c))}</td>`).join('') + '</tr>'
        ).join('') +
        '</tbody></table>'
      );
      continue;
    }

    // Unordered list
    if (/^\s*-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*-\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map(it => `<li>${inline(escapeHtml(it))}</li>`).join('') + '</ul>');
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      out.push('<hr>'); i++; continue;
    }

    // Blank line
    if (line.trim() === '') { i++; continue; }

    // Paragraph
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !/^\s*-\s+/.test(lines[i]) &&
      !isTableHeader(lines[i], lines[i + 1])
    ) {
      buf.push(lines[i]); i++;
    }
    if (buf.length) out.push(`<p>${inline(escapeHtml(buf.join(' ')))}</p>`);
  }
  return out.join('\n');
}

function ageLabel(mtime) {
  const min = Math.round(Date.now() / 1000 - mtime) / 60;
  if (min < 60) return `${Math.round(min)}m ago`;
  if (min < 1440) return `${Math.round(min / 60)}h ago`;
  return `${Math.round(min / 1440)}d ago`;
}

export default async function (root) {
  const data = await api('/api/system');

  if (!data.configured) {
    root.innerHTML = `
      <div class="card">
        <h2>System Dashboard</h2>
        <p class="muted">${fmt.htmlSafe(data.hint || 'Not configured.')}</p>
      </div>`;
    return;
  }
  if (data.error) {
    root.innerHTML = `
      <div class="card">
        <h2>System Dashboard</h2>
        <p class="muted">Failed to read <code>${fmt.htmlSafe(data.path)}</code>: ${fmt.htmlSafe(data.error)}</p>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="card system-md">
      <div style="display:flex;align-items:baseline;gap:12px;margin:-2px 0 14px;flex-wrap:wrap">
        <h2 style="margin:0">System Dashboard</h2>
        <span class="muted" style="font-size:12px">source: <code>${fmt.htmlSafe(data.path)}</code> · regenerated ${ageLabel(data.mtime)}</span>
      </div>
      ${renderMarkdown(data.markdown)}
    </div>`;
}
