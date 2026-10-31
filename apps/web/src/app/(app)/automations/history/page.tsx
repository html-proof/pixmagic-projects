"use client";
import { Suspense } from "react";
import { Skeleton } from "@/components/AppUi";
import { MessageMonitor } from "@/components/automations/Monitor";

/** Every automated message of every channel (?automation=sms:<id> or ?status= narrows it). */
export default function MessageHistoryPage() {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <MessageMonitor />
    </Suspense>
  );
}
