/** One camera frame as raw RGBA pixels (what a canvas gives back). */
export interface Frame { data: Uint8ClampedArray; width: number; height: number }
/** jsQR is loaded on first use so the scanner costs nothing until someone opens the camera. */
export const decodeFrame = async (f: Frame): Promise<string | null> => { const { default: jsQR } = await import('jsqr'); return jsQR(f.data, f.width, f.height, { inversionAttempts: 'attemptBoth' })?.data || null; };

/** Whether the browser can open a camera at all (needs a secure context: https or localhost). */
export const cameraSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

type Detector = (video: HTMLVideoElement) => Promise<string | null>;

/**
 * Picks the fastest decoder this browser has: the built-in BarcodeDetector (Chrome, Edge, Android, recent Safari) or jsQR on a
 * down-scaled canvas copy of the frame everywhere else. Both return the text of the first QR code seen, or null.
 */
export function makeDetector(win: any = typeof window !== 'undefined' ? window : {}, doc: Document = document): Detector {
  if (win.BarcodeDetector) {
    let d: any; try { d = new win.BarcodeDetector({ formats: ['qr_code'] }); } catch { d = null; }
    if (d) return async (v) => { try { const r = await d.detect(v); return r[0]?.rawValue || null; } catch { return null; } };
  }
  const canvas = doc.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings) as CanvasRenderingContext2D | null;
  return async (v) => {
    if (!ctx || !v.videoWidth) return null;
    const scale = Math.min(1, 640 / v.videoWidth); canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height); const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return decodeFrame({ data: img.data, width: img.width, height: img.height });
  };
}

export type CameraProblem = 'denied' | 'none' | 'unsupported' | 'busy' | 'other';
export function cameraProblem(e: unknown): CameraProblem {
  const n = (e as { name?: string })?.name;
  return n === 'NotAllowedError' || n === 'SecurityError' ? 'denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'none' : n === 'NotReadableError' || n === 'AbortError' ? 'busy' : 'other';
}
