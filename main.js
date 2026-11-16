'use strict';
/*
 * In the Margins — read a big pile of books at once without losing any of them.
 * Keeps 20–30+ books in rotation: one-tap touches, staleness nudges,
 * topics, final thoughts, exports, and a connections map.
 * Plain JavaScript, no build step. Works on desktop and mobile.
 */
const obsidian = require('obsidian');
const {
  Plugin, ItemView, Modal, Notice, Setting, PluginSettingTab, TFile, Menu,
  MarkdownRenderChild, normalizePath, requestUrl, setIcon, debounce,
} = obsidian;

const VIEW_TYPE = 'in-the-margins-view';
const STATUS_LABEL = { reading: 'Reading', queued: 'Queue', finished: 'Finished', 'set aside': 'Set aside' };
const USEFUL_LABEL = { 1: 'Some value', 2: 'Useful', 3: 'Deeply useful' };

const DEFAULT_SETTINGS = {
  booksFolder: 'Books',
  topicsFolder: 'Topics',
  exportsFolder: 'Exports',
  mapsFolder: 'Maps',
  staleDays: 14,
  warnDays: 3,
  suggestionCount: 4,
  openOnStartup: true,
  lastExportDate: '',
  exportedKeys: [],
};

/* ------------------------------------------------------------------ */
/* Pure helpers (no Obsidian API) — exported for testing               */
/* ------------------------------------------------------------------ */

function pad(n) { return String(n).padStart(2, '0'); }

