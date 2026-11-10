// Creating meetings and linking attendees, shared by the API and the detector
// (auto-record creates notes server-side, with no UI involved).
import { get, getSetting, now, reindexMeeting, run, uid } from './db.ts';
import { bus } from './recorder.ts';
import type { CalEvent } from './calendar.ts';

const FREE_DOMAINS = /^(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|proton|protonmail|msn|aol)\./i;

export function linkAttendees(meetingId: string, attendees: { name?: string; email?: string; self?: boolean }[]) {
  const selfEmails = getSetting<string[]>('selfEmails', []).map((e) => e.toLowerCase());
  for (const a of attendees) {
    const email = (a.email || '').toLowerCase().trim();
    if (a.self || (email && selfEmails.includes(email))) continue;
    let person = email ? get('SELECT * FROM people WHERE email = ?', email) : a.name ? get('SELECT * FROM people WHERE lower(name) = lower(?)', a.name) : undefined;
    if (!person) {
      let companyId: string | null = null;
      const domain = email.split('@')[1];
      if (domain && !FREE_DOMAINS.test(domain)) {
        let c = get('SELECT * FROM companies WHERE domain = ?', domain);
        if (!c) {
          const name = domain.split('.').slice(-2, -1)[0] || domain;
          run('INSERT INTO companies(id, name, domain, created_at) VALUES (?, ?, ?, ?)', uid('co_'), name.charAt(0).toUpperCase() + name.slice(1), domain, now());
          c = get('SELECT * FROM companies WHERE domain = ?', domain);
        }
        companyId = c!.id;
      }
      const id = uid('pe_');
      run('INSERT INTO people(id, name, email, company_id, created_at) VALUES (?, ?, ?, ?, ?)', id, a.name || email.split('@')[0] || 'Sin nombre', email || null, companyId, now());
      person = { id };
    }
    run('INSERT OR IGNORE INTO meeting_people(meeting_id, person_id) VALUES (?, ?)', meetingId, person.id);
  }
}

export type CreateMeetingOpts = {
  title?: string;
  calendarEvent?: CalEvent | null;
  attendees?: { name?: string; email?: string; self?: boolean }[];
  folderId?: string | null;
  templateId?: string | null;
  source?: string;
};

/** Create a note; an active note already linked to the same calendar event is reused. */
export function createMeeting(opts: CreateMeetingOpts = {}): { id: string; existing: boolean } {
  const ev = opts.calendarEvent || undefined;
  if (ev) {
    const existing = get('SELECT id FROM meetings WHERE calendar_event_id = ? AND archived_at IS NULL', ev.id);
    if (existing) return { id: existing.id, existing: true };
  }
  const id = uid('mt_');
  const t = now();
  const attendees = ev?.attendees || opts.attendees || [];
  run(
    `INSERT INTO meetings(id, title, created_at, updated_at, calendar_event_id, calendar_start, calendar_end, attendees, folder_id, template_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, opts.title ?? ev?.title ?? '', t, t, ev?.id || null, ev?.start || null, ev?.end || null, JSON.stringify(attendees), opts.folderId || null, opts.templateId || null, opts.source || 'live',
  );
  linkAttendees(id, attendees);
  reindexMeeting(id);
  bus.emit('event', { type: 'meetings.changed' });
  return { id, existing: false };
}
