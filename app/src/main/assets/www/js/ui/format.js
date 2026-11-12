// Small formatting and markup helpers shared by the screens.

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export const px = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(2));

export const signed = (v) =>
  v == null || !Number.isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);

const two = (n) => String(n).padStart(2, '0');

export function clock(t) {
  const d = new Date(t * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function dateTime(t) {
  const d = new Date(t * 1000);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${mon} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function ago(t, now) {
  const s = Math.max(0, now - t);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / (86400 * 30))}mo ago`;
}

export function duration(sec) {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${two(m)}m`;
  return `${Math.max(1, m)}m`;
}

export function meter(n) {
  let bars = '';
  for (let i = 1; i <= 5; i++) bars += `<i${i <= n ? ' class="f"' : ''}></i>`;
  return `<span class="meter" role="img" aria-label="Strength ${n} of 5">${bars}</span>`;
}

const ARROW = {
  bull: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l4.5 8h-9z"/></svg>',
  bear: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 9L.5 1h9z"/></svg>',
  neutral: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 .5L9.5 5 5 9.5.5 5z"/></svg>',
};
const BIAS_LABEL = { bull: 'Bullish', bear: 'Bearish', neutral: 'Mixed' };

export function biasCell(bias) {
  return `<span class="bias ${bias}">${ARROW[bias]}${BIAS_LABEL[bias]}</span>`;
}

const ROLE = {
  resistance: { cls: 'r', letter: 'R', name: 'Resistance' },
  support: { cls: 's', letter: 'S', name: 'Support' },
  inside: { cls: 'at', letter: '=', name: 'At price' },
};

export function roleBadge(role) {
  const r = ROLE[role];
  return `<span class="badge ${r.cls}" role="img" aria-label="${r.name}">${r.letter}</span>`;
}

export const TF_NAME = { M5: 'M5', M15: 'M15', M30: 'M30', H1: 'H1', H4: 'H4', D1: 'D1', W1: 'W1' };

// Plain-language names for the tags shown on confluence areas.
export function tagTitle(tag) {
  if (/^\d+$/.test(tag)) return `Round number ${tag}`;
  const prev = /^P([DWM])([HL])$/.exec(tag);
  const period = { D: 'day', W: 'week', M: 'month' };
  if (prev) return `Previous ${period[prev[1]]} ${prev[2] === 'H' ? 'high' : 'low'}`;
  const piv = /^([DWM])-(PP|[RS][123])$/.exec(tag);
  if (piv) return `${{ D: 'Daily', W: 'Weekly', M: 'Monthly' }[piv[1]]} pivot ${piv[2]}`;
  return `${tag} swing zone`;
}

export function tagChips(tags, max = 6) {
  const shown = tags.slice(0, max);
  const more = tags.length - shown.length;
  return (
    '<div class="tags">' +
    shown.map((t) => `<span class="tag" title="${esc(tagTitle(t))}">${esc(t)}</span>`).join('') +
    (more > 0 ? `<span class="tag">+${more}</span>` : '') +
    '</div>'
  );
}
