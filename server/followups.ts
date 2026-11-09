// Post-meeting workflows: the follow-up email, calendar invites (.ics) and
// visual artifacts (Mermaid diagram, interactive page, slide deck) built from one note.
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_DIR } from './env.ts';
import { get, getSetting, parseMeeting, transcriptText } from './db.ts';
import { completeLLM } from './llm.ts';
import { DIAGRAM_SYSTEM, followupEmailSystem, htmlArtifactSystem, type Brand } from './prompts.ts';

export function getBrand(): Brand {
  const b = getSetting<Partial<Brand>>('brand', {});
  return {
    company: b.company || '',
    primary: b.primary || '#5b6f00',
    accent: b.accent || '#788c15',
    background: b.background || '#fcfcf8',
    text: b.text || '#292929',
    font: b.font === 'serif' ? 'serif' : 'sans',
  };
}

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

/** Diagram: returns the Mermaid code; the UI renders it locally (no CDN) and can export it. */
export async function generateDiagram(meetingId: string) {
  const { m, context } = meetingContext(meetingId, 40_000);
  const raw = await completeLLM({ kind: 'notes', system: DIAGRAM_SYSTEM, messages: [{ role: 'user', content: clip(context, 80_000) }], maxTokens: 1800 });
  const code = raw.replace(/^```(?:mermaid)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!code) throw new Error('El modelo no devolvió un diagrama. Prueba otra vez o con otro modelo.');
  return { title: m.title || 'Reunión', mermaid: code };
}

/** Saves the already-rendered diagram (inline SVG, no external dependencies) plus the .svg itself. */
export function saveDiagramHtml(opts: { title: string; svg: string; mermaid?: string }) {
  if (!opts.svg?.trim().startsWith('<svg')) throw new Error('Falta el SVG del diagrama');
  const b = getBrand();
  const esc = (s: string) => s.replace(/</g, '&lt;');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title>
<style>body{margin:0;background:${b.background};color:${b.text};font:15px/1.5 ${b.font === 'serif' ? 'Georgia,serif' : '-apple-system,BlinkMacSystemFont,sans-serif'};display:flex;flex-direction:column;align-items:center;padding:28px 16px}
h1{font-size:22px;margin:0 0 4px;color:${b.primary}}.c{font-size:12px;color:${b.accent};margin:0 0 18px}.d{max-width:1200px;width:100%;overflow:auto;display:flex;justify-content:center}svg{max-width:100%;height:auto}</style></head>
<body><h1>${esc(opts.title)}</h1>${b.company ? `<p class="c">${esc(b.company)}</p>` : ''}<div class="d">${opts.svg}</div>
${opts.mermaid ? `<!-- mermaid:\n${opts.mermaid.replace(/--/g, '—')}\n-->` : ''}</body></html>`;
  const base = `diagrama-${slug(opts.title)}-${Date.now()}`;
  const file = path.join(EXPORT_DIR, `${base}.html`);
  fs.writeFileSync(file, html);
  const svgFile = path.join(EXPORT_DIR, `${base}.svg`);
  fs.writeFileSync(svgFile, opts.svg);
  return { file, svgFile };
}

export async function generateArtifact(meetingId: string, kind: 'page' | 'slides') {
  const { m, context } = meetingContext(meetingId, 60_000);
  const title = m.title || 'Reunión';
  const raw = await completeLLM({ kind: 'notes', system: htmlArtifactSystem(kind, getSetting('userName', ''), getBrand()), messages: [{ role: 'user', content: clip(context, 100_000) }], maxTokens: 8000 });
  const match = raw.match(/<!doctype[\s\S]*<\/html>/i) || raw.match(/<html[\s\S]*<\/html>/i);
  if (!match) throw new Error('El modelo no devolvió una página completa. Prueba otra vez o con otro modelo.');
  const file = path.join(EXPORT_DIR, `${kind === 'slides' ? 'presentacion' : 'pagina'}-${slug(title)}-${Date.now()}.html`);
  fs.writeFileSync(file, match[0]);
  return { file };
}
