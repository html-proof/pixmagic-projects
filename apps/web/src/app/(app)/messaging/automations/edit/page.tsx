"use client";
import { Suspense } from "react";
import { Skeleton } from "@/components/AppUi";
import { AutomationBuilder } from "@/components/messaging/AutomationBuilder";

/** Create (no ?id=) or edit an automation in four steps; ?trigger= starts a new one from a trigger. */
export default function AutomationBuilderPage() {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <AutomationBuilder />
    </Suspense>
  );
}
