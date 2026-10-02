import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Interaction, LearningEvent, Playback } from '../api/types';
import { EventOutbox, HeartbeatTracker } from '../lib/heartbeat';
import { fmtTime } from '../lib/format';

/**
 * Plays the lesson and reports genuine watch time. The server decides what counts: seeking is not watching, answers to in-video
 * questions are recorded, and low-bandwidth mode serves audio + transcript.
 */
export function VideoPlayer({ topicId, playback, onProgress }: { topicId: string; playback: Playback; onProgress: () => void }) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const tracker = useMemo(() => new HeartbeatTracker(topicId, playback.assetId), [topicId, playback.assetId]);
  const outbox = useMemo(() => new EventOutbox((events) => api.post<{ results: { eventId: string; status: string }[] }>('/v1/learning-events', { events }).then((r) => r.results)), []);
  const [active, setActive] = useState<Interaction | null>(null);
  const answered = useRef(new Set<string>());
  const [transcript, setTranscript] = useState<string | null>(null);
  const video = playback.streams.find((s) => s.mime.startsWith('video/'));
  const audio = playback.streams.find((s) => s.mime.startsWith('audio/'));
  const src = playback.mode === 'low' ? audio ?? video : video ?? audio;
  const transcriptUrl = playback.streams.find((s) => s.label === 'transcript')?.url;

  const push = async (events: LearningEvent[]) => { outbox.add(events); const r = await outbox.flush(); if (r.some((x) => x.status === 'accepted')) onProgress(); };
  useEffect(() => { void outbox.flush(); const onHide = () => { if (document.visibilityState === 'hidden') void push(tracker.flush()); }; document.addEventListener('visibilitychange', onHide); return () => { document.removeEventListener('visibilitychange', onHide); void push(tracker.flush()); }; /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (media.current && playback.resume.sec > 0) media.current.currentTime = playback.resume.sec; }, [playback]);
  useEffect(() => { if (!transcriptUrl) return; fetch(transcriptUrl).then((r) => r.text()).then(setTranscript).catch(() => setTranscript(null)); }, [transcriptUrl]);

  const onTime = () => {
    const t = media.current!.currentTime; void push(tracker.tick(t));
    const due = playback.interactions.find((i) => i.atSec <= t && t - i.atSec < 3 && !answered.current.has(i.id));
    if (due && !active) { media.current!.pause(); setActive(due); }
  };
  const respond = async (i: Interaction, response: number) => {
    answered.current.add(i.id); setActive(null);
    await push([{ eventId: crypto.randomUUID(), topicId, type: 'INTERACTION_RESPONSE', occurredAt: new Date().toISOString(), payload: { assetId: playback.assetId, interactionId: i.id, response } }]);
    void media.current?.play();
  };
  const Tag = (src?.mime.startsWith('audio/') ? 'audio' : 'video') as 'video';

  if (!src) return <p className="note warn">No playable stream is available for this topic.</p>;
  return (
    <div>
      <Tag ref={media} controls preload="metadata" src={src.url} className="player" onTimeUpdate={onTime} onPause={() => void push(tracker.flush())} onEnded={() => void push(tracker.flush())}
        onSeeked={() => tracker.seeked(media.current!.currentTime)} aria-label="Lesson video">
        Your browser cannot play this media.
      </Tag>
      <p className="muted">{playback.mode === 'low' ? 'Low-bandwidth mode (audio and transcript).' : 'Standard quality.'} Length {fmtTime(playback.durationSec)}. Only time you actually watch counts towards completion.</p>
      {active && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ix-title">
          <div className="modal-body">
            <h3 id="ix-title">Quick question</h3><p>{active.prompt ?? 'Choose an answer to continue.'}</p>
            <div className="choices">{(active.options?.length ? active.options : ['Yes', 'No']).map((o, idx) => <button key={idx} autoFocus={idx === 0} onClick={() => void respond(active, idx)}>{o}</button>)}</div>
          </div>
        </div>)}
      {transcript && <details><summary>Transcript</summary><pre className="transcript">{transcript}</pre></details>}
    </div>
  );
}
