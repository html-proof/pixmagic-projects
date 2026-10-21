"use client";
import { useEffect, useState } from "react";
import { ErrorNotice } from "@/components/ErrorNotice";
export function ConnectionStatus() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  if (!offline) return null;
  return <div className="border-b border-border bg-bg px-4 py-3"><div className="mx-auto max-w-6xl"><ErrorNotice kind="network" title="Connection lost" action={<button type="button" className="btn-secondary" onClick={() => window.dispatchEvent(new Event("insights:retry"))}>Try again</button>}>
    Check your internet connection. Reports may be out of date; updates resume when you're online.
  </ErrorNotice></div></div>;
}
