"use client";
import { ErrorState } from "@/components/ErrorState";
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorState kind="server" onRetry={retry} correlationId={error.digest} fullPage={true} />;
}
