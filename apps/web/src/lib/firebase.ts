"use client";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
  type Auth,
} from "firebase/auth";

import { publicConfig } from "./config";

let authInstance: Auth | undefined;

export function firebaseAuth(): Auth {
  if (authInstance) return authInstance;
  const app = getApps().length
    ? getApp()
    : initializeApp(publicConfig.firebase);
  authInstance = getAuth(app);
  const emu = publicConfig.firebaseAuthEmulator;
  if (emu) connectAuthEmulator(authInstance, emu, { disableWarnings: true });
  void setPersistence(authInstance, browserLocalPersistence);
  return authInstance;
}
