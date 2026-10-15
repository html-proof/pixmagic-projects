import Link from "next/link";
import { AuthShell } from "@/components/ui";

/** Exported as 404.html, which the server serves for any path with no page (apps/aws/src/staticSite.ts). */
export default function NotFound() {
  return (
    <AuthShell title="Page not found" subtitle="That address doesn't match any page in bizinsights.">
      <div className="flex items-center gap-4 text-sm">
        <Link className="btn-primary" href="/dashboard">Go to the dashboard</Link>
        <Link className="text-muted underline" href="/">Home page</Link>
      </div>
    </AuthShell>
  );
}
