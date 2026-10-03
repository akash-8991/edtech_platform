import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Interaction, LearningEvent, Playback } from '../api/types';
import { EventOutbox, HeartbeatTracker } from '../lib/heartbeat';
import { fmtTime } from '../lib/format';
import { usePrefs } from '../prefs';
import { Modal } from './ui';
import { LANGS, useT } from '../lib/i18n';

const HLS = 'application/vnd.apple.mpegurl';

/**
 * Plays the lesson and reports genuine watch time. The server decides what counts: seeking is not watching, answers to in-video
 * questions are recorded, and low-bandwidth mode serves audio + transcript.
 */
export function VideoPlayer({ topicId, playback, onProgress }: { topicId: string; playback: Playback; onProgress: () => void }) {
  const t = useT(); const { prefs } = usePrefs(); const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const tracker = useMemo(() => new HeartbeatTracker(topicId, playback.assetId), [topicId, playback.assetId]);
  const outbox = useMemo(() => new EventOutbox((events) => api.post<{ results: { eventId: string; status: string }[] }>('/v1/learning-events', { events }).then((r) => r.results)), []);
  const [active, setActive] = useState<Interaction | null>(null);
  const answered = useRef(new Set<string>());
  const [transcript, setTranscript] = useState<string | null>(null);
  const video = playback.streams.find((s) => s.mime.startsWith('video/'));
  const audio = playback.streams.find((s) => s.mime.startsWith('audio/'));
  const savedLadder = playback.streams.find((s) => s.label === 'offline-hls'); // an adaptive lesson saved on this device: always played with hls.js from memory
  const src = playback.mode === 'low' ? audio ?? video : video ?? audio ?? (savedLadder && { label: savedLadder.label, mime: 'video/mp4', url: savedLadder.url });
  const transcriptUrl = playback.streams.find((s) => s.label === 'transcript')?.url;
  const captionsUrl = playback.streams.find((s) => s.label === 'captions')?.url;
  const hlsUrl = playback.mode === 'low' ? undefined : playback.streams.find((s) => s.mime === HLS)?.url;
  const [broken, setBroken] = useState(false); const [levels, setLevels] = useState<number[]>([]); const [quality, setQuality] = useState(-1); const hls = useRef<{ currentLevel: number; destroy: () => void } | null>(null); const resumed = useRef(false);

  const push = async (events: LearningEvent[]) => { outbox.add(events); const r = await outbox.flush(); if (r.some((x) => x.status === 'accepted')) onProgress(); };
  useEffect(() => { void outbox.flush(); const onHide = () => { if (document.visibilityState === 'hidden') void push(tracker.flush()); }; document.addEventListener('visibilitychange', onHide); return () => { document.removeEventListener('visibilitychange', onHide); void push(tracker.flush()); }; /* eslint-disable-next-line */ }, []);
  const seekToResume = () => { if (!resumed.current && media.current && playback.resume.sec > 0) { media.current.currentTime = playback.resume.sec; } resumed.current = true; };
  useEffect(() => { resumed.current = false; setLevels([]); setQuality(-1); }, [playback]);
  // Adaptive streaming: Safari plays HLS itself; every other browser gets hls.js (loaded only when a lesson has an adaptive ladder). Any failure falls back to the single-file rendition.
  useEffect(() => {
    const el = media.current; if (!el || !hlsUrl) return; let gone = false; let player: any;
    const fallback = () => { if (!gone && video) { player?.destroy?.(); hls.current = null; el.src = video.url; } else if (!gone && savedLadder) setBroken(true); };
    (async () => {
      if (!savedLadder && el.canPlayType(HLS)) { el.src = hlsUrl; return; } // Safari reads a real playlist itself, but not one made of in-memory blobs
      try {
        const { default: Hls } = await import('hls.js'); if (gone) return; if (!Hls.isSupported()) return fallback();
        player = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 30, startLevel: 0 }); hls.current = player;
        player.on(Hls.Events.MANIFEST_PARSED, (_e: unknown, d: { levels: { height: number }[] }) => setLevels(d.levels.map((l) => l.height)));
        player.on(Hls.Events.ERROR, (_e: unknown, d: { fatal?: boolean }) => { if (d.fatal) fallback(); });
        player.loadSource(hlsUrl); player.attachMedia(el);
      } catch { fallback(); }
    })();
    return () => { gone = true; player?.destroy?.(); hls.current = null; };
  }, [hlsUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (media.current) media.current.playbackRate = prefs.playbackSpeed ?? 1; }, [prefs.playbackSpeed, playback]);
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

  if (!src) return <p className="note warn">{t('No playable stream is available for this topic.')}</p>;
  if (broken) return <p className="note warn" role="alert">{t('This browser cannot play this saved lesson. Delete it and save it again, or watch it online.')}</p>;
  return (
    <div>
      <Tag ref={media} controls preload="metadata" src={hlsUrl ? undefined : src.url} className="player" onLoadedMetadata={seekToResume} onTimeUpdate={onTime} onPause={() => void push(tracker.flush())} onEnded={() => void push(tracker.flush())}
        onSeeked={() => tracker.seeked(media.current!.currentTime)} aria-label={t('Lesson video')}>
        {captionsUrl && <track kind="captions" src={captionsUrl} srcLang={playback.language} label={LANGS.find((l) => l.code === playback.language)?.native ?? playback.language} default={prefs.captions !== false} />}
        {t('Your browser cannot play this media.')}
      </Tag>
      {levels.length > 1 && <p><label htmlFor="vq" className="inline">{t('Quality')}</label> <select id="vq" value={quality} style={{ width: 'auto' }} onChange={(e) => { const v = Number(e.target.value); setQuality(v); if (hls.current) hls.current.currentLevel = v; }}><option value={-1}>{t('Automatic')}</option>{levels.map((h, i) => <option key={i} value={i}>{h}p</option>)}</select></p>}
      {!captionsUrl && playback.mode !== 'low' && <p className="muted">{transcript || transcriptUrl ? t('This video has no captions yet; the transcript is below.') : t('This video has no captions yet.')}</p>}
      <p className="muted">{playback.mode === 'low' ? t('Low-bandwidth mode (audio and transcript).') : hlsUrl ? t('Quality adjusts to your connection.') : t('Standard quality.')} {t('Length {time}.', { time: fmtTime(playback.durationSec) })} {t('Only time you actually watch counts towards completion.')}</p>
      {active && (
        <Modal labelledBy="ix-title">
          <div>
            <h3 id="ix-title">{t('Quick question')}</h3><p>{active.prompt ?? t('Choose an answer to continue.')}</p>
            <div className="choices">{(active.options?.length ? active.options : [t('Yes'), t('No')]).map((o, idx) => <button key={idx} onClick={() => void respond(active, idx)}>{o}</button>)}</div>
          </div>
        </Modal>)}
      {transcript && <details open={!!prefs.transcriptByDefault}><summary>{t('Transcript')}</summary><pre className="transcript">{transcript}</pre></details>}
    </div>
  );
}
