/** Public build-time configuration. Never put server secrets in NEXT_PUBLIC values. */
export const publicConfig = {
  firebase: {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  },
  firebaseAuthEmulator: process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR,
};
