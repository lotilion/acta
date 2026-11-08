import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Search, X } from 'lucide-react';
import { api, fmtClock, type Segment } from '../api';
import { useApp } from '../store';
import { Button, IconButton, Input, Modal, cx, toast } from './ui';

const SPEAKER_HUES = ['#7c8a3f', '#3f6f8a', '#8a5a3f', '#6f3f8a', '#8a3f55', '#3f8a6e'];
function speakerColor(name: string) {
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % SPEAKER_HUES.length;
  return SPEAKER_HUES[h];
}

export function TranscriptPanel({ meetingId, segments, onClose }: { meetingId: string; segments: Segment[]; onClose: () => void }) {
  const { live, state } = useApp();
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [rename, setRename] = useState<{ from: string; value: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const isLive = live?.meetingId === meetingId;
  const me = state?.userName || 'Yo';

  const shown = useMemo(() => (q.trim() ? segments.filter((s) => s.text.toLowerCase().includes(q.toLowerCase())) : segments), [segments, q]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, live?.speaking.me, live?.speaking.them]);

  const label = (sp: string) => (sp === 'me' ? me : sp === 'them' ? 'Ellos' : sp);
  const copy = () => {
    const txt = segments.map((s) => `[${fmtClock(s.start_ms)}] ${label(s.speaker)}: ${s.text}`).join('\n');
    void navigator.clipboard.writeText(txt).then(() => toast('Transcripción copiada'));
  };
  const saveRename = async () => {
    if (!rename) return;
    const to = rename.value.trim();
    if (!to || to === label(rename.from)) { setRename(null); return; }
    try {
      const r = await api.post<{ changed: number }>(`/api/meetings/${meetingId}/speakers/rename`, { from: rename.from, to });
      toast(`${r.changed} ${r.changed === 1 ? 'intervención renombrada' : 'intervenciones renombradas'}`);
    } catch (e: any) {
      toast(e.message, { tone: 'error' });
    }
    setRename(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-1 border-b border-hairline px-4">
        {searching ? (
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar en la transcripción" className="h-8 flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-4" />
        ) : (
          <div className="flex flex-1 items-center gap-2 text-[13.5px] font-medium">
            Transcripción
            {isLive && live?.status === 'recording' && <span className="h-1.5 w-1.5 rounded-full bg-accent pulse-dot" />}
          </div>
        )}
        <IconButton title="Buscar" onClick={() => { setSearching((s) => !s); setQ(''); }}><Search size={15} /></IconButton>
        <IconButton title="Copiar todo" onClick={copy} disabled={!segments.length}><Copy size={15} /></IconButton>
        <IconButton title="Cerrar" onClick={onClose}><X size={16} /></IconButton>
      </div>
      <div
        ref={scroller}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}
        className="flex-1 space-y-2.5 overflow-y-auto px-4 py-4"
      >
        {!segments.length && !isLive && <div className="py-10 text-center text-[13px] text-ink-4">Todavía no hay transcripción.</div>}
        {!segments.length && isLive && <div className="py-10 text-center text-[13px] text-ink-4">Escuchando… la transcripción aparecerá aquí en unos segundos.</div>}
        {shown.map((s, i) => {
          const mine = s.speaker === 'me';
          const prev = shown[i - 1];
          const showHead = !prev || prev.speaker !== s.speaker || s.start_ms - prev.end_ms > 60_000;
          return (
            <div key={s.id} className={cx('flex flex-col', mine ? 'items-end' : 'items-start')}>
              {showHead && (
                <button
                  onClick={() => !mine && setRename({ from: s.speaker, value: s.speaker === 'them' ? '' : s.speaker })}
                  title={mine ? undefined : 'Renombrar a esta persona en toda la transcripción'}
                  className={cx('mb-0.5 flex items-center gap-1.5 px-1 text-[11px] text-ink-4', !mine && 'cursor-pointer rounded hover:text-ink')}
                >
                  {!mine && <span className="h-1.5 w-1.5 rounded-full" style={{ background: speakerColor(s.speaker) }} />}
                  {label(s.speaker)} · {fmtClock(s.start_ms)}
                </button>
              )}
              <div className={cx('max-w-[88%] rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed', mine ? 'rounded-br-md bg-accent-wash text-ink' : 'rounded-bl-md bg-soft text-ink')}>
                {s.text}
              </div>
            </div>
          );
        })}
        {isLive && (live?.speaking.them || live?.speaking.me) && (
          <div className={cx('flex', live?.speaking.me && !live?.speaking.them ? 'justify-end' : 'justify-start')}>
            <div className="flex gap-1 rounded-2xl bg-soft px-3 py-2.5">
              {[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 rounded-full bg-ink-4 pulse-dot" style={{ animationDelay: `${i * 0.2}s` }} />)}
            </div>
          </div>
        )}
      </div>
      <Modal open={!!rename} onClose={() => setRename(null)} title={`¿Quién es «${rename ? label(rename.from) : ''}»?`} width={380}>
        <form className="p-5" onSubmit={(e) => { e.preventDefault(); void saveRename(); }}>
          <Input autoFocus value={rename?.value || ''} onChange={(e) => setRename((r) => (r ? { ...r, value: e.target.value } : r))} placeholder="Nombre de la persona" />
          <div className="mt-2 text-[12px] text-ink-4">Se aplica a todas sus intervenciones en esta nota.</div>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRename(null)}>Cancelar</Button>
            <Button type="submit" variant="primary">Renombrar</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
