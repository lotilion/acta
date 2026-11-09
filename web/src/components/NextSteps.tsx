// "Siguientes pasos" after a meeting: one-click follow-up email, calendar invite
// (.ics) and visual artifacts (diagram, interactive page, slide deck).
import { useEffect, useState } from 'react';
import { CalendarPlus, LayoutDashboard, Mail, Presentation, Share2, Copy } from 'lucide-react';
import { api, type Meeting } from '../api';
import { Button, Input, Modal, Textarea, toast, cx } from './ui';

function toLocalInput(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function EmailModal({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
  const [busy, setBusy] = useState(true);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    api.post<{ subject: string; body: string; to: string[] }>(`/api/meetings/${meeting.id}/followup-email`)
      .then((r) => { setSubject(r.subject); setBody(r.body); setTo(r.to.join(', ')); })
      .catch((e) => toast(e.message, { tone: 'error' }))
      .finally(() => setBusy(false));
  }, [meeting.id]);

  const toList = to.split(/[,;\s]+/).filter(Boolean).join(',');
  const openMail = () => {
    const base = `mailto:${toList}?subject=${encodeURIComponent(subject)}`;
    if (encodeURIComponent(body).length > 1600) {
      void navigator.clipboard.writeText(body).then(() => toast('El email es largo: el cuerpo está copiado, pégalo en el mensaje.'));
      window.location.href = base;
    } else {
      window.location.href = `${base}&body=${encodeURIComponent(body)}`;
    }
  };
  const openGmail = () => window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(toList)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
  const copyAll = () => void navigator.clipboard.writeText(`Para: ${to}\nAsunto: ${subject}\n\n${body}`).then(() => toast('Email copiado'));

  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2"><Mail size={15} className="text-accent-ink" />Email de seguimiento</span>} width={640}>
      <div className="space-y-3 p-5">
        {busy ? (
          <div className="space-y-2 py-4">{[40, 90, 85, 70, 88, 50].map((w, i) => <div key={i} className="shimmer h-3.5 rounded" style={{ width: `${w}%` }} />)}</div>
        ) : (
          <>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Destinatarios (separados por comas)" />
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Asunto" />
            <Textarea rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" onClick={copyAll}><Copy size={13} />Copiar</Button>
              <Button variant="outline" onClick={openGmail}>Abrir en Gmail</Button>
              <Button variant="primary" onClick={openMail}><Mail size={13} />Abrir en Mail</Button>
            </div>
            <div className="text-[11.5px] text-ink-4">Se abre en tu app de correo con todo relleno: revisa y pulsa enviar. Acta no envía nada por sí sola.</div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function EventModal({ meeting, initial, onClose }: { meeting: Meeting; initial?: { title?: string; description?: string }; onClose: () => void }) {
  const tomorrow10 = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d.getTime(); })();
  const others = (meeting.attendees || []).filter((a) => a.email && !a.self);
  const [title, setTitle] = useState(initial?.title || `Seguimiento: ${meeting.title || 'reunión'}`);
  const [when, setWhen] = useState(toLocalInput(tomorrow10));
  const [duration, setDuration] = useState(30);
  const [invite, setInvite] = useState<Record<string, boolean>>({});
  const [description, setDescription] = useState(initial?.description ?? (meeting.summary ? `De la reunión «${meeting.title}»: ${meeting.summary}` : ''));
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await api.post(`/api/meetings/${meeting.id}/event-ics`, {
        title,
        startMs: new Date(when).getTime(),
        durationMin: duration,
        description,
        attendees: others.filter((a) => invite[a.email!]).map((a) => ({ name: a.name, email: a.email })),
      });
      toast('Cita creada: se está abriendo en tu app de calendario. Guárdala ahí y, si tiene invitados, envía las invitaciones.');
      onClose();
    } catch (e: any) {
      toast(e.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={<span className="flex items-center gap-2"><CalendarPlus size={15} className="text-accent-ink" />Agendar</span>} width={480}>
      <div className="space-y-3 p-5">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título de la cita" />
        <div className="flex gap-2">
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="flex-1" />
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="h-8 rounded-lg border border-hairline-strong bg-raised px-2 text-[13px] text-ink outline-none">
            {[15, 30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}
          </select>
        </div>
        {others.length > 0 && (
          <div>
            <div className="mb-1 text-[12px] text-ink-4">Invitar:</div>
            <div className="flex flex-wrap gap-1.5">
              {others.map((a) => (
                <button
                  key={a.email}
                  onClick={() => setInvite((v) => ({ ...v, [a.email!]: !v[a.email!] }))}
                  className={cx('rounded-full border px-2.5 py-1 text-[12px]', invite[a.email!] ? 'border-accent-tint bg-accent-wash text-accent-ink' : 'border-hairline text-ink-3')}
                >
                  {a.name || a.email}
                </button>
              ))}
            </div>
          </div>
        )}
        <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descripción (los puntos de la reunión, lo pendiente…)" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy}><CalendarPlus size={13} />{busy ? 'Creando…' : 'Crear cita'}</Button>
        </div>
        <div className="text-[11.5px] text-ink-4">Se crea un archivo .ics y se abre en tu calendario (Apple, Google u Outlook). Funciona con cualquier cuenta, sin permisos extra.</div>
      </div>
    </Modal>
  );
}

export function NextSteps({ meeting, onEmail, onSchedule }: { meeting: Meeting; onEmail: () => void; onSchedule: () => void }) {
  const [generating, setGenerating] = useState<string | null>(null);
  const makeArtifact = async (kind: 'diagram' | 'page' | 'slides', label: string) => {
    if (generating) return;
    setGenerating(kind);
    toast(`Generando ${label}… tarda un poco y se abrirá sola en el navegador.`);
    try {
      await api.post(`/api/meetings/${meeting.id}/artifact`, { kind });
      toast(`${label.charAt(0).toUpperCase() + label.slice(1)} lista: abierta en el navegador y guardada en Exportaciones.`);
    } catch (e: any) {
      toast(e.message, { tone: 'error' });
    } finally {
      setGenerating(null);
    }
  };
  const items = [
    { icon: <Mail size={13} />, label: 'Email de seguimiento', onClick: onEmail },
    { icon: <CalendarPlus size={13} />, label: 'Agendar seguimiento', onClick: onSchedule },
    { icon: <Share2 size={13} />, label: generating === 'diagram' ? 'Generando…' : 'Diagrama', onClick: () => void makeArtifact('diagram', 'el diagrama') },
    { icon: <Presentation size={13} />, label: generating === 'slides' ? 'Generando…' : 'Presentación', onClick: () => void makeArtifact('slides', 'la presentación') },
    { icon: <LayoutDashboard size={13} />, label: generating === 'page' ? 'Generando…' : 'Página interactiva', onClick: () => void makeArtifact('page', 'la página') },
  ];
  return (
    <div className="mt-8">
      <div className="mb-2 text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-4">Siguientes pasos</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <button
            key={it.label}
            onClick={it.onClick}
            disabled={!!generating && it.label === 'Generando…'}
            className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-raised px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-soft disabled:opacity-50"
          >
            <span className="text-accent-ink">{it.icon}</span>{it.label}
          </button>
        ))}
      </div>
    </div>
  );
}