function todayStr(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function parseLocal(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(a, b) {
  return Math.round((parseLocal(b) - parseLocal(a)) / 86400000);
}

function niceDate(s) {
  if (!s) return '';
  return parseLocal(s).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function shortDate(s) {
  if (!s) return '';
  return parseLocal(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "[[Topics/Hockey|Hockey]]" -> "Hockey" */
function stripLink(v) {
  let s = String(v == null ? '' : v).trim();
  const m = s.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/);
  if (m) s = m[1];
  s = s.split('/').pop();
  return s.replace(/\.md$/i, '').trim();
}

/** Accepts a YAML list, a comma string, or the nested arrays YAML makes of unquoted [[links]]. */
function toList(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v.flat(Infinity) : String(v).split(',');
  const out = [];
  for (const x of arr) {
    const s = stripLink(x);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function normStatus(v) {
  const s = String(v || '').toLowerCase().trim();
  if (/^(finished|done|complete|completed|read)$/.test(s)) return 'finished';
  if (/^(set[ _-]?aside|parked|paused|dnf|abandoned)$/.test(s)) return 'set aside';
  if (/^(queued|queue|up next|next|to read|tbr|want to read)$/.test(s)) return 'queued';
  return 'reading';
}

function normUseful(v) {
  const n = parseInt(v, 10);
  return n >= 1 && n <= 3 ? n : 0;
}

function bookFromFrontmatter(path, basename, fm) {
  fm = fm || {};
  return {
    path,
    basename,
    title: String(fm.title || basename),
    author: fm.author ? String(fm.author) : '',
    cover: fm.cover ? String(fm.cover) : '',
    link: fm.link ? String(fm.link) : '',
    status: normStatus(fm.status),
    useful: normUseful(fm.useful),
    topics: toList(fm.topics),
    related: toList(fm.related),
    started: toDateStr(fm.started),
    lastTouched: toDateStr(fm.last_touched),
    ended: toDateStr(fm.ended),
    added: toDateStr(fm.added),
  };
}

/** Days since the book was last picked up (falls back to its start date). null = never. */
function ageOf(book, today) {
  const ref = book.lastTouched || book.started;
  if (!ref) return null;
  return Math.max(0, daysBetween(ref, today));
}

function stateOf(age, settings) {
  if (age == null) return 'stale';
  if (age >= settings.staleDays) return 'stale';
  if (age >= settings.staleDays - settings.warnDays) return 'due';
  return 'fresh';
}

function ageLabel(age) {
  if (age == null) return 'not yet';
  if (age === 0) return 'today';
  if (age === 1) return 'yesterday';
  return `${age} days`;
}

function byTitle(a, b) {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
}

/** Oldest-touched first; never-touched books come first of all. */
function byStaleness(today) {
  return (a, b) => {
    const x = ageOf(a, today), y = ageOf(b, today);
    const xa = x == null ? Infinity : x, ya = y == null ? Infinity : y;
    return ya - xa || byTitle(a, b);
  };
}

function suggestionsFor(books, settings, today) {
  return books
    .filter((b) => b.status === 'reading' && stateOf(ageOf(b, today), settings) !== 'fresh')
    .sort(byStaleness(today))
    .slice(0, settings.suggestionCount);
}

/** Books sharing topics with `book`, plus anything linked through `related` either way. */
function connectedBooks(book, books) {
  const out = [];
  for (const other of books) {
    if (other.path === book.path) continue;
    const shared = other.topics.filter((t) => book.topics.includes(t));
    const related = book.related.includes(other.basename) || book.related.includes(other.title)
      || other.related.includes(book.basename) || other.related.includes(book.title);
    const score = shared.length + (related ? 3 : 0);
    if (score > 0) out.push({ book: other, shared, related, score });
  }
  return out.sort((a, b) => b.score - a.score || byTitle(a.book, b.book));
}

const WHY_HEADING = 'Why this book';
const WHY_PROMPT = 'What drew you to it, and what are you hoping to find?';

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function sectionRange(content, heading) {
  const m = new RegExp(`^##[ \\t]+${escapeRe(heading)}[ \\t]*$`, 'im').exec(content || '');
  if (!m) return null;
  const start = m.index + m[0].length;
  // The section ends at the next heading or at the plugin's code block.
  const next = /^(#{1,2}\s|```(?:in-the-margins|reading-pile))/m.exec(content.slice(start));
  const end = next ? start + next.index : content.length;
  return { start, end, text: content.slice(start, end) };
}

function getWhy(content) {
  const r = sectionRange(content, WHY_HEADING);
  return r ? r.text.trim() : '';
}

/** Write the Why section. A missing section goes above the plugin's code block (or the first ## heading). */
function setWhy(content, text) {
  text = (text || '').trim();
  const r = sectionRange(content, WHY_HEADING);
  if (r) {
    const after = content.slice(r.end).replace(/^\n+/, '');
    return `${content.slice(0, r.start)}\n\n${text ? `${text}\n\n` : '\n'}${after}`;
  }
  if (!text) return content;
  const block = `## ${WHY_HEADING}\n\n${text}\n\n`;
  const anchor = /^```(?:in-the-margins|reading-pile)/m.exec(content) || /^##\s/m.exec(content);
  if (anchor) return content.slice(0, anchor.index) + block + content.slice(anchor.index);
  return `${content.replace(/\s*$/, '')}\n\n${block}`;
}

function extractFinalThoughts(content) {
  const m = /^##\s+Final thoughts\s*$/im.exec(content || '');
  if (!m) return '';
  const rest = content.slice(m.index + m[0].length);
  const next = /^#{1,2}\s/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** Final thoughts without the dated "**Finished · 2026-11-11**" lines, for exports. */
function cleanThoughts(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => !/^\*\*(Finished|Set aside) · \d{4}-\d{2}-\d{2}\*\*\s*$/.test(l.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendFinalThoughts(content, status, date, text) {
  text = (text || '').trim();
  if (!text) return content;
  const entry = `**${STATUS_LABEL[status] || status} · ${date}**\n\n${text}\n`;
  const m = /^##\s+Final thoughts\s*$/im.exec(content);
  if (!m) return `${content.replace(/\s*$/, '')}\n\n## Final thoughts\n\n${entry}`;
  // Insert at the end of the existing Final thoughts section.
  const start = m.index + m[0].length;
  const rest = content.slice(start);
  const next = /^#{1,2}\s/m.exec(rest);
  const end = next ? start + next.index : content.length;
  const before = content.slice(0, end).replace(/\s*$/, '');
  const after = content.slice(end);
  return `${before}\n\n${entry}${after ? `\n${after}` : ''}`;
}

function safeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}

function yamlStr(s) { return JSON.stringify(String(s == null ? '' : s)); }

function buildBookNote({ title, author, cover, link, topics, useful, date, started, status, why }) {
  const queued = status === 'queued';
  const lines = ['---',
    `title: ${yamlStr(title)}`,
    `author: ${yamlStr(author)}`,
    `cover: ${yamlStr(cover)}`,
    `link: ${yamlStr(link)}`,
    `status: ${queued ? 'queued' : 'reading'}`,
    `useful: ${useful ? useful : ''}`.trimEnd()];
  if (topics && topics.length) {
    lines.push('topics:');
    for (const t of topics) lines.push(`  - ${yamlStr(`[[${t}]]`)}`);
  } else {
    lines.push('topics: []');
  }
  lines.push('related: []', `added: ${date}`,
    queued ? 'started:' : `started: ${toDateStr(started) || date}`,
    queued ? 'last_touched:' : `last_touched: ${date}`,
    'ended:', '---', '');
  if (cover) lines.push(`![cover|160](${cover})`, '');
  lines.push(`## ${WHY_HEADING}`, '', ...(why && why.trim() ? [why.trim(), ''] : ['']));
  lines.push('```in-the-margins', 'show: connected', '```', '', '## Notes', '', '');
  return lines.join('\n');
}

function buildTopicNote(name) {
  return ['---', 'type: topic', '---', '', '```in-the-margins', 'show: topic', '```', '',
    '## Notes', '', `What ${name} means to me, and what I'm looking for in these books.`, ''].join('\n');
}

function md(s) { return String(s || '').replace(/([*_`[\]])/g, '\\$1'); }

const LINK_SITES = { 'bookpile.org': 'Bookpile', 'goodreads.com': 'Goodreads', 'thestorygraph.com': 'StoryGraph', 'app.thestorygraph.com': 'StoryGraph', 'openlibrary.org': 'Open Library', 'bookshop.org': 'Bookshop', 'librarything.com': 'LibraryThing' };

/** A short label for a book link, from its site: "Bookpile", "Goodreads", or the host name. */
function linkLabel(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return LINK_SITES[host] || host;
  } catch (e) { return 'Link'; }
}

function bookLine(b) {
  const bits = [`**${md(b.title)}**`];
  if (b.author) bits[0] += ` by ${md(b.author)}`;
  const tail = [];
  if (b.useful) tail.push(USEFUL_LABEL[b.useful].toLowerCase());
  if (b.link) tail.push(`[${linkLabel(b.link)}](${b.link})`);
  return `- ${bits.join('')}${tail.length ? ` — ${tail.join(' · ')}` : ''}`;
}

function bookBlock(b, thoughts, dateLabel) {
  const meta = [];
  if (b.author) meta.push(`*${md(b.author)}*`);
  if (dateLabel) meta.push(dateLabel);
  if (b.useful) meta.push(USEFUL_LABEL[b.useful]);
  if (b.topics.length) meta.push(b.topics.join(', '));
  if (b.link) meta.push(`[${linkLabel(b.link)}](${b.link})`);
  const out = [`### ${md(b.title)}`, '', meta.join(' · ')];
  if (thoughts) out.push('', thoughts.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
  out.push('');
  return out.join('\n');
}

function groupByFirstTopic(books) {
  const groups = new Map();
  for (const b of books) {
    const k = b.topics[0] || 'Everything else';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'Everything else') return 1;
    if (b === 'Everything else') return -1;
    return a.localeCompare(b);
  });
  return keys.map((k) => [k, groups.get(k).sort(byTitle)]);
}

function exportInProgress(books, today) {
  const reading = books.filter((b) => b.status === 'reading');
  const out = [`# What I'm reading — ${niceDate(today)}`, '',
    `${reading.length} ${reading.length === 1 ? 'book' : 'books'} in rotation.`, ''];
  for (const [topic, list] of groupByFirstTopic(reading)) {
    out.push(`## ${topic}`, '', ...list.map(bookLine), '');
  }
  const queue = books.filter((b) => b.status === 'queued').sort(byTitle);
  if (queue.length) out.push('## Up next', '', ...queue.map(bookLine), '');
  return out.join('\n');
}

function closedKey(b) { return `${b.title}|${b.status}|${b.ended}`; }

function exportSinceLast(books, thoughts, settings, today) {
  const seen = new Set(settings.exportedKeys || []);
  const fresh = books.filter((b) => (b.status === 'finished' || b.status === 'set aside') && !seen.has(closedKey(b)));
  if (!fresh.length) return null;
  const since = settings.lastExportDate ? `since ${niceDate(settings.lastExportDate)}` : 'so far';
  const out = [`# Finished & set aside — ${since}`, '', `*Exported ${niceDate(today)}*`, ''];
  for (const status of ['finished', 'set aside']) {
    const list = fresh.filter((b) => b.status === status).sort((a, b) => (a.ended || '').localeCompare(b.ended || '') || byTitle(a, b));
    if (!list.length) continue;
    out.push(`## ${STATUS_LABEL[status]}`, '');
    for (const b of list) out.push(bookBlock(b, thoughts[b.path], b.ended ? shortDate(b.ended) : ''));
  }
  return { markdown: out.join('\n'), keys: fresh.map(closedKey) };
}

/* --- year-in-reading report core v1 (shared by In the Margins, Brown Bag, The Stacks and Brainrot) --- */
/*
 * Each plugin builds a report object in the year-in-reading/1 shape, then calls
 * renderReportMarkdown() for the note and JSON.stringify() for the .json file.
 * The JSON is what the Year in Reading page reads.
 *
 * {
 *   schema: 'year-in-reading/1',
 *   source: { plugin, name, unit, units },          // unit: 'book' | 'fic' | 'session'
 *   year: '2026', generated: '2026-12-31', title,
 *   covers: [{ title, cover }],
 *   stats: [{ label, value }],                       // "At a glance"
 *   top: [{ label, name, count, of }],               // "Most read" (heading: topHeading)
 *   highlights: ['markdown', ...],
 *   months: { label, values: [12], secondary: { label, values: [12] } | null },
 *   sections: [{ heading, items: [item] }],
 *   tables: [{ heading, columns: [...], rows: [[...]] }],
 * }
 * item: { title, author, link, linkLabel, cover, date, meta: ['markdown'], fields: [{ label, text }],
 *         checklist: [{ text, done }], quote, tags: [] }
 */
const REPORT_SCHEMA = 'year-in-reading/1';
const REPORT_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function rMd(s) { return String(s == null ? '' : s).replace(/([*_`[\]|])/g, '\\$1'); }
function rAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function rImg(title, cover, width) {
  return cover ? `<img src="${rAttr(cover)}" alt="${rAttr(`Cover of ${title}`)}" width="${width}">` : '';
}
function rPlural(n, one, many) { return `${n} ${n === 1 ? one : (many || `${one}s`)}`; }
function rNum(n) { return typeof n === 'number' ? n.toLocaleString('en-US') : String(n == null ? '' : n); }
function rOneLine(s) { return String(s || '').replace(/\s*\n+\s*/g, ' ').trim(); }
function rDate(d) {
  if (!/^\d{4}-\d\d-\d\d$/.test(d || '')) return d || '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Count values → [{ name, count }] sorted by count, then name. */
function rRank(values) {
  const m = new Map();
  for (const v of values) {
    if (v == null || v === '') continue;
    const key = String(v).toLowerCase();
    if (!m.has(key)) m.set(key, { name: String(v), count: 0 });
    m.get(key).count++;
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The "Most read" row for one dimension: ties share the top spot. */
function rTop(label, ranked, of) {
  if (!ranked.length) return null;
  const best = ranked.filter((x) => x.count === ranked[0].count);
  if ((ranked[0].count < 2 && of > 1) || best.length > 3) return null; // no clear favorite
  return { label, name: best.map((x) => x.name).join(', '), count: ranked[0].count, of };
}

function rMonthCounts(dates) {
  const out = new Array(12).fill(0);
  for (const d of dates) { const m = /^\d{4}-(\d\d)/.exec(d || ''); if (m) out[Number(m[1]) - 1]++; }
  return out;
}

function newReport(source, year, title) {
  return {
    schema: REPORT_SCHEMA, source, year: String(year), generated: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })(),
    title, covers: [], stats: [], top: [], highlights: [], months: null, sections: [], tables: [],
  };
}

function renderReportMarkdown(r) {
  const out = [`# ${r.title}`, '', `*Made ${rDate(r.generated)} from ${r.source.name}.*`, ''];
  const itemCount = r.sections.reduce((n, s) => n + s.items.length, 0);
  if (!itemCount && !r.stats.length) { out.push(`Nothing logged in ${r.year}.`, ''); return out.join('\n'); }
  const covers = r.covers.filter((c) => c.cover);
  if (covers.length) out.push(covers.map((c) => rImg(c.title, c.cover, 72)).join(' '), '');

  if (r.stats.length) {
    out.push('## At a glance', '', '| | |', '| --- | --- |', ...r.stats.map((s) => `| ${rMd(s.label)} | ${rNum(s.value)} |`), '');
  }
  const top = r.top.filter(Boolean);
  if (top.length) {
    out.push(`## ${r.topHeading || 'Most read'}`, '', `| | Top | ${r.source.units[0].toUpperCase()}${r.source.units.slice(1)} |`, '| --- | --- | --- |',
      ...top.map((t) => `| ${rMd(t.label)} | ${rMd(t.name)} | ${t.count} of ${t.of} |`), '');
  }
  if (r.highlights.length) out.push('## Highlights', '', ...r.highlights.map((h) => `- ${h}`), '');

  if (r.months && r.months.values.some(Boolean)) {
    const v = r.months.values, sec = r.months.secondary;
    const max = Math.max(...v);
    out.push('## Month by month', '', '```');
    REPORT_MONTHS.forEach((m, i) => {
      const bar = v[i] ? '█'.repeat(Math.max(1, Math.round((v[i] / max) * 24))) : '';
      const extra = sec && sec.values[i] ? `  ${rNum(sec.values[i])} ${sec.label}` : '';
      out.push(`${m.slice(0, 3)}  ${bar.padEnd(25)}${v[i] || ''}${extra}`.trimEnd());
    });
    out.push('```', `*${r.months.label}${sec ? `, with ${sec.label}` : ''}.*`, '');
  }

  for (const s of r.sections) {
    if (!s.items.length) continue;
    out.push(`## ${s.heading}`, '');
    for (const it of s.items) {
      out.push(`### ${rMd(it.title)}`, '');
      if (it.cover) out.push(rImg(it.title, it.cover, 120), '');
      const meta = [...(it.author ? [`*${rMd(it.author)}*`] : []), ...(it.meta || [])];
      if (it.link) meta.push(`[${it.linkLabel || 'Link'}](${it.link})`);
      if (meta.length) out.push(meta.join(' · '), '');
      for (const f of it.fields || []) if (f.text) out.push(`**${f.label}:** ${rOneLine(f.text)}`, '');
      if (it.checklist && it.checklist.length) out.push(...it.checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`), '');
      if (it.quote) out.push(String(it.quote).trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'), '');
    }
  }
  for (const t of r.tables) {
    if (!t.rows.length) continue;
    out.push(`## ${t.heading}`, '', `| ${t.columns.join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`,
      ...t.rows.map((row) => `| ${row.map((c) => rMd(rNum(c))).join(' | ')} |`), '');
  }
  return out.join('\n');
}
/* --- end report core --- */

/**
 * Year-end report data (year-in-reading/1): every book finished or set aside in the
 * year, with its "why" and final thoughts, plus a few numbers about the year.
 */
function buildYearReport(books, thoughts, year, whys) {
  whys = whys || {};
  thoughts = thoughts || {};
  const y = String(year);
  const inYear = (d) => d && d.startsWith(`${y}-`);
  const byEnded = (a, b) => a.ended.localeCompare(b.ended) || byTitle(a, b);
  const finished = books.filter((b) => b.status === 'finished' && inYear(b.ended)).sort(byEnded);
  const aside = books.filter((b) => b.status === 'set aside' && inYear(b.ended)).sort(byEnded);
  const closed = [...finished, ...aside];
  const started = books.filter((b) => inYear(b.started));
  const still = books.filter((b) => b.status === 'reading' && b.started && b.started <= `${y}-12-31`).sort(byTitle);
  const days = (b) => (b.started && b.ended ? Math.max(0, daysBetween(b.started, b.ended)) : null);
  const r = newReport({ plugin: 'in-the-margins', name: 'In the Margins', unit: 'book', units: 'books' }, y, `${y} in the margins`);

  r.covers = finished.filter((b) => b.cover).map((b) => ({ title: b.title, cover: b.cover }));
  const timed = finished.map(days).filter((d) => d != null);
  const avg = timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
  r.stats.push({ label: 'Finished', value: finished.length }, { label: 'Set aside', value: aside.length },
    { label: 'Started', value: started.length }, { label: "Still reading at year's end", value: still.length });
  if (avg != null) r.stats.push({ label: 'Average time with a finished book', value: rPlural(avg, 'day') });
  const deep = closed.filter((b) => b.useful === 3).length;
  if (deep) r.stats.push({ label: 'Deeply useful', value: deep });

  const topics = rRank(closed.flatMap((b) => b.topics));
  r.top = [rTop('Topic', topics, closed.length), rTop('Author', rRank(closed.map((b) => b.author)), closed.length),
    rTop('Usefulness', rRank(closed.map((b) => USEFUL_LABEL[b.useful])), closed.length)].filter(Boolean);

  const hi = r.highlights;
  const withDays = finished.filter((b) => days(b) != null);
  const longest = [...withDays].sort((a, b) => days(b) - days(a))[0];
  const quickest = [...withDays].sort((a, b) => days(a) - days(b))[0];
  if (longest) hi.push(`**Longest companion:** *${rMd(longest.title)}*, ${rPlural(days(longest), 'day')} from start to finish.`);
  if (quickest && quickest !== longest) hi.push(`**Quickest finish:** *${rMd(quickest.title)}*, in ${rPlural(days(quickest), 'day')}.`);
  const carried = finished.filter((b) => b.started && !inYear(b.started));
  if (carried.length) hi.push(`**Carried in from earlier years:** ${rPlural(carried.length, 'book')} finished this year ${carried.length === 1 ? 'was' : 'were'} started before ${y}.`);
  const months = rMonthCounts(closed.map((b) => b.ended));
  const peak = Math.max(...months);
  if (peak > 1) hi.push(`**Busiest month:** ${REPORT_MONTHS.filter((_, i) => months[i] === peak).join(' and ')}, with ${peak} books closed.`);
  const topicStats = new Map();
  for (const b of closed) for (const t of b.topics) {
    if (!topicStats.has(t)) topicStats.set(t, { finished: 0, aside: 0, useful: [] });
    const st = topicStats.get(t);
    if (b.status === 'finished') st.finished++; else st.aside++;
    if (b.useful) st.useful.push(b.useful);
  }
  const avgUse = (st) => (st.useful.length ? st.useful.reduce((a, b) => a + b, 0) / st.useful.length : 0);
  const bestTopic = [...topicStats].filter(([, st]) => st.useful.length >= 2).sort((a, b) => avgUse(b[1]) - avgUse(a[1]))[0];
  if (bestTopic) hi.push(`**Most useful topic:** ${bestTopic[0]} (${USEFUL_LABEL[Math.round(avgUse(bestTopic[1]))].toLowerCase()} on average).`);
  const ranked = closed.map((b) => [b, connectedBooks(b, books).length]).sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] > 1) hi.push(`**Most connected:** *${rMd(ranked[0][0].title)}* shares topics with ${rPlural(ranked[0][1], 'other book')}.`);
  if (aside.length && closed.length) hi.push(`**Set aside rate:** ${Math.round((aside.length / closed.length) * 100)}% of the books closed this year were set aside. Knowing when to stop counts too.`);

  r.months = { label: 'Books finished or set aside', values: months, secondary: null };
  const item = (b) => ({
    title: b.title, author: b.author, cover: b.cover, date: b.ended,
    link: b.link, linkLabel: b.link ? linkLabel(b.link) : '',
    meta: [`${b.status === 'finished' ? 'finished' : 'set aside'} ${rDate(b.ended)}`, days(b) != null && rPlural(days(b), 'day'),
      b.useful && USEFUL_LABEL[b.useful], b.topics.join(', ')].filter(Boolean),
    fields: [{ label: 'Why I picked it up', text: whys[b.path] || '' }],
    quote: thoughts[b.path] || '',
    tags: [b.status === 'finished' ? 'Finished' : 'Set aside', ...(b.useful ? [USEFUL_LABEL[b.useful]] : []), ...b.topics],
  });
  r.sections = [{ heading: 'Finished', items: finished.map(item) }, { heading: 'Set aside', items: aside.map(item) }];
  r.tables.push({ heading: 'By topic', columns: ['Topic', 'Finished', 'Set aside', 'Usefulness'],
    rows: [...topicStats].sort((a, b) => (b[1].finished + b[1].aside) - (a[1].finished + a[1].aside) || a[0].localeCompare(b[0]))
      .map(([t, st]) => [t, st.finished, st.aside, st.useful.length ? '●'.repeat(Math.round(avgUse(st))) : '']) });
  r.tables.push({ heading: 'Still reading', columns: ['Title', 'Author', 'Started'], rows: still.map((b) => [b.title, b.author, rDate(b.started)]) });
  return r;
}

function exportYear(books, thoughts, year, whys) { return renderReportMarkdown(buildYearReport(books, thoughts, year, whys)); }

const ALL_COLUMNS = ['Title', 'Author', 'Status', 'Useful', 'Topics', 'Related', 'Started', 'Last touched', 'Ended', 'Link', 'Cover', 'Final thoughts'];

function allRows(books, thoughts) {
  return [...books].sort(byTitle).map((b) => [
    b.title, b.author, STATUS_LABEL[b.status], b.useful ? USEFUL_LABEL[b.useful] : '',
    b.topics.join(', '), b.related.join(', '), b.started, b.lastTouched, b.ended,
    b.link, b.cover, thoughts[b.path] || '',
  ]);
}

function exportAllMarkdown(books, thoughts, today) {
  const cell = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const cols = ALL_COLUMNS.slice(0, -2); // cover and thoughts live in the CSV
  const rows = allRows(books, thoughts).map((r) => r.slice(0, cols.length));
  return [`# All books — ${niceDate(today)}`, '', `${books.length} books. The full data, including final thoughts, is in the CSV next to this file.`, '',
    `| ${cols.join(' | ')} |`, `|${cols.map(() => ' --- ').join('|')}|`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`), ''].join('\n');
}

function exportAllCsv(books, thoughts) {
  const q = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
  return [ALL_COLUMNS, ...allRows(books, thoughts)].map((r) => r.map(q).join(',')).join('\n') + '\n';
}

/** JSON Canvas: topics on a ring, books placed between the topics they belong to. */
function buildCanvas(books, topicPaths, settings, today) {
  const topicNames = [...new Set([...Object.keys(topicPaths), ...books.flatMap((b) => b.topics)])].sort();
  const TW = 220, TH = 70, BW = 250, BH = 76, GAP = 24;
  const R = Math.max(520, topicNames.length * 120);
  const topicPos = {};
  const nodes = [], edges = [], placed = [];
  const id = (s) => s.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) + Math.random().toString(36).slice(2, 8);

  topicNames.forEach((t, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, topicNames.length) - Math.PI / 2;
    const x = Math.round(R * Math.cos(a)), y = Math.round(R * Math.sin(a));
    topicPos[t] = { x, y, id: id(`t${t}`) };
    const label = topicPaths[t] ? `[[${topicPaths[t].replace(/\.md$/, '')}|${t}]]` : t;
    nodes.push({ id: topicPos[t].id, type: 'text', text: `## ${label}`, x: x - TW / 2, y: y - TH / 2, width: TW, height: TH, color: '6' });
    placed.push({ x: x - TW / 2, y: y - TH / 2, w: TW, h: TH });
  });

  const overlaps = (r) => placed.some((p) => r.x < p.x + p.w + GAP && r.x + r.w + GAP > p.x && r.y < p.y + p.h + GAP && r.y + r.h + GAP > p.y);
  const bookId = {};
  const ordered = [...books].sort((a, b) => b.topics.length - a.topics.length || byTitle(a, b));
  for (const b of ordered) {
    const pts = b.topics.map((t) => topicPos[t]).filter(Boolean);
    let ax = 0, ay = 0;
    if (pts.length === 1) {
      // Single-topic books fan outward from their topic.
      const len = Math.hypot(pts[0].x, pts[0].y) || 1;
      ax = pts[0].x * (1 + 260 / len); ay = pts[0].y * (1 + 260 / len);
    } else if (pts.length > 1) {
      ax = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      ay = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    }
    let r = null;
    for (let step = 0; step < 4000 && !r; step++) {
      const ang = step * 0.5, rad = 12 * Math.sqrt(step) * 6;
      const cand = { x: Math.round(ax + rad * Math.cos(ang) - BW / 2), y: Math.round(ay + rad * Math.sin(ang) - BH / 2), w: BW, h: BH };
      if (!overlaps(cand)) r = cand;
    }
    if (!r) r = { x: Math.round(ax), y: Math.round(ay), w: BW, h: BH };
    placed.push(r);
    bookId[b.path] = id(`b${b.basename}`);
    let color;
    if (b.status === 'finished') color = '4';
    else if (b.status === 'reading') {
      const st = stateOf(ageOf(b, today), settings);
      color = st === 'stale' ? '1' : st === 'due' ? '2' : undefined;
    }
    const text = `**[[${b.path.replace(/\.md$/, '')}|${b.title}]]**${b.author ? `\n${b.author}` : ''}`;
    const node = { id: bookId[b.path], type: 'text', text, x: r.x, y: r.y, width: BW, height: BH };
    if (color) node.color = color;
    nodes.push(node);
    for (const t of b.topics) {
      if (!topicPos[t]) continue;
      edges.push({ id: id(`e${b.basename}${t}`), fromNode: bookId[b.path], toNode: topicPos[t].id, toEnd: 'none' });
    }
  }
  // Explicit book-to-book links.
  const byName = {};
  for (const b of books) { byName[b.basename] = b; byName[b.title] = b; }
  const done = new Set();
  for (const b of books) {
    for (const r of b.related) {
      const o = byName[r];
      if (!o || o.path === b.path) continue;
      const k = [b.path, o.path].sort().join('>');
      if (done.has(k)) continue;
      done.add(k);
      edges.push({ id: id(`r${b.basename}`), fromNode: bookId[b.path], toNode: bookId[o.path], color: '5', label: 'related', toEnd: 'none' });
    }
  }
  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/* Plugin                                                             */
/* ------------------------------------------------------------------ */

class InTheMarginsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new PileView(leaf, this));
    this.addRibbonIcon('library', 'Open In the Margins', () => this.activateView());

    const block = (source, el, ctx) => ctx.addChild(new PileBlock(el, this, source, ctx.sourcePath));
    this.registerMarkdownCodeBlockProcessor('in-the-margins', block);
    this.registerMarkdownCodeBlockProcessor('reading-pile', block); // older notes

    this.registerObsidianProtocolHandler('in-the-margins', () => this.activateView());

    this.addCommand({ id: 'open-pile', name: 'Open the pile', callback: () => this.activateView() });
    this.addCommand({ id: 'add-book', name: 'Add a book', callback: () => new AddBookModal(this).open() });
    this.addCommand({ id: 'touch-current', name: 'Mark this book touched today', checkCallback: (checking) => this.withCurrentBook(checking, (b) => this.touch(b)) });
    this.addCommand({ id: 'close-current', name: 'Finish or set aside this book', checkCallback: (checking) => this.withCurrentBook(checking, (b) => new CloseBookModal(this, b).open()) });
    this.addCommand({ id: 'reopen-current', name: 'Put this book back in the pile', checkCallback: (checking) => this.withCurrentBook(checking, (b) => this.reopen(b)) });
    this.addCommand({ id: 'start-current', name: 'Start reading this book (from the queue)', checkCallback: (checking) => this.withCurrentBook(checking, (b) => this.startReading(b)) });
    this.addCommand({ id: 'why-current', name: 'Why this book', checkCallback: (checking) => this.withCurrentBook(checking, (b) => new WhyModal(this, b).open()) });
    this.addCommand({ id: 'cover-current', name: 'Find a cover for this book', checkCallback: (checking) => this.withCurrentBook(checking, (b) => new CoverModal(this, b).open()) });
    this.addCommand({ id: 'export-in-progress', name: 'Export: currently reading', callback: () => this.runExport('progress') });
    this.addCommand({ id: 'export-since-last', name: 'Export: finished & set aside since last export', callback: () => this.runExport('since') });
    this.addCommand({ id: 'export-year', name: 'Year-end report', callback: () => this.runExport('year') });
    this.addCommand({ id: 'export-all', name: 'Export: all data (markdown + CSV)', callback: () => this.runExport('all') });
    this.addCommand({ id: 'connections-map', name: 'Draw the connections map', callback: () => this.drawMap() });

    this.addSettingTab(new PileSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStartup) this.activateView();
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.exportedKeys)) this.settings.exportedKeys = [];
  }

  async saveSettings() { await this.saveData(this.settings); }

  /* ---------- data ---------- */

  inFolder(path, folder) {
    const f = normalizePath(folder || '');
    return f === '' || f === '/' ? true : path.startsWith(`${f}/`);
  }

  readBook(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const book = bookFromFrontmatter(file.path, file.basename, fm);
    book.file = file;
    return book;
  }

  getBooks() {
    return this.app.vault.getMarkdownFiles()
      .filter((f) => this.inFolder(f.path, this.settings.booksFolder))
      .map((f) => this.readBook(f));
  }

  getBook(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile && this.inFolder(f.path, this.settings.booksFolder) ? this.readBook(f) : null;
  }

  /** name -> path for every topic note in the Topics folder */
  getTopicPaths() {
    const out = {};
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (this.inFolder(f.path, this.settings.topicsFolder)) out[f.basename] = f.path;
    }
    return out;
  }

  getTopicNames() {
    const set = new Set(Object.keys(this.getTopicPaths()));
    for (const b of this.getBooks()) b.topics.forEach((t) => set.add(t));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  async readThoughts(books) {
    const out = {};
    for (const b of books) {
      if (b.status === 'reading' || b.status === 'queued') continue;
      out[b.path] = cleanThoughts(extractFinalThoughts(await this.app.vault.cachedRead(b.file)));
    }
    return out;
  }

  async ensureFolder(path) {
    const p = normalizePath(path);
    if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p);
  }

  async ensureTopicNote(name) {
    name = safeFileName(name);
    const path = normalizePath(`${this.settings.topicsFolder}/${name}.md`);
    if (!this.app.vault.getAbstractFileByPath(path)) {
      await this.ensureFolder(this.settings.topicsFolder);
      await this.app.vault.create(path, buildTopicNote(name));
    }
    return name;
  }

  /* ---------- actions ---------- */

  withCurrentBook(checking, fn) {
    const file = this.app.workspace.getActiveFile();
    const book = file && this.getBook(file.path);
    if (!book) return false;
    if (!checking) fn(book);
    return true;
  }

  async touch(book) {
    await this.app.fileManager.processFrontMatter(book.file, (fm) => { fm.last_touched = todayStr(); });
  }

  async setUseful(book, n) {
    await this.app.fileManager.processFrontMatter(book.file, (fm) => { fm.useful = n || null; });
  }

  async closeBook(book, status, useful, thoughts) {
    const date = todayStr();
    await this.app.fileManager.processFrontMatter(book.file, (fm) => {
      fm.status = status;
      fm.ended = date;
      fm.last_touched = date;
      if (useful) fm.useful = useful;
    });
    if (thoughts && thoughts.trim()) {
      await this.app.vault.process(book.file, (data) => appendFinalThoughts(data, status, date, thoughts));
    }
    new Notice(`${book.title}: ${STATUS_LABEL[status].toLowerCase()}`);
  }

  async reopen(book) {
    await this.app.fileManager.processFrontMatter(book.file, (fm) => {
      fm.status = 'reading';
      fm.ended = null;
      fm.last_touched = todayStr();
    });
    new Notice(`${book.title} is back in the pile`);
  }

  async startReading(book) {
    const date = todayStr();
    await this.app.fileManager.processFrontMatter(book.file, (fm) => {
      fm.status = 'reading';
      fm.started = date;
      fm.last_touched = date;
      fm.ended = null;
    });
    new Notice(`Started ${book.title}`);
    if (!(await this.readWhy(book))) new WhyModal(this, book).open();
  }

  async readWhy(book) { return getWhy(await this.app.vault.cachedRead(book.file)); }

  async saveWhy(book, text) {
    await this.app.vault.process(book.file, (data) => setWhy(data, text));
  }

  async createBook(data) {
    await this.ensureFolder(this.settings.booksFolder);
    for (const t of data.topics) await this.ensureTopicNote(t);
    const base = safeFileName(data.title);
    let path = normalizePath(`${this.settings.booksFolder}/${base}.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) {
      path = normalizePath(`${this.settings.booksFolder}/${base} (${i}).md`);
    }
    return this.app.vault.create(path, buildBookNote({ ...data, date: todayStr() }));
  }

  async renameTopic(oldName, newName) {
    newName = safeFileName(newName);
    if (!newName || newName === oldName) return;
    const paths = this.getTopicPaths();
    if (paths[newName]) { new Notice(`There's already a topic called ${newName}`); return; }
    const file = paths[oldName] && this.app.vault.getAbstractFileByPath(paths[oldName]);
    if (file) await this.app.fileManager.renameFile(file, normalizePath(`${this.settings.topicsFolder}/${newName}.md`));
    for (const b of this.getBooks()) {
      if (!b.topics.includes(oldName)) continue;
      await this.app.fileManager.processFrontMatter(b.file, (fm) => {
        fm.topics = toList(fm.topics).map((t) => (t === oldName ? newName : t)).map((t) => `[[${t}]]`);
      });
    }
  }

  async deleteTopic(name) {
    for (const b of this.getBooks()) {
      if (!b.topics.includes(name)) continue;
      await this.app.fileManager.processFrontMatter(b.file, (fm) => {
        fm.topics = toList(fm.topics).filter((t) => t !== name).map((t) => `[[${t}]]`);
      });
    }
    const p = this.getTopicPaths()[name];
    const file = p && this.app.vault.getAbstractFileByPath(p);
    if (file) await this.app.vault.trash(file, false);
  }

  async writeFile(path, content) {
    path = normalizePath(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) { await this.app.vault.modify(existing, content); return existing; }
    return this.app.vault.create(path, content);
  }

  async openFile(file) {
    await this.app.workspace.getLeaf('tab').openFile(file);
  }

  async runExport(kind) {
    const books = this.getBooks();
    const today = todayStr();
    const folder = this.settings.exportsFolder;
    await this.ensureFolder(folder);
    if (kind === 'progress') {
      const f = await this.writeFile(`${folder}/${today} Currently reading.md`, exportInProgress(books, today));
      return this.openFile(f);
    }
    if (kind === 'year') {
      return new PromptModal(this.app, 'Which year?', String(new Date().getFullYear()), async (year) => {
        if (!/^\d{4}$/.test(year)) { new Notice('Enter a four-digit year'); return; }
        const thoughts = await this.readThoughts(books);
        const whys = {};
        for (const b of books) if (b.ended && b.ended.startsWith(year)) whys[b.path] = getWhy(await this.app.vault.cachedRead(b.file));
        const report = buildYearReport(books, thoughts, year, whys);
        const f = await this.writeFile(`${folder}/${year} in the margins.md`, renderReportMarkdown(report));
        await this.writeFile(`${folder}/${year} in the margins.json`, JSON.stringify(report, null, 2));
        this.openFile(f);
      }).open();
    }
    const thoughts = await this.readThoughts(books);
    if (kind === 'since') {
      const res = exportSinceLast(books, thoughts, this.settings, today);
      if (!res) { new Notice('Nothing finished or set aside since the last export'); return; }
      const f = await this.writeFile(`${folder}/${today} Finished and set aside.md`, res.markdown);
      this.settings.lastExportDate = today;
      this.settings.exportedKeys = [...new Set([...this.settings.exportedKeys, ...res.keys])];
      await this.saveSettings();
      return this.openFile(f);
    }
    if (kind === 'all') {
      const f = await this.writeFile(`${folder}/${today} All books.md`, exportAllMarkdown(books, thoughts, today));
      await this.writeFile(`${folder}/${today} All books.csv`, exportAllCsv(books, thoughts));
      new Notice('Exported all books (markdown and CSV)');
      return this.openFile(f);
    }
  }

  async drawMap() {
    const books = this.getBooks();
    if (!books.length) { new Notice('Add a few books first'); return; }
    await this.ensureFolder(this.settings.mapsFolder);
    const canvas = buildCanvas(books, this.getTopicPaths(), this.settings, todayStr());
    const f = await this.writeFile(`${this.settings.mapsFolder}/Connections.canvas`, JSON.stringify(canvas, null, '\t'));
    new Notice('Connections map redrawn');
    this.openFile(f);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}

/* ------------------------------------------------------------------ */
/* Shared rendering bits                                              */
/* ------------------------------------------------------------------ */

function renderCover(parent, book, cls) {
  const wrap = parent.createDiv({ cls: `itm-cover ${cls || ''}` });
  const placeholder = () => {
    wrap.empty();
    wrap.addClass('itm-cover-blank');
    wrap.createDiv({ cls: 'itm-cover-title', text: book.title });
  };
  if (book.cover) {
    const img = wrap.createEl('img', { attr: { src: book.cover, alt: '', loading: 'lazy' } });
    img.addEventListener('error', placeholder);
  } else placeholder();
  return wrap;
}

function renderUseful(parent, plugin, book, opts) {
  const el = parent.createDiv({ cls: 'itm-useful', attr: { 'aria-label': book.useful ? USEFUL_LABEL[book.useful] : 'How useful?' } });
  for (let i = 1; i <= 3; i++) {
    const pip = el.createEl('button', { cls: `itm-pip ${i <= book.useful ? 'is-on' : ''}`, attr: { 'aria-label': USEFUL_LABEL[i], title: USEFUL_LABEL[i] } });
    pip.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = book.useful === i ? 0 : i;
      if (opts && opts.onPick) opts.onPick(n); else plugin.setUseful(book, n);
    });
  }
  return el;
}

function openBookLink(plugin, book, sourcePath, evt) {
  const newTab = obsidian.Keymap ? obsidian.Keymap.isModEvent(evt) : false;
  plugin.app.workspace.openLinkText(book.path, sourcePath || '', newTab || 'tab');
}

/* ------------------------------------------------------------------ */
/* The pile view                                                      */
/* ------------------------------------------------------------------ */

class PileView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tab = 'reading';
    this.topic = null;
    this.sort = 'stale';
    this.render = debounce(this.renderNow.bind(this), 150, true);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'In the Margins'; }
  getIcon() { return 'library'; }

  async onOpen() {
    this.registerEvent(this.app.metadataCache.on('changed', () => this.render()));
    this.registerEvent(this.app.vault.on('delete', () => this.render()));
    this.registerEvent(this.app.vault.on('rename', () => this.render()));
    // Day rolls over while the app stays open: refresh ages.
    this.registerInterval(window.setInterval(() => {
      if (this.renderedFor !== todayStr()) this.render();
    }, 60 * 1000));
    this.renderNow();
  }

  renderNow() {
    const c = this.contentEl;
    const scroll = c.scrollTop;
    c.empty();
    c.addClass('itm-view');
    const s = this.plugin.settings;
    const today = todayStr();
    this.renderedFor = today;
    const books = this.plugin.getBooks();
    const reading = books.filter((b) => b.status === 'reading');
    const states = reading.map((b) => stateOf(ageOf(b, today), s));
    const nStale = states.filter((x) => x === 'stale').length;
    const nDue = states.filter((x) => x === 'due').length;

    // Header
    const head = c.createDiv({ cls: 'itm-head' });
    const titles = head.createDiv({ cls: 'itm-head-titles' });
    titles.createEl('h2', { text: 'In the Margins' });
    const summary = titles.createDiv({ cls: 'itm-summary' });
    summary.createSpan({ text: `${reading.length} reading` });
    if (nStale) summary.createSpan({ cls: 'itm-sum-stale', text: ` · ${nStale} stale` });
    if (nDue) summary.createSpan({ cls: 'itm-sum-due', text: ` · ${nDue} due soon` });

    const actions = head.createDiv({ cls: 'itm-head-actions' });
    const addBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Add book' });
    addBtn.addEventListener('click', () => new AddBookModal(this.plugin).open());
    const mapBtn = actions.createEl('button', { attr: { 'aria-label': 'Connections map' } });
    setIcon(mapBtn, 'waypoints');
    mapBtn.addEventListener('click', () => this.plugin.drawMap());
    const expBtn = actions.createEl('button', { attr: { 'aria-label': 'Export' } });
    setIcon(expBtn, 'share');
    expBtn.addEventListener('click', (evt) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle('Currently reading').setIcon('book-open').onClick(() => this.plugin.runExport('progress')));
      menu.addItem((i) => i.setTitle('Finished & set aside since last export').setIcon('book-check').onClick(() => this.plugin.runExport('since')));
      menu.addItem((i) => i.setTitle('Year-end report').setIcon('calendar').onClick(() => this.plugin.runExport('year')));
      menu.addItem((i) => i.setTitle('All data (markdown + CSV)').setIcon('table').onClick(() => this.plugin.runExport('all')));
      menu.showAtMouseEvent(evt);
    });

    // Tabs
    const tabs = c.createDiv({ cls: 'itm-tabs' });
    const count = (st) => books.filter((b) => b.status === st).length;
    const tabDefs = [['reading', `Reading ${reading.length}`], ['queued', `Queue ${count('queued')}`], ['finished', `Finished ${count('finished')}`], ['set aside', `Set aside ${count('set aside')}`], ['topics', 'Topics']];
    for (const [key, label] of tabDefs) {
      const t = tabs.createEl('button', { cls: `itm-tab ${this.tab === key ? 'is-active' : ''}`, text: label });
      t.addEventListener('click', () => { this.tab = key; this.renderNow(); });
    }

    if (this.tab === 'topics') {
      this.renderTopics(c, books);
    } else {
      if (this.tab === 'reading') this.renderSuggestions(c, books, today);
      this.renderList(c, books.filter((b) => b.status === this.tab), today);
    }
    c.scrollTop = scroll;
  }

  renderSuggestions(c, books, today) {
    const s = this.plugin.settings;
    const sugg = suggestionsFor(books, s, today);
    if (!sugg.length) return;
    const box = c.createDiv({ cls: 'itm-suggest' });
    box.createDiv({ cls: 'itm-section-label', text: 'Pick one of these up next' });
    const row = box.createDiv({ cls: 'itm-suggest-row' });
    for (const b of sugg) {
      const age = ageOf(b, today);
      const item = row.createDiv({ cls: `itm-suggest-item itm-${stateOf(age, s)}` });
      renderCover(item, b, 'itm-cover-sm').addEventListener('click', (e) => openBookLink(this.plugin, b, '', e));
      const body = item.createDiv({ cls: 'itm-suggest-body' });
      const a = body.createEl('a', { cls: 'itm-title', text: b.title, href: '#' });
      a.addEventListener('click', (e) => { e.preventDefault(); openBookLink(this.plugin, b, '', e); });
      body.createDiv({ cls: 'itm-age', text: age == null ? 'not touched yet' : `${ageLabel(age)} ago` });
      const whyEl = body.createDiv({ cls: 'itm-why' });
      this.plugin.readWhy(b).then((w) => { if (w) whyEl.setText(w); else whyEl.remove(); });
      const btn = body.createEl('button', { cls: 'itm-touch', text: 'Touched' });
      btn.addEventListener('click', () => { btn.setText('✓'); this.plugin.touch(b); });
    }
  }

  renderList(c, list, today) {
    const s = this.plugin.settings;
    // Topic filter
    const topics = [...new Set(list.flatMap((b) => b.topics))].sort((a, b) => a.localeCompare(b));
    if (this.topic && !topics.includes(this.topic)) this.topic = null;
    const bar = c.createDiv({ cls: 'itm-filterbar' });
    if (topics.length) {
      const chips = bar.createDiv({ cls: 'itm-chips itm-filter' });
      const mk = (label, val) => {
        const n = val ? list.filter((b) => b.topics.includes(val)).length : list.length;
        const chip = chips.createEl('button', { cls: `itm-chip ${this.topic === val ? 'is-active' : ''}`, text: `${label} ${n}` });
        chip.addEventListener('click', () => { this.topic = val; this.renderNow(); });
      };
      mk('All', null);
      topics.forEach((t) => mk(t, t));
    }
    const sortSel = bar.createEl('select', { cls: 'dropdown itm-sort' });
    const sorts = this.tab === 'reading'
      ? [['stale', 'Longest untouched'], ['title', 'Title'], ['useful', 'Most useful'], ['started', 'Newest first']]
      : this.tab === 'queued'
        ? [['added', 'Waiting longest'], ['title', 'Title']]
        : [['ended', 'Most recent'], ['title', 'Title'], ['useful', 'Most useful']];
    if (!sorts.some(([k]) => k === this.sort)) this.sort = sorts[0][0];
    for (const [k, label] of sorts) sortSel.createEl('option', { value: k, text: label });
    sortSel.value = this.sort;
    sortSel.addEventListener('change', () => { this.sort = sortSel.value; this.renderNow(); });

    let shown = this.topic ? list.filter((b) => b.topics.includes(this.topic)) : list.slice();
    const cmp = {
      stale: byStaleness(today),
      title: byTitle,
      useful: (a, b) => b.useful - a.useful || byTitle(a, b),
      started: (a, b) => (b.started || '').localeCompare(a.started || '') || byTitle(a, b),
      ended: (a, b) => (b.ended || '').localeCompare(a.ended || '') || byTitle(a, b),
      added: (a, b) => (a.added || '9999').localeCompare(b.added || '9999') || byTitle(a, b),
    }[this.sort];
    shown.sort(cmp);

    if (!shown.length) {
      const empty = c.createDiv({ cls: 'itm-empty' });
      const msg = {
        reading: 'Nothing in the pile yet. Add the books on your nightstand.',
        queued: 'Nothing queued. When you add a book, choose "Queue for later" to save it here.',
      }[this.tab];
      empty.setText(msg || `No books ${STATUS_LABEL[this.tab].toLowerCase()} yet.`);
      return;
    }

    const grid = c.createDiv({ cls: 'itm-grid' });
    for (const b of shown) this.renderCard(grid, b, today, s);
  }

  renderCard(grid, b, today, s) {
    const age = ageOf(b, today);
    const state = b.status === 'reading' ? stateOf(age, s) : b.status === 'queued' ? 'queued' : 'closed';
    const card = grid.createDiv({ cls: `itm-card itm-${state}` });
    const cover = renderCover(card, b);
    cover.addEventListener('click', (e) => openBookLink(this.plugin, b, '', e));
    if (b.status === 'reading') {
      const badge = cover.createDiv({ cls: `itm-badge itm-badge-${state}` });
      badge.setText(state === 'stale' ? (age == null ? 'new' : `${age}d · stale`) : state === 'due' ? `${age}d · due` : ageLabel(age));
    }
    const body = card.createDiv({ cls: 'itm-card-body' });
    const a = body.createEl('a', { cls: 'itm-title', text: b.title, href: '#' });
    a.addEventListener('click', (e) => { e.preventDefault(); openBookLink(this.plugin, b, '', e); });
    if (b.author) body.createDiv({ cls: 'itm-author', text: b.author });
    const meta = body.createDiv({ cls: 'itm-meta' });
    renderUseful(meta, this.plugin, b);
    if (b.link) {
      const l = meta.createEl('a', { cls: 'itm-link', href: b.link, attr: { 'aria-label': `${linkLabel(b.link)} link`, target: '_blank' } });
      setIcon(l, 'external-link');
    }
    if (b.topics.length) {
      const chips = body.createDiv({ cls: 'itm-chips' });
      for (const t of b.topics) chips.createSpan({ cls: 'itm-chip itm-chip-static', text: t });
    }
    if (b.status !== 'reading' && b.ended) body.createDiv({ cls: 'itm-ended', text: `${STATUS_LABEL[b.status]} ${shortDate(b.ended)}` });
    if (b.status === 'queued' && b.added) body.createDiv({ cls: 'itm-ended', text: `Queued ${shortDate(b.added)}` });

    const actions = body.createDiv({ cls: 'itm-actions' });
    if (b.status === 'reading') {
      const touched = age === 0;
      const t = actions.createEl('button', { cls: `itm-touch ${touched ? 'is-done' : 'mod-cta'}`, text: touched ? 'Read today ✓' : 'Touched' });
      t.addEventListener('click', () => { if (!touched) { t.setText('✓'); this.plugin.touch(b); } });
      const close = actions.createEl('button', { cls: 'itm-close', text: 'Close…' });
      close.addEventListener('click', () => new CloseBookModal(this.plugin, b).open());
    } else if (b.status === 'queued') {
      const st = actions.createEl('button', { cls: 'mod-cta', text: 'Start reading' });
      st.addEventListener('click', () => { st.setText('✓'); this.plugin.startReading(b); });
      const drop = actions.createEl('button', { cls: 'itm-close', text: 'Set aside…' });
      drop.addEventListener('click', () => new CloseBookModal(this.plugin, b).open());
    } else {
      const r = actions.createEl('button', { text: 'Back to the pile' });
      r.addEventListener('click', () => this.plugin.reopen(b));
    }
  }

  renderTopics(c, books) {
    const paths = this.plugin.getTopicPaths();
    const names = this.plugin.getTopicNames();
    const box = c.createDiv({ cls: 'itm-topics' });
    box.createEl('p', { cls: 'itm-hint', text: 'Keep this list short. Each topic is a note in your Topics folder, so it can hold your own thoughts about the subject too.' });

    const add = box.createDiv({ cls: 'itm-topic-add' });
    const input = add.createEl('input', { type: 'text', attr: { placeholder: 'New topic' } });
    const addBtn = add.createEl('button', { cls: 'mod-cta', text: 'Add' });
    const doAdd = async () => {
      const v = input.value.trim();
      if (!v) return;
      if (names.some((n) => n.toLowerCase() === v.toLowerCase())) { new Notice(`${v} is already a topic`); return; }
      await this.plugin.ensureTopicNote(v);
      input.value = '';
      this.renderNow();
    };
    addBtn.addEventListener('click', doAdd);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

    if (!names.length) { box.createDiv({ cls: 'itm-empty', text: 'No topics yet.' }); return; }
    const list = box.createDiv({ cls: 'itm-topic-list' });
    for (const name of names) {
      const row = list.createDiv({ cls: 'itm-topic-row' });
      const tagged = books.filter((b) => b.topics.includes(name));
      const nameEl = row.createEl('a', { cls: 'itm-topic-name', text: name, href: '#' });
      nameEl.addEventListener('click', async (e) => {
        e.preventDefault();
        if (paths[name]) this.app.workspace.openLinkText(paths[name], '', 'tab');
        else { await this.plugin.ensureTopicNote(name); this.renderNow(); }
      });
      const reading = tagged.filter((b) => b.status === 'reading').length;
      row.createSpan({ cls: 'itm-topic-count', text: `${reading} reading · ${tagged.length} total${paths[name] ? '' : ' · no note yet'}` });
      const btns = row.createDiv({ cls: 'itm-topic-btns' });
      const ren = btns.createEl('button', { attr: { 'aria-label': `Rename ${name}` } });
      setIcon(ren, 'pencil');
      ren.addEventListener('click', () => new PromptModal(this.app, `Rename ${name}`, name, async (v) => {
        await this.plugin.renameTopic(name, v.trim());
        this.renderNow();
      }).open());
      const del = btns.createEl('button', { cls: 'mod-warning', attr: { 'aria-label': `Delete ${name}` } });
      setIcon(del, 'trash-2');
      del.addEventListener('click', () => new ConfirmModal(this.app,
        `Delete the ${name} topic?`,
        tagged.length ? `It will be removed from ${tagged.length} ${tagged.length === 1 ? 'book' : 'books'}, and the topic note goes to the vault's trash.` : 'The topic note goes to the vault\'s trash.',
        async () => { await this.plugin.deleteTopic(name); this.renderNow(); }).open());
    }
  }
}

