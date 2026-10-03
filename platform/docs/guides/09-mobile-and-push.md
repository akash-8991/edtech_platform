# Mobile app and push notifications

## Push notifications

A learner (or staff member) turns push on **per device** in *Privacy and data → Push notifications*; there is also an account-wide switch. The server sends a push for each in-app notification (exam registered/submitted/result released, assignment graded, lab booked/cancelled/completed, doubt reply, privacy request decided, topic unlocked, programme completed, access ending), in the person's language (English or Hindi), with a link to the right screen.

```
event ─► Notification row (same transaction as the change) ─► worker sweep every PUSH_SWEEP_MS (5 s) claims it exactly once
      ─► for each active device: Web Push (browsers, installed web app)  or  Firebase Cloud Messaging (Android, iOS via APNs)
```

* **Web Push** is the standard protocol (VAPID, RFC 8030/8291/8292) with no vendor SDK: Chrome, Edge, Firefox, Safari 16.4+ (on iPhone and iPad only once the app is added to the Home Screen). Generate keys with `npx web-push generate-vapid-keys`; set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in the secret.
* **Native** uses FCM for both platforms (`@capacitor-firebase/messaging`): create a Firebase project, add the Android and iOS apps, upload the APNs key for iOS, and put the service-account JSON in `FCM_SERVICE_ACCOUNT`.
* `PUSH_MODE`: unset/`off` (nothing sent), `log` (development: writes what it would send), `live` (production; refused at start-up unless a provider is configured).
* Delivery rules: **at most once** per notification (claimed with `FOR UPDATE SKIP LOCKED`, so several workers never duplicate); a notification older than a day is marked done without sending (a late "your exam starts soon" is worse than none); a device the push service reports gone (unsubscribed, app removed) is switched off, and one that fails five times is too (registering again revives it); a notification created before the person registered a device is not pushed to it; push off (account switch) or a suspended account sends nothing; erasing a person deletes their devices.
* What is in a push: a title, one short sentence, a tag and a link. Nothing personal beyond the sentence; open the app for detail.
* **Checked with the real protocol:** the Web Push provider is tested against a stand-in push service that decrypts the payload exactly as a browser does (ECDH + HKDF + AES-128-GCM) and verifies the VAPID signature; FCM is tested against a fake HTTP endpoint including token exchange and refresh. **No push has been sent through Google's or Apple's real services** (no Firebase project, no device).

API: `GET /v1/push/config`, `POST/GET /v1/me/push/devices`, `DELETE /v1/me/push/devices/:id`, `POST /v1/me/push/test`.

## Mobile app (Android and iOS)

`platform/mobile` wraps the learner web app in a native shell (Capacitor 7), so the app is the same code as the website: Hindi, offline lessons (encrypted, device-bound, adaptive), captions, QR check-in with the camera, adaptive video, and push. Native-only additions: push through FCM, and a tap on a notification opens its screen.

| | Status |
|---|---|
| Android project (`mobile/android`) | Generated and synced (`npx cap add android`; manifest has INTERNET, POST_NOTIFICATIONS, CAMERA). **Not compiled**: no Android SDK on the build machine. |
| iOS project | **Not generated**: needs Xcode and CocoaPods, neither installed here. On a Mac with both: `cd mobile && npm install && npx cap add ios`, then add *Push Notifications* and *Background Modes → Remote notifications* capabilities and `NSCameraUsageDescription` to Info.plist, and the `GoogleService-Info.plist`. |
| Store release | Not done: signing keys, store listings, privacy labels, review. |

Build (on a machine with the SDKs):

```bash
cd platform/mobile && npm install
# 1. build the web app pointing at the API (the native shell has no same-origin proxy)
cd ../web && VITE_API_URL=https://learn.institute.edu npm run build && cd ../mobile
# 2. Firebase: put google-services.json in android/app/ (and GoogleService-Info.plist in ios/App/App/); never commit them
npx cap sync
npx cap open android     # Android Studio: Run / Build > Generate Signed Bundle
npx cap open ios         # Xcode: Run / Product > Archive
```

* **API side:** set `extra_cors_origins` (Terraform) / `CORS_ORIGINS` to include `capacitor://localhost` (iOS) and `https://localhost` (Android WebView).
* **Sign-in:** password sign-in works in the app. **Single sign-on does not yet work inside the app**: the identity provider returns to a web address, not into the app (needs universal/app links and the system browser). Decide with the institute whether staff or learners use SSO on mobile.
* **Exams:** remote-proctored exams need the vendor's browser or SDK flow; the in-app WebView has not been verified with any proctoring vendor. Prefer the exam in a supported browser or at a centre until validated.
* The service worker is not registered in the native app (the app bundles its own copy); everything offline (IndexedDB, WebCrypto) works in the WebView.
* **Staff console is English only** in the website and the app, whatever language the person reads the learner portal in.
