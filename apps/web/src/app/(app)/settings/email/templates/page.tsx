"use client";
import Link from "next/link";
import { eventLabel } from "@app/shared/email";
import { Badge } from "@/components/dashboard/Primitives";
import { relative } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Table, Td, Th } from "@/components/staff/ui";
import { EmptyState } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { useApi } from "@/lib/api";
import { useEmail, type TemplateView } from "@/lib/email";

/** Settings → Email → Templates. */
export default function EmailTemplatesPage() {
  const { base, automate } = useEmail();
  const { data, error, loading, reload } = useApi<{ templates: TemplateView[] }>(`${base}/templates`);
  if (error && !data) return <LoadError what="your templates" error={error} onRetry={reload} busy={loading} />;
  if (!data) return <Skeleton lines={4} />;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Email templates"
        sub="The emails your automations send, with placeholders like {{customer.first_name}} filled in for each recipient."
        actions={
          automate && (
            <Link className="btn-primary" href="/settings/email/templates/edit">
              New template
            </Link>
          )
        }
      />
      {data.templates.length === 0 ? (
        <EmptyState title="No templates yet" body="Write your first email: a thank-you for paid orders is a good start." />
      ) : (
        <section className="card">
          <Table label="Templates">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>For event</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th right>Version</Th>
                <Th right>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map((t) => (
                <tr key={t.id}>
                  <Td>
                    <Link className="font-medium text-accent underline" href={`/settings/email/templates/edit?id=${t.id}`}>
                      {t.name}
                    </Link>
                    <span className="block truncate text-xs text-muted">{t.subject}</span>
                  </Td>
                  <Td>{t.eventType ? eventLabel(t.eventType) : "Any event"}</Td>
                  <Td>{t.category === "marketing" ? "Marketing" : "Transactional"}</Td>
                  <Td>
                    <Badge tone={t.status === "active" ? "good" : "neutral"}>{t.status === "active" ? "Active" : t.status === "draft" ? "Draft" : "Archived"}</Badge>
                  </Td>
                  <Td right>{t.version}</Td>
                  <Td right>{relative(t.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}
    </div>
  );
}