/* ------------------------------------------------------------------ */
/* Code block: ```in-the-margins ... ``` inside notes                    */
/* ------------------------------------------------------------------ */

class PileBlock extends MarkdownRenderChild {
  constructor(el, plugin, source, sourcePath) {
    super(el);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.opts = {};
    for (const line of source.split('\n')) {
      const m = line.match(/^\s*([\w ]+?)\s*:\s*(.*?)\s*$/);
      if (m) this.opts[m[1].toLowerCase()] = m[2];
    }
    this.render = debounce(this.renderNow.bind(this), 200, true);
  }

  onload() {
    this.registerEvent(this.plugin.app.metadataCache.on('changed', () => this.render()));
    this.registerEvent(this.plugin.app.vault.on('delete', () => this.render()));
    this.registerEvent(this.plugin.app.vault.on('rename', () => this.render()));
    this.renderNow();
  }

  renderNow() {
    const el = this.containerEl;
    el.empty();
    el.addClass('itm-block');
    const p = this.plugin, s = p.settings, today = todayStr();
    const books = p.getBooks();
    const show = (this.opts.show || '').toLowerCase();
    const here = this.sourcePath.split('/').pop().replace(/\.md$/, '');

    if (show === 'topic' || this.opts.topic) {
      const topic = this.opts.topic || here;
      const tagged = books.filter((b) => b.topics.includes(topic));
      if (!tagged.length) { el.createDiv({ cls: 'itm-empty', text: `No books in ${topic} yet.` }); return; }
      for (const st of ['reading', 'queued', 'finished', 'set aside']) {
        const list = tagged.filter((b) => b.status === st).sort(st === 'reading' ? byStaleness(today) : byTitle);
        if (!list.length) continue;
        el.createDiv({ cls: 'itm-section-label', text: `${STATUS_LABEL[st]} · ${list.length}` });
        this.rows(el, list, today);
      }
      return;
    }

    if (show === 'connected') {
      const book = books.find((b) => b.path === this.sourcePath);
      if (!book) return;
      const conn = connectedBooks(book, books).slice(0, 8);
      el.createDiv({ cls: 'itm-section-label', text: 'Connected books' });
      if (!conn.length) {
        el.createDiv({ cls: 'itm-empty', text: book.topics.length ? 'No other books share these topics yet.' : 'Add topics to see connected books.' });
        return;
      }
      this.rows(el, conn.map((x) => x.book), today, (b) => {
        const c = conn.find((x) => x.book === b);
        return [c.related ? 'related' : '', ...c.shared].filter(Boolean).join(' · ');
      });
      return;
    }

    if (show === 'suggestions') {
      const sugg = suggestionsFor(books, s, today);
      el.createDiv({ cls: 'itm-section-label', text: 'Pick one of these up next' });
      if (!sugg.length) { el.createDiv({ cls: 'itm-empty', text: 'Everything has been touched recently. Nice.' }); return; }
      this.rows(el, sugg, today);
      return;
    }

    if (show === 'topics') {
      const paths = p.getTopicPaths();
      const names = p.getTopicNames();
      if (!names.length) { el.createDiv({ cls: 'itm-empty', text: 'No topics yet.' }); return; }
      const chips = el.createDiv({ cls: 'itm-chips' });
      for (const name of names) {
        const tagged = books.filter((b) => b.topics.includes(name));
        const reading = tagged.filter((b) => b.status === 'reading').length;
        const a = chips.createEl('a', { cls: 'itm-chip internal-link', text: `${name} ${reading}/${tagged.length}`, href: paths[name] || name, attr: { 'data-href': paths[name] || name, title: `${reading} reading, ${tagged.length} total` } });
        a.addEventListener('click', (e) => { e.preventDefault(); p.app.workspace.openLinkText(paths[name] || name, this.sourcePath, false); });
      }
      return;
    }

    const status = normStatus(show);
    if (['reading', 'queue', 'queued', 'finished', 'set aside', 'set-aside', 'stale'].includes(show)) {
      let list = show === 'stale'
        ? books.filter((b) => b.status === 'reading' && stateOf(ageOf(b, today), s) === 'stale')
        : books.filter((b) => b.status === status);
      list = list.sort(status === 'reading' ? byStaleness(today) : byTitle);
      if (!list.length) { el.createDiv({ cls: 'itm-empty', text: 'Nothing here yet.' }); return; }
      this.rows(el, list, today);
      return;
    }
    el.createDiv({ cls: 'itm-empty', text: 'in-the-margins: use show: topic, topics, connected, suggestions, reading, queue, stale, finished or set aside.' });
  }

