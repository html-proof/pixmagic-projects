"use client";
import { GoogleAuthProvider, OAuthProvider, signInWithPopup } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { firebaseAuth } from "@/lib/firebase";
import { authErrorMessage, establishSession } from "@/lib/session";
import { Alert } from "./ui";

export function SocialButtons() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function go(provider: GoogleAuthProvider | OAuthProvider) {
    setBusy(true);
    setError(null);
    try {
      const cred = await signInWithPopup(firebaseAuth(), provider);
      await establishSession(cred.user);
      router.replace("/");
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const apple = () => {
    const p = new OAuthProvider("apple.com");
    p.addScope("email");
    p.addScope("name");
    return p;
  };

  return (
    <div className="space-y-2">
      {error && <Alert>{error}</Alert>}
      <button className="btn-secondary w-full" disabled={busy} onClick={() => go(new GoogleAuthProvider())}>
        Continue with Google
      </button>
      <button className="btn-secondary w-full" disabled={busy} onClick={() => go(apple())}>
        Continue with Apple
      </button>
    </div>
  );
}
