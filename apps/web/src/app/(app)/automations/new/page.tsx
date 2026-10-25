"use client";
import { Suspense } from "react";
import { Skeleton } from "@/components/AppUi";
import { AutomationWizard } from "@/components/automations/Wizard";

/** The four-step setup: a new automation, or ?channel=&id= to edit one (?trigger= starts from a trigger). */
export default function NewAutomationPage() {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <AutomationWizard />
    </Suspense>
  );
}