  rows(el, list, today, note) {
    const s = this.plugin.settings;
    const wrap = el.createDiv({ cls: 'itm-rows' });
    for (const b of list) {
      const age = ageOf(b, today);
      const state = b.status === 'reading' ? stateOf(age, s) : b.status === 'queued' ? 'queued' : 'closed';
      const row = wrap.createDiv({ cls: `itm-row itm-${state}` });
      renderCover(row, b, 'itm-cover-xs');
      const body = row.createDiv({ cls: 'itm-row-body' });
      const a = body.createEl('a', { cls: 'itm-title internal-link', text: b.title, href: b.path, attr: { 'data-href': b.path } });
      a.addEventListener('click', (e) => { e.preventDefault(); openBookLink(this.plugin, b, this.sourcePath, e); });
      const sub = [b.author];
      if (note) sub.push(note(b));
      body.createDiv({ cls: 'itm-author', text: sub.filter(Boolean).join(' — ') });
      if (b.status === 'reading') {
        row.createSpan({ cls: `itm-badge itm-badge-${state} itm-badge-inline`, text: state === 'fresh' ? ageLabel(age) : (age == null ? 'new' : `${age}d`) });
        const t = row.createEl('button', { cls: 'itm-touch', text: age === 0 ? '✓' : 'Touched' });
        t.addEventListener('click', () => { if (age !== 0) { t.setText('✓'); this.plugin.touch(b); } });
      } else if (b.status === 'queued') {
        const st = row.createEl('button', { cls: 'itm-touch', text: 'Start' });
        st.addEventListener('click', () => { st.setText('✓'); this.plugin.startReading(b); });
      } else if (b.ended) {
        row.createSpan({ cls: 'itm-ended', text: `${STATUS_LABEL[b.status]} ${shortDate(b.ended)}` });
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Modals                                                             */
/* ------------------------------------------------------------------ */

async function searchOpenLibrary(title, author) {
  const fields = 'key,title,author_name,cover_i,first_publish_year';
  const go = async (withAuthor) => {
    const q = new URLSearchParams({ title, limit: '12', fields });
    if (withAuthor && author) q.set('author', author);
    const res = await requestUrl({ url: `https://openlibrary.org/search.json?${q}` });
    return (res.json.docs || []).filter((d) => d.cover_i);
  };
  let docs = await go(true);
  if (!docs.length && author) docs = await go(false);
  return docs.map((d) => ({
    title: d.title,
    author: (d.author_name || []).join(', '),
    year: d.first_publish_year,
    thumb: `https://covers.openlibrary.org/b/id/${d.cover_i}-S.jpg`,
    cover: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
  }));
}

/** Renders a cover search UI into `el`. Calls onPick(result) when a cover is chosen. */
function coverPicker(el, getQuery, onPick) {
  const status = el.createDiv({ cls: 'itm-cover-status' });
  const results = el.createDiv({ cls: 'itm-cover-results' });
  return async () => {
    const { title, author } = getQuery();
    if (!title) { status.setText('Enter a title first.'); return; }
    status.setText('Searching Open Library…');
    results.empty();
    try {
      const found = await searchOpenLibrary(title, author);
      if (!found.length) { status.setText('No covers found. You can paste a cover image URL instead.'); return; }
      status.setText('Tap the right cover.');
      for (const r of found) {
        const b = results.createEl('button', { cls: 'itm-cover-option', attr: { title: `${r.title}${r.author ? ` — ${r.author}` : ''}${r.year ? ` (${r.year})` : ''}` } });
        b.createEl('img', { attr: { src: r.cover, alt: r.title, loading: 'lazy' } });
        b.addEventListener('click', () => {
          results.querySelectorAll('.itm-cover-option').forEach((x) => x.removeClass('is-picked'));
          b.addClass('is-picked');
          onPick(r);
        });
      }
    } catch (e) {
      status.setText("Couldn't reach Open Library. Check your connection, or paste a cover URL.");
    }
  };
}

class AddBookModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.data = { title: '', author: '', cover: '', link: '', topics: [], useful: 0, started: todayStr(), status: 'reading' };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('itm-modal');
    this.titleEl.setText('Add a book');
    const d = this.data;
    let coverInput, authorInput, startedSetting;

    const seg = contentEl.createDiv({ cls: 'itm-segment' });
    const drawSeg = () => {
      seg.empty();
      for (const [st, label] of [['reading', 'Reading now'], ['queued', 'Queue for later']]) {
        const b = seg.createEl('button', { cls: d.status === st ? 'is-active mod-cta' : '', text: label });
        b.addEventListener('click', () => { d.status = st; drawSeg(); });
      }
      if (startedSetting) startedSetting.settingEl.toggleClass('itm-hidden', d.status === 'queued');
    };
    drawSeg();

    new Setting(contentEl).setName('Title').addText((t) => {
      t.setPlaceholder('Required').onChange((v) => { d.title = v.trim(); });
      window.setTimeout(() => t.inputEl.focus(), 50);
    });
    new Setting(contentEl).setName('Author').addText((t) => { authorInput = t; t.onChange((v) => { d.author = v.trim(); }); });
    new Setting(contentEl).setName('Link').setDesc('Optional. A Bookpile, Goodreads or StoryGraph page, for sharing later.')
      .addText((t) => t.setPlaceholder('https://…').onChange((v) => { d.link = v.trim(); }));
    startedSetting = new Setting(contentEl).setName('Started').setDesc('When you picked it up. Defaults to today.')
      .addText((t) => {
        t.inputEl.type = 'date';
        t.setValue(d.started).onChange((v) => { d.started = toDateStr(v) || todayStr(); });
      });

    // Topics
    const topicSetting = new Setting(contentEl).setName('Topics');
    topicSetting.settingEl.addClass('itm-setting-block');
    const chips = contentEl.createDiv({ cls: 'itm-chips itm-topic-pick' });
    const drawChips = () => {
      chips.empty();
      for (const t of this.plugin.getTopicNames()) {
        const c = chips.createEl('button', { cls: `itm-chip ${d.topics.includes(t) ? 'is-active' : ''}`, text: t });
        c.addEventListener('click', () => {
          d.topics = d.topics.includes(t) ? d.topics.filter((x) => x !== t) : [...d.topics, t];
          drawChips();
        });
      }
      const add = chips.createEl('button', { cls: 'itm-chip itm-chip-add', text: '+ New topic' });
      add.addEventListener('click', () => new PromptModal(this.app, 'New topic', '', async (v) => {
        if (!v.trim()) return;
        const name = await this.plugin.ensureTopicNote(v.trim());
        if (!d.topics.includes(name)) d.topics.push(name);
        drawChips();
      }).open());
    };
    drawChips();

    const usefulSetting = new Setting(contentEl).setName('Useful so far').setDesc('Optional. You can set this any time.');
    const usefulHolder = usefulSetting.controlEl.createDiv();
    const drawUseful = () => {
      usefulHolder.empty();
      renderUseful(usefulHolder, this.plugin, { useful: d.useful }, { onPick: (n) => { d.useful = n; drawUseful(); } });
    };
    drawUseful();

    // Cover
    const coverSetting = new Setting(contentEl).setName('Cover');
    coverSetting.addText((t) => { coverInput = t; t.setPlaceholder('Image URL, or find one →').onChange((v) => { d.cover = v.trim(); }); });
    const pickerEl = contentEl.createDiv({ cls: 'itm-cover-picker' });
    const search = coverPicker(pickerEl, () => d, (r) => {
      d.cover = r.cover;
      coverInput.setValue(r.cover);
      if (!d.author && r.author) { d.author = r.author; authorInput.setValue(r.author); }
    });
    coverSetting.addButton((b) => b.setButtonText('Find cover').onClick(search));

    contentEl.createDiv({ cls: 'itm-section-label', text: WHY_HEADING });
    const whyTa = contentEl.createEl('textarea', { cls: 'itm-thoughts itm-why-input', attr: { rows: '3', placeholder: `${WHY_PROMPT} (Optional)` } });
    whyTa.addEventListener('input', () => { d.why = whyTa.value; });

    new Setting(contentEl).addButton((b) => b.setButtonText('Add book').setCta().onClick(async () => {
      if (!d.title) { new Notice('A title is the one thing I need'); return; }
      await this.plugin.createBook(d);
      new Notice(d.status === 'queued' ? `Queued ${d.title}` : `Added ${d.title} to the pile`);
      this.close();
    }));
  }

  onClose() { this.contentEl.empty(); }
}

class WhyModal extends Modal {
  constructor(plugin, book) { super(plugin.app); this.plugin = plugin; this.book = book; }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('itm-modal');
    this.titleEl.setText(`Why ${this.book.title}?`);
    contentEl.createEl('p', { cls: 'itm-hint', text: WHY_PROMPT });
    const ta = contentEl.createEl('textarea', { cls: 'itm-thoughts', attr: { rows: '5' } });
    this.plugin.readWhy(this.book).then((w) => { if (w && !ta.value) ta.value = w; });
    window.setTimeout(() => ta.focus(), 50);
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Skip').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
        await this.plugin.saveWhy(this.book, ta.value);
        this.close();
      }));
  }
  onClose() { this.contentEl.empty(); }
}

