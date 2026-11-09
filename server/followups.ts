// Post-meeting workflows: the follow-up email, calendar invites (.ics) and
// visual artifacts (Mermaid diagram, interactive page, slide deck) built from one note.
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_DIR } from './env.ts';
import { get, getSetting, parseMeeting, transcriptText } from './db.ts';
import { completeLLM } from './llm.ts';
import { DIAGRAM_SYSTEM, followupEmailSystem, htmlArtifactSystem } from './prompts.ts';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n[…recortado…]' : s);
const slug = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).toLowerCase() || 'reunion';

function meetingContext(meetingId: string, transcriptBudget = 60_000) {
  const m = parseMeeting(get('SELECT * FROM meetings WHERE id = ?', meetingId));
  if (!m) throw new Error('Nota no encontrada');
  const hasTranscript = !!get('SELECT 1 FROM segments WHERE meeting_id = ? LIMIT 1', meetingId);
  if (!hasTranscript && !(m.enhanced_md || '').trim() && !(m.notes_text || '').trim()) {
    throw new Error('La nota está vacía: graba la reunión o escribe algo antes de generar esto.');
  }
  const me = getSetting('userName', '') || 'Yo';
  const date = new Date(m.started_at || m.created_at).toLocaleString('es-ES', { dateStyle: 'full', timeStyle: 'short' });
  const context = `REUNIÓN: ${m.title || 'Sin título'}\nFECHA: ${date}\nASISTENTES: ${(m.attendees || []).map((a: any) => a.name || a.email).filter(Boolean).join(', ') || 'desconocidos'}\n\nNOTAS:\n${m.enhanced_md || m.notes_text || '(sin notas)'}\n\nTRANSCRIPT:\n${clip(transcriptText(meetingId, { me, them: 'Ellos' }), transcriptBudget)}`;
  return { m, context };
}

// ---------- follow-up email ----------
export async function followupEmail(meetingId: string) {
  const { m, context } = meetingContext(meetingId);
  const raw = await completeLLM({
    kind: 'chat',
    system: followupEmailSystem(getSetting('userName', '')),
    messages: [{ role: 'user', content: clip(context, 100_000) }],
    maxTokens: 1200,
  });
  let subject = `Seguimiento: ${m.title || 'nuestra reunión'}`;
  let body = raw.trim();
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (j.subject) subject = String(j.subject);
    if (j.body) body = String(j.body);
  } catch { /* use the raw text as body */ }
  const selfEmails = getSetting<string[]>('selfEmails', []).map((e) => e.toLowerCase());
  const to = (m.attendees || [])
    .filter((a: any) => a.email && !a.self && !selfEmails.includes(String(a.email).toLowerCase()))
    .map((a: any) => a.email);
  return { subject, body, to };
}

// ---------- .ics invites ----------
const icsEscape = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function makeIcs(opts: {
  title: string;
  startMs: number;
  endMs: number;
  description?: string;
  location?: string;
  attendees?: { name?: string; email: string }[];
}) {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@acta`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Acta//ES',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsDate(Date.now())}`,
    `DTSTART:${icsDate(opts.startMs)}`,
    `DTEND:${icsDate(opts.endMs)}`,
    `SUMMARY:${icsEscape(opts.title)}`,
    ...(opts.description ? [`DESCRIPTION:${icsEscape(opts.description.slice(0, 6000))}`] : []),
    ...(opts.location ? [`LOCATION:${icsEscape(opts.location)}`] : []),
    ...(opts.attendees || []).filter((a) => a.email).map((a) =>
      `ATTENDEE;CN=${icsEscape(a.name || a.email)};RSVP=TRUE:mailto:${a.email}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

export function writeIcs(meetingId: string, opts: Parameters<typeof makeIcs>[0]) {
  if (!opts.title?.trim()) throw new Error('La cita necesita un título');
  if (!opts.startMs || !opts.endMs || opts.endMs <= opts.startMs) throw new Error('Revisa la fecha y la duración');
  const file = path.join(EXPORT_DIR, `cita-${slug(opts.title)}-${Date.now()}.ics`);
  fs.writeFileSync(file, makeIcs(opts));
  return file;
}

// ---------- visual artifacts ----------
export type ArtifactKind = 'diagram' | 'page' | 'slides';

function mermaidPage(title: string, code: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/</g, '&lt;')}</title>
<style>body{margin:0;background:#fcfcf8;color:#292929;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;align-items:center;padding:28px 16px}
h1{font:500 22px/1.3 Georgia,serif;margin:0 0 18px}.d{max-width:1100px;width:100%;overflow:auto}pre{display:none}</style></head>
<body><h1>${title.replace(/</g, '&lt;')}</h1><div class="d"><pre class="mermaid">${code.replace(/</g, '&lt;')}</pre></div>
<script type="module">
try {
  const m = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
  document.querySelector('.mermaid').style.display = 'block';
  m.default.initialize({ startOnLoad: true, theme: 'neutral' });
} catch (e) {
  document.body.insertAdjacentHTML('beforeend', '<p>No se pudo cargar el renderizador (hace falta internet). El código del diagrama:</p><pre style="display:block;white-space:pre-wrap">' + document.querySelector('.mermaid').textContent.replace(/</g, '&lt;') + '</pre>');
}
</script></body></html>`;
}

export async function generateArtifact(meetingId: string, kind: ArtifactKind) {
  const { m, context } = meetingContext(meetingId, kind === 'diagram' ? 40_000 : 60_000);
  const title = m.title || 'Reunión';
  let html: string;
  if (kind === 'diagram') {
    const raw = await completeLLM({ kind: 'notes', system: DIAGRAM_SYSTEM, messages: [{ role: 'user', content: clip(context, 80_000) }], maxTokens: 1800 });
    const code = raw.replace(/^```(?:mermaid)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (!code) throw new Error('El modelo no devolvió un diagrama. Prueba otra vez o con otro modelo.');
    html = mermaidPage(title, code);
  } else {
    const raw = await completeLLM({ kind: 'notes', system: htmlArtifactSystem(kind, getSetting('userName', '')), messages: [{ role: 'user', content: clip(context, 100_000) }], maxTokens: 8000 });
    const match = raw.match(/<!doctype[\s\S]*<\/html>/i) || raw.match(/<html[\s\S]*<\/html>/i);
    if (!match) throw new Error('El modelo no devolvió una página completa. Prueba otra vez o con otro modelo.');
    html = match[0];
  }
  const names = { diagram: 'diagrama', page: 'pagina', slides: 'presentacion' } as const;
  const file = path.join(EXPORT_DIR, `${names[kind]}-${slug(title)}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  return { file };
}
