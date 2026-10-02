import { external } from './platform/trace';
import { Inject, Injectable, PayloadTooLargeException, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { dirname, join, normalize } from 'path';
import { Readable } from 'stream';
import { connect } from 'net';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export type Range = { start: number; end: number };
/** Driver surface: the same operations on local disk (dev/test) and S3-compatible object storage (production, India region). */
export interface ObjectStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(keyOrPrefix: string): Promise<void>;
  stat(key: string): Promise<{ size: number }>;
  stream(key: string, range?: Range): Promise<Readable>;
}

const safeKey = (key: string) => {
  const p = normalize(key);
  if (p.startsWith('..') || p.startsWith('/') || p.includes('\0')) throw new BadRequestException('bad key');
  return p;
};

export class LocalStore implements ObjectStore {
  constructor(private root = process.env.MEDIA_ROOT ?? join(process.cwd(), '.media')) {}
  private path(key: string) { return join(this.root, safeKey(key)); }
  async put(key: string, data: Buffer) { const f = this.path(key); await fs.mkdir(dirname(f), { recursive: true }); await fs.writeFile(f, data); }
  async get(key: string) { return fs.readFile(this.path(key)); }
  async remove(keyOrPrefix: string) { await fs.rm(this.path(keyOrPrefix), { recursive: true, force: true }); }
  async stat(key: string) { return { size: (await fs.stat(this.path(key))).size }; }
  async stream(key: string, range?: Range) { return createReadStream(this.path(key), range); }
}

/**
 * S3-compatible store. SSE-KMS is sent only when S3_KMS_KEY_ID is set (production bucket policy requires it; MinIO rejects the header).
 * The client is injectable so the driver is testable without a network.
 */
export class S3Store implements ObjectStore {
  constructor(private client: { send(cmd: any): Promise<any> }, private bucket: string, private kmsKeyId?: string, private prefix = '') {}
  private k(key: string) { return this.prefix + safeKey(key); }
  async put(key: string, data: Buffer) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: data, ContentLength: data.length, ...(this.kmsKeyId && { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: this.kmsKeyId }) }));
  }
  async get(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async stat(key: string) { const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) })); return { size: Number(r.ContentLength) }; }
  async stream(key: string, range?: Range) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.k(key), ...(range && { Range: `bytes=${range.start}-${range.end}` }) }));
    return r.Body as Readable;
  }
  /** Deletes one object or every object under a prefix. Missing keys are not an error. */
  async remove(keyOrPrefix: string) {
    const base = this.k(keyOrPrefix); let token: string | undefined;
    await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: [{ Key: base }], Quiet: true } }));
    do {
      const l = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: base.endsWith('/') ? base : `${base}/`, ContinuationToken: token }));
      if (l.Contents?.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: l.Contents.map((o: any) => ({ Key: o.Key })), Quiet: true } }));
      token = l.IsTruncated ? l.NextContinuationToken : undefined;
    } while (token);
  }
}

export const buildStore = (): ObjectStore => {
  if ((process.env.STORAGE_DRIVER ?? 'local') !== 's3') return new LocalStore();
  const client = new S3Client({ region: process.env.S3_REGION ?? 'ap-south-1', endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: !!process.env.S3_ENDPOINT });
  return new S3Store(client, process.env.S3_BUCKET!, process.env.S3_KMS_KEY_ID || undefined, process.env.S3_PREFIX ?? '');
};
export const OBJECT_STORE = 'OBJECT_STORE';

@Injectable()
export class StorageService {
  constructor(@Inject(OBJECT_STORE) private store: ObjectStore) {}
  async put(key: string, data: Buffer) {
    await external('storage', 'put', () => this.store.put(key, data));
    return { key, size: data.length, checksum: createHash('sha256').update(data).digest('hex') };
  }
  get(key: string) { return external('storage', 'get', () => this.store.get(key)); }
  /** Delete one object or a whole prefix (privacy erasure/retention). Missing keys are not an error. */
  remove(keyOrPrefix: string) { return external('storage', 'remove', () => this.store.remove(keyOrPrefix)); }
  stat(key: string) { return external('storage', 'stat', () => this.store.stat(key)); }
  stream(key: string, range?: Range) { return this.store.stream(key, range); }
}

/** Reads a raw request body with a hard size cap. */
export async function readBody(req: any, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw new PayloadTooLargeException(`max ${max} bytes`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ---- Malware scanning (TRD §4). Uploads are rejected unless the scanner says CLEAN; scanner failure fails CLOSED. ---------------
export interface ScanProvider { scan(data: Buffer, name: string): Promise<'CLEAN' | 'INFECTED'> }
export const SCANNER = 'SCANNER';
/** Dev/test stand-in. The production config guard refuses to start with it. */
@Injectable()
export class NoopScanner implements ScanProvider { async scan(_d?: Buffer, _n?: string) { return 'CLEAN' as const; } }

/** ClamAV clamd over TCP using the INSTREAM protocol (length-prefixed chunks, zero-length terminator). */
export class ClamdScanner implements ScanProvider {
  constructor(private host = process.env.CLAMD_HOST ?? '127.0.0.1', private port = Number(process.env.CLAMD_PORT ?? 3310), private timeoutMs = Number(process.env.CLAMD_TIMEOUT_MS ?? 20_000), private maxBytes = Number(process.env.SCAN_MAX_BYTES ?? 25 * 1024 * 1024)) {}
  scan(data: Buffer, name: string): Promise<'CLEAN' | 'INFECTED'> { return external('clamav', 'scan', () => this.scanRaw(data, name)); }
  private scanRaw(data: Buffer, _name: string): Promise<'CLEAN' | 'INFECTED'> {
    if (data.length > this.maxBytes) return Promise.reject(new PayloadTooLargeException(`file too large to scan (max ${this.maxBytes} bytes)`));
    return new Promise((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port }); let out = ''; let done = false;
      const fail = (m: string) => { if (done) return; done = true; sock.destroy(); reject(new ServiceUnavailableException(`malware scanner unavailable: ${m}`)); };
      sock.setTimeout(this.timeoutMs, () => fail('timeout'));
      sock.on('error', (e) => fail(e.message));
      sock.on('data', (d) => { out += d.toString('utf8'); });
      sock.on('close', () => {
        if (done) return; done = true;
        const r = out.replace(/\0/g, '').trim();
        if (/\bOK$/.test(r)) resolve('CLEAN'); else if (/FOUND$/.test(r)) resolve('INFECTED'); else reject(new ServiceUnavailableException(`malware scanner unavailable: unexpected reply "${r.slice(0, 80)}"`));
      });
      sock.on('connect', () => {
        sock.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) { const c = data.subarray(i, i + 64 * 1024); const len = Buffer.alloc(4); len.writeUInt32BE(c.length); sock.write(len); sock.write(c); }
        sock.write(Buffer.alloc(4));
      });
    });
  }
}
export const buildScanner = (): ScanProvider => ((process.env.SCANNER ?? 'noop') === 'clamav' ? new ClamdScanner() : new NoopScanner());
