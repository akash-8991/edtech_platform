import { useEffect, useRef, useState } from 'react';
import { cameraProblem, cameraSupported, makeDetector, type CameraProblem } from '../lib/qr';
import { useT } from '../lib/i18n';

/**
 * Scans a QR code with the device camera and reports its text once. The camera stays on this page only: it is released when a code is
 * read, when the learner cancels, and when the page closes. Nothing is recorded or uploaded; only the decoded text is used.
 * `detect` is injectable so the component can be tested without a camera.
 */
export function QrScanner({ onResult, onCancel, detect }: { onResult: (text: string) => void; onCancel: () => void; detect?: (v: HTMLVideoElement) => Promise<string | null> }) {
  const t = useT(); const video = useRef<HTMLVideoElement>(null); const [problem, setProblem] = useState<CameraProblem | null>(() => (cameraSupported() ? null : 'unsupported')); const [ready, setReady] = useState(false);
  useEffect(() => {
    if (problem) return; let stopped = false; let stream: MediaStream | null = null; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = detect ?? makeDetector();
    const stop = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((x) => x.stop()); if (video.current) video.current.srcObject = null; };
    const loop = async () => { if (stopped || !video.current) return; const text = video.current.readyState >= 2 ? await read(video.current) : null; if (stopped) return; if (text) { stop(); onResult(text); return; } timer = setTimeout(() => void loop(), 150); };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) { stream.getTracks().forEach((x) => x.stop()); return; }
        const v = video.current!; v.srcObject = stream; v.setAttribute('playsinline', 'true'); await v.play().catch(() => undefined); setReady(true); void loop();
      } catch (e) { if (!stopped) setProblem(cameraProblem(e)); }
    })();
    return stop;
  }, [problem]); // eslint-disable-line react-hooks/exhaustive-deps
  const message: Record<CameraProblem, string> = {
    denied: t('The camera is blocked. Allow camera access for this site in your browser settings, or type the code instead.'), none: t('No camera was found on this device. Type the code instead.'),
    unsupported: t('This browser cannot use the camera here. Type the code instead.'), busy: t('The camera is being used by another app. Close it and try again, or type the code instead.'), other: t('The camera could not be started. Type the code instead.'),
  };
  return (
    <div className="scanner">
      {problem ? <p role="alert" className="note warn">{message[problem]}</p> : (<>
        <video ref={video} muted playsInline aria-label={t('Camera view for scanning the QR code')} className="scan-video" />
        <p role="status" className="muted">{ready ? t('Point the camera at the QR code shown in the lab.') : t('Starting the camera…')}</p></>)}
      <button type="button" className="secondary" onClick={onCancel}>{problem ? t('Close') : t('Stop scanning')}</button>
    </div>
  );
}
