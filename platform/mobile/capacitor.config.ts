import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The native app is the learner web app (../web, built with VITE_API_URL pointing at the API) inside a Capacitor shell.
 * `androidScheme: 'https'` makes the Android WebView origin https://localhost, which the API must list in CORS_ORIGINS,
 * together with capacitor://localhost for iOS. See docs/guides/09-mobile-app.md.
 */
const config: CapacitorConfig = {
  appId: 'edu.institute.learning',
  appName: 'Learning Portal',
  webDir: '../web/dist',
  server: { androidScheme: 'https' },
  ios: { contentInset: 'always' },
  plugins: {
    FirebaseMessaging: { presentationOptions: ['badge', 'sound', 'alert'] },
    SplashScreen: { launchShowDuration: 0 },
  },
};
export default config;