class CoverModal extends Modal {
  constructor(plugin, book) { super(plugin.app); this.plugin = plugin; this.book = book; }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('itm-modal');
    this.titleEl.setText(`Cover for ${this.book.title}`);
    const q = { title: this.book.title, author: this.book.author };
    let picked = null;
    new Setting(contentEl).setName('Search title').addText((t) => t.setValue(q.title).onChange((v) => { q.title = v.trim(); }));
    new Setting(contentEl).setName('Search author').addText((t) => t.setValue(q.author).onChange((v) => { q.author = v.trim(); }));
    let urlInput;
    const s = new Setting(contentEl).setName('Or paste an image URL').addText((t) => { urlInput = t; t.setValue(this.book.cover); });
    const pickerEl = contentEl.createDiv({ cls: 'itm-cover-picker' });
    const search = coverPicker(pickerEl, () => q, (r) => { picked = r.cover; urlInput.setValue(r.cover); });
    s.addButton((b) => b.setButtonText('Find cover').onClick(search));
    new Setting(contentEl).addButton((b) => b.setButtonText('Save cover').setCta().onClick(async () => {
      const url = (urlInput.getValue() || picked || '').trim();
      await this.plugin.app.fileManager.processFrontMatter(this.book.file, (fm) => { fm.cover = url; });
      this.close();
    }));
    search();
  }
  onClose() { this.contentEl.empty(); }
}

