import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { api } from '../api/client';
import type { ExamIndexRow, ExamSetupInfo } from '../api/types';
import { useAuth } from '../auth';
import { Badge, Card, ErrorNote, Loading } from '../components/ui';
import { modeLabel as sessionMode, statusLabel } from '../lib/examsetup';
import { canSee, EXAMSETUP, hasAny } from '../lib/roles';
import { Accommodations } from './ExamAccommodations';
import { Bank } from './ExamBank';

type Tab = 'EXAMS' | 'BANK' | 'ACCOMMODATIONS';

export default function ExamSetup() {
  const { me } = useAuth();
  if (!canSee(me?.roles, 'examsetup')) return <Navigate to="/staff" replace />; // checked before anything is fetched
  return <Desk canCreate={hasAny(me?.roles, EXAMSETUP.create)} canBank={hasAny(me?.roles, EXAMSETUP.bank)} canAccommodate={hasAny(me?.roles, EXAMSETUP.accommodate)} />;
}

function Desk({ canCreate, canBank, canAccommodate }: { canCreate: boolean; canBank: boolean; canAccommodate: boolean }) {
  const tabs: [Tab, string][] = [['EXAMS', 'Exams']]; if (canBank) tabs.push(['BANK', 'Question bank']); if (canAccommodate) tabs.push(['ACCOMMODATIONS', 'Accommodations']);
  const [tab, setTab] = useState<Tab>('EXAMS'); const [setup, setSetup] = useState<ExamSetupInfo | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<ExamSetupInfo>('/v1/exam-ops/setup').then(setSetup).catch(setError); }, []);
  return (
    <div>
      <h1>Exam set-up</h1>
      <p className="muted">Define an exam on a published course, keep its question bank, publish it (a different administrator must), then schedule sittings.</p>
      {setup?.changeFrozen && <p role="alert" className="note error">Exam changes are frozen right now (an exam window is under way). You can read everything but cannot define, publish, schedule or change questions until the freeze is lifted under Operations → settings.</p>}
      <ErrorNote error={error} />
      {tabs.length > 1 && <div className="tabs" role="group" aria-label="Exam set-up">{tabs.map(([k, l]) => <button key={k} aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>}
      {tab === 'EXAMS' && <Exams canCreate={canCreate && !setup?.changeFrozen} />}
      {tab === 'BANK' && (setup ? <Bank setup={setup} canEdit={!setup.changeFrozen} /> : (!error && <Loading />))}
      {tab === 'ACCOMMODATIONS' && <Accommodations />}
    </div>
  );
}

function Exams({ canCreate }: { canCreate: boolean }) {
  const [rows, setRows] = useState<ExamIndexRow[] | null>(null); const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<ExamIndexRow[]>('/v1/exam-ops/exams').then(setRows).catch(setError); }, []);
  return (
    <>
      {canCreate && <p><Link to="/staff/examsetup/new" className="button">Define a new exam</Link></p>}
      <ErrorNote error={error} />
      {!rows ? (!error && <Loading what="Loading exams" />) : !rows.length ? <Card><p>No exams are defined yet.{canCreate ? ' Define the first one.' : ''}</p></Card> : (
        <ul className="plain">{rows.map((e) => (
          <li key={e.id}><Card title={<Link to={`/staff/examsetup/exams/${e.id}`}>{e.title} <span className="muted">({e.code})</span></Link>} actions={<Badge tone={e.status === 'PUBLISHED' ? 'ok' : 'warn'}>{statusLabel(e.status)}</Badge>}>
            <p className="muted">{e.durationMin} minutes · pass mark {e.passPercent}% · {e.sessions.length} sitting{e.sessions.length === 1 ? '' : 's'}{e.sessions[0] ? ` · next or latest ${new Date(e.sessions[0].startsAt).toLocaleDateString()} (${sessionMode(e.sessions[0].mode)})` : ''}</p>
          </Card></li>))}</ul>)}
    </>
  );
}
