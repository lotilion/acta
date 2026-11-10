// Meeting detection: the native helper reports mic usage and meeting apps/windows;
// the calendar watcher reports events that are about to start. With autoRecord on,
// a detected call starts the recording by itself, linked to the calendar event.
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { HELPER_BIN } from './env.ts';
import { get, getSetting } from './db.ts';
import { bus, activeSession, helperAvailable, startRecording, stopRecording } from './recorder.ts';
import { upcomingEvents, type CalEvent } from './calendar.ts';
import { createMeeting } from './meetings.ts';

export type DetectorState = {
  running: boolean;
  micInUse: boolean;
  meetings: { app: string; bundleId: string; title: string }[];
  lastUpdate: number;
  permissions: Record<string, any>;
};

export const detectorState: DetectorState = { running: false, micInUse: false, meetings: [], lastUpdate: 0, permissions: {} };
let child: ChildProcess | null = null;
const notified = new Map<string, number>();
let meetingGoneSince = 0;
let nearEvents: CalEvent[] = []; // refreshed by the calendar watcher, read synchronously here
let wasEligible = false; // auto-record fires on the no-call -> call edge
let suppressed = false; // the user stopped while the call window was still there: don't restart
let autoStarting = false;

// A recording stopped (by the user or by silence) while the call is still on screen:
// don't start it again until this call is over.
bus.on('event', (e: any) => {
  if (e?.type === 'recording.stopped' && detectorState.meetings.length) suppressed = true;
});

/** The calendar event happening right now (or starting within 6 minutes), if any. */
function matchEventNow(): CalEvent | undefined {
  const t = Date.now();
  return nearEvents
    .filter((ev) => ev.start - 6 * 60_000 <= t && ev.end > t)
    .sort((a, b) => Math.abs(t - a.start) - Math.abs(t - b.start))[0];
}

async function autoStart(m: DetectorState['meetings'][0], ev: CalEvent | undefined) {
  autoStarting = true;
  try {
    const title = ev?.title || (m.title && !/^Zoom Meeting$/i.test(m.title) ? m.title : `Reunión de ${m.app}`);
    const { id } = createMeeting(ev ? { calendarEvent: ev, source: 'live' } : { title, source: 'live' });
    const session = await startRecording(id);
    session.helperInfo.detectedApp = m.app;
    bus.emit('event', { type: 'recording.autostarted', meetingId: id, title: ev?.title || title, app: m.app });
  } catch (e: any) {
    console.warn('[autorecord]', e?.message || e);
  } finally {
    autoStarting = false;
  }
}

function notifyOnce(key: string, cooldownMs: number, event: any) {
  const last = notified.get(key) || 0;
  if (Date.now() - last < cooldownMs) return;
  notified.set(key, Date.now());
  bus.emit('event', event);
}

export function startDetector() {
  const supported = process.platform === 'darwin' || process.platform === 'win32';
  if (child || !supported || !fs.existsSync(HELPER_BIN)) return;
  child = spawn(HELPER_BIN, ['detect', '--interval', '2'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  detectorState.running = true;
  let buf = '';
  child.stdout!.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { onReading(JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  child.stderr!.on('data', (d) => console.warn('[detector]', String(d).trim()));
  child.on('exit', () => {
    child = null;
    detectorState.running = false;
    setTimeout(startDetector, 10_000);
  });
}

function onReading(r: { micInUse: boolean; meetings: DetectorState['meetings']; permissions?: any }) {
  detectorState.micInUse = r.micInUse;
  detectorState.meetings = r.meetings || [];
  detectorState.lastUpdate = Date.now();
  if (r.permissions) detectorState.permissions = r.permissions;
  bus.emit('event', { type: 'detector', micInUse: r.micInUse, meetings: detectorState.meetings });

  const session = activeSession();
  if (!detectorState.meetings.length) suppressed = false;
  if (!session) {
    meetingGoneSince = 0;
    const m = detectorState.meetings[0];
    // On Windows a recognized call window is enough. WASAPI sometimes hides the mic session.
    const heard = process.platform === 'win32' ? true : r.micInUse;
    const eligible = !!m && heard && getSetting('autoDetect', true);
    if (eligible) {
      const ev = matchEventNow();
      if (getSetting('autoRecord', false)) {
        if (!wasEligible && !suppressed && !autoStarting) {
          // The server can only capture through the native helper (macOS). On Windows the
          // capture lives in the renderer, so the UI starts the recording when it gets the event.
          if (process.platform === 'darwin' && helperAvailable()) void autoStart(m, ev);
          else bus.emit('event', { type: 'meeting.detected', app: m.app, title: m.title, bundleId: m.bundleId, event: ev || null, autostart: true });
        }
      } else {
        notifyOnce(`app:${m.bundleId}:${m.title}`, 20 * 60_000, { type: 'meeting.detected', app: m.app, title: m.title, bundleId: m.bundleId, event: ev || null });
      }
    }
    wasEligible = eligible;
    return;
  }
  wasEligible = true;
  // Auto-stop when the call window disappears for a while.
  if (!getSetting('autoStopOnMeetingEnd', true)) return;
  if (session.helperInfo.detectedApp && !detectorState.meetings.length) {
    if (!meetingGoneSince) meetingGoneSince = Date.now();
    if (Date.now() - meetingGoneSince > 60_000) {
      bus.emit('event', { type: 'recording.autostop', meetingId: session.meetingId, reason: 'La llamada ha terminado' });
      void stopRecording('meeting-ended');
      meetingGoneSince = 0;
    }
  } else {
    meetingGoneSince = 0;
    if (detectorState.meetings.length) session.helperInfo.detectedApp = detectorState.meetings[0].app;
  }
}

export function startCalendarWatcher() {
  const tick = async () => {
    const minutes = getSetting('calendarNotifyMinutes', 1);
    try {
      const events = await upcomingEvents({ fromMs: Date.now() - 15 * 60_000, toMs: Date.now() + Math.max(minutes + 1, 15) * 60_000 });
      nearEvents = events;
      if (minutes < 0) return;
      for (const ev of events) {
        const delta = ev.start - Date.now();
        if (delta <= minutes * 60_000 && delta > -5 * 60_000 && !activeSession()) {
          notifyOnce(`cal:${ev.id}`, 24 * 3600_000, { type: 'calendar.starting', event: ev });
        }
      }
    } catch { /* calendar errors surface in the UI */ }
    stopAfterCalendarEnd();
  };
  setInterval(tick, 30_000);
  setTimeout(tick, 3000);
}

// Safety net for calls the window detector misses (e.g. an unrecognized browser tab):
// when the note is linked to a calendar event and the event ended a while ago, stop.
const CALENDAR_END_GRACE_MS = 10 * 60_000;
function stopAfterCalendarEnd() {
  const session = activeSession();
  if (!session || session.paused) return;
  if (!getSetting('autoStopOnMeetingEnd', true)) return;
  if (detectorState.meetings.length) return; // a recognized call is still on screen
  const m = get('SELECT calendar_end FROM meetings WHERE id = ?', session.meetingId);
  if (!m?.calendar_end || Date.now() - m.calendar_end < CALENDAR_END_GRACE_MS) return;
  if (Date.now() - session.lastActivity < 2 * 60_000) return; // someone is still talking: the meeting ran over
  bus.emit('event', { type: 'recording.autostop', meetingId: session.meetingId, reason: 'La reunión del calendario terminó hace 10 minutos' });
  void stopRecording('meeting-ended');
}

export function stopDetector() {
  child?.kill();
}