class CloseBookModal extends Modal {
  constructor(plugin, book) {
    super(plugin.app);
    this.plugin = plugin;
    this.book = book;
    this.status = book.status === 'queued' ? 'set aside' : 'finished';
    this.useful = book.useful;
    this.thoughts = '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('itm-modal');
    this.titleEl.setText(`Closing out ${this.book.title}`);

    const seg = contentEl.createDiv({ cls: 'itm-segment' });
    const drawSeg = () => {
      seg.empty();
      for (const st of ['finished', 'set aside']) {
        const b = seg.createEl('button', { cls: this.status === st ? 'is-active mod-cta' : '', text: STATUS_LABEL[st] });
        b.addEventListener('click', () => { this.status = st; drawSeg(); });
      }
    };
    drawSeg();

    const us = new Setting(contentEl).setName('How useful was it?');
    const holder = us.controlEl.createDiv();
    const drawUseful = () => {
      holder.empty();
      renderUseful(holder, this.plugin, { useful: this.useful }, { onPick: (n) => { this.useful = n; drawUseful(); } });
    };
    drawUseful();

    contentEl.createDiv({ cls: 'itm-section-label', text: 'Final thoughts' });
    const ta = contentEl.createEl('textarea', { cls: 'itm-thoughts', attr: { rows: '6', placeholder: 'What stuck with you? What will you carry forward? (Optional)' } });
    ta.addEventListener('input', () => { this.thoughts = ta.value; });
    window.setTimeout(() => ta.focus(), 50);

    new Setting(contentEl).addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
      await this.plugin.closeBook(this.book, this.status, this.useful, this.thoughts);
      this.close();
    }));
  }

  onClose() { this.contentEl.empty(); }
}

