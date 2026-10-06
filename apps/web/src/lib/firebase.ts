"use client";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
  type Auth,
} from "firebase/auth";

let authInstance: Auth | undefined;

export function firebaseAuth(): Auth {
  if (authInstance) return authInstance;
  const app = getApps().length
    ? getApp()
    : initializeApp({
        apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
        authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      });
  authInstance = getAuth(app);
  const emu = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR;
  if (emu) connectAuthEmulator(authInstance, emu, { disableWarnings: true });
  void setPersistence(authInstance, browserLocalPersistence);
  return authInstance;
}
