# Adaptive-bitrate video (HLS)

Lessons can be delivered as an adaptive ladder so a learner on a weak connection gets a lower rung and a learner on fibre gets full quality, switching without a pause. The single-file renditions (`master`, `720p`, `360p`) remain as the fallback and as the source of truth: the ladder is **derived** and can be rebuilt at any time.

```
master (uploaded) ──► POST /v1/authoring/assets/:id/transcode ──► job queue ──► worker: ffprobe, then ffmpeg per rung
                                                                         └──► object store: hls/<assetId>/master.m3u8, <rung>/index.m3u8, <rung>/seg_00000.ts…
learner: GET /v1/topics/:id/playback ──► streams[0] = { label: "hls", url: /v1/media/hls/<token> } ──► hls.js (Safari: native)
```

## The ladder

240p, 360p, 480p, 720p, 1080p (H.264 Main + AAC, 6-second segments, keyframes aligned across rungs so switching is seamless). **Never upscales**: a 720p master gets 240–720p; a source smaller than 240p gets one rung at its own size. Bitrates are in `src/media/abr.ts` (`LADDER`). Low-bandwidth mode does not offer the ladder (it serves audio and transcript first, as before).

## Operating it

| Need | How |
|---|---|
| ffmpeg | The **worker** needs `ffmpeg` and `ffprobe` on its PATH (or `FFMPEG_BIN`, `FFPROBE_BIN`): the `worker` and `grader` Docker targets install it. **Verified with real ffmpeg:** `test/transcode-live.spec.ts` encodes a real 14 s 720p video into the 4 rungs, plays every rung through the signed playlists, reassembles each and decodes it end to end with no errors, and `scripts/e2e-two-users.ts` does the same under two concurrent learners. The ladder's visual quality has not been judged by a person, and only a 14-second test clip has been encoded (long lessons will take minutes: size the worker and `TRANSCODE_TIMEOUT_MIN`). |
| Start a build | `POST /v1/authoring/assets/:id/transcode` (content author or academic admin; one at a time per asset) or `python publish.py … --abr` from the video engine. Published assets can be transcoded (it only adds renditions). |
| Check it | `GET /v1/authoring/assets/:id/renditions` → job status and the recorded ladder (`files.hls`). |
| Replacing the master | Uploading a new `master` drops the old ladder (it would show stale video); queue a new build. |
| Time limit | `TRANSCODE_TIMEOUT_MIN` (default 90) per ffmpeg/ffprobe call; a job that fails is retried up to 3 times, then FAILED with the reason. |
| Capacity | A transcode is CPU-heavy: run it on worker instances, not API instances (`PROCESS_ROLE`), and size `AI_WORKER_CONCURRENCY` for it. |

## Security

Playlists are served by `GET /v1/media/hls/:token`; the token is signed and expiring. **Every reference inside a playlist is re-signed** with the same expiry (never longer), so the player needs no credentials and nothing outlives the first token. References are resolved against the asset's own folder and refuse absolute paths, schemes, queries and `..`. Segment tokens carry the right content type. `HLS_TTL_MIN` (default 180) is how long one playback's tokens last (a long lesson fetches segments throughout): shorten it if a pause or revoked entitlement must cut access faster; a stream token cannot be used as a playlist token and vice versa. For production, front the segments with the CDN's own signed URLs as the existing single-file streaming already anticipates.

**Offline:** a learner saves the lesson at a chosen quality (*Small*: up to 360p, *Standard*: 360p–720p, *Best*: all rungs). Each rung is packed by the server into one bundle (playlist + all segments, `EDHLS1` format in `api/src/media/abr.ts`), encrypted with its own device-bound licence, and downloaded; offline, the app decrypts in memory and plays the ladder with hls.js from in-memory playlists, switching rungs exactly as when streaming. A lesson is valid only while every one of its licences is. Browsers without Media Source Extensions (iPhones before iOS 17.1) save the single-file rendition instead. Request: `POST /v1/offline/licenses` with `label: "hls-<rung>"`; the playback manifest lists the rungs under `adaptive`.