class PromptModal extends Modal {
  constructor(app, title, value, onSubmit) { super(app); this.titleText = title; this.value = value || ''; this.onSubmit = onSubmit; }
  onOpen() {
    this.titleEl.setText(this.titleText);
    let input;
    const submit = () => { const v = input.getValue(); this.close(); this.onSubmit(v); };
    new Setting(this.contentEl).addText((t) => {
      input = t;
      t.setValue(this.value);
      t.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 50);
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('OK').setCta().onClick(submit));
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmModal extends Modal {
  constructor(app, title, body, onYes) { super(app); this.t = title; this.b = body; this.onYes = onYes; }
  onOpen() {
    this.titleEl.setText(this.t);
    this.contentEl.createEl('p', { text: this.b });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) => b.setButtonText('Delete').setWarning().onClick(() => { this.close(); this.onYes(); }));
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

class PileSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    const num = (name, desc, key, min) => new Setting(containerEl).setName(name).setDesc(desc).addText((t) => t.setValue(String(s[key])).onChange(async (v) => {
      const n = parseInt(v, 10);
      if (n >= min) { s[key] = n; await save(); }
    }));
    num('Stale after (days)', 'A book you haven\'t touched in this many days gets flagged.', 'staleDays', 1);
    num('Warn this many days before', 'Books this close to going stale show up as suggestions.', 'warnDays', 0);
    num('Suggestions to show', 'How many "pick one up" books to show at the top of the pile.', 'suggestionCount', 1);
    new Setting(containerEl).setName('Open the pile when the vault opens').addToggle((t) => t.setValue(s.openOnStartup).onChange(async (v) => { s.openOnStartup = v; await save(); }));
    new Setting(containerEl).setName('Folders').setHeading();
    const folder = (name, key) => new Setting(containerEl).setName(name).addText((t) => t.setValue(s[key]).onChange(async (v) => { s[key] = v.trim() || DEFAULT_SETTINGS[key]; await save(); }));
    folder('Books', 'booksFolder');
    folder('Topics', 'topicsFolder');
    folder('Exports', 'exportsFolder');
    folder('Maps', 'mapsFolder');
    new Setting(containerEl).setName('Exports').setHeading();
    new Setting(containerEl).setName('Reset "since last export"')
      .setDesc(s.lastExportDate ? `Last export: ${niceDate(s.lastExportDate)}. Resetting makes the next export include every finished and set-aside book again.` : 'No export yet.')
      .addButton((b) => b.setButtonText('Reset').onClick(async () => { s.lastExportDate = ''; s.exportedKeys = []; await save(); this.display(); }));
  }
}

module.exports = InTheMarginsPlugin;
module.exports.default = InTheMarginsPlugin;
module.exports.helpers = {
  todayStr, toDateStr, daysBetween, stripLink, toList, normStatus, normUseful, bookFromFrontmatter,
  ageOf, stateOf, ageLabel, suggestionsFor, connectedBooks, extractFinalThoughts, appendFinalThoughts, cleanThoughts, getWhy, setWhy,
  safeFileName, buildBookNote, buildTopicNote, exportInProgress, exportSinceLast, exportYear, buildYearReport, renderReportMarkdown,
  exportAllMarkdown, exportAllCsv, buildCanvas, DEFAULT_SETTINGS,
};
