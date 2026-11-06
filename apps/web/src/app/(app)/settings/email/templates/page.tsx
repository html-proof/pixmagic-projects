"use client";
import Link from "next/link";
import { eventLabel } from "@app/shared/email";
import { ROW, TableCard, TableHead, TD, Th } from "@/components/automations/MarketingKit";
import { Badge } from "@/components/dashboard/Primitives";
import { relative } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { useApi } from "@/lib/api";
import { useEmail, type TemplateView } from "@/lib/email";

const statusBadge = (t: TemplateView) => <Badge tone={t.status === "active" ? "good" : "neutral"}>{t.status === "active" ? "Active" : t.status === "draft" ? "Draft" : "Archived"}</Badge>;
const typeWord = (t: TemplateView) => (t.category === "marketing" ? "Marketing" : "Transactional");
const eventWord = (t: TemplateView) => (t.eventType ? eventLabel(t.eventType) : "Any event");

/**
 * Settings → Email → Templates, as the Stitch design's tables (Marketing, screen 17): a tinted head
 * row and hairlines between rows; on a phone each template is a stacked row instead.
 */
export default function EmailTemplatesPage() {
  const { base, automate } = useEmail();
  const { data, error, loading, reload } = useApi<{ templates: TemplateView[] }>(`${base}/templates`);
  if (error && !data) return <LoadError what="your templates" error={error} onRetry={reload} busy={loading} />;
  if (!data) return <Skeleton lines={4} />;
  const href = (t: TemplateView) => `/settings/email/templates/edit?id=${t.id}`;
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
        <TableCard id="email-templates">
          <ul className="divide-y divide-home-line sm:hidden" aria-label="Templates">
            {data.templates.map((t) => (
              <li key={t.id} className="px-5 py-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <Link className="min-w-0 font-medium text-accent underline" href={href(t)}>
                    {t.name}
                  </Link>
                  {statusBadge(t)}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted">{t.subject}</p>
                <p className="mt-1 text-xs text-muted">
                  {eventWord(t)} · {typeWord(t)} · version {t.version} · {relative(t.updatedAt)}
                </p>
              </li>
            ))}
          </ul>
          <table className="hidden w-full min-w-[40rem] text-sm sm:table" aria-label="Templates">
            <TableHead>
              <Th>Name</Th>
              <Th>For event</Th>
              <Th>Type</Th>
              <Th>Status</Th>
              <Th right>Version</Th>
              <Th right>Updated</Th>
            </TableHead>
            <tbody>
              {data.templates.map((t) => (
                <tr key={t.id} className={ROW}>
                  <td className={`${TD} max-w-[18rem]`}>
                    <Link className="font-medium text-accent underline" href={href(t)}>
                      {t.name}
                    </Link>
                    <span className="block truncate text-xs text-muted">{t.subject}</span>
                  </td>
                  <td className={TD}>{eventWord(t)}</td>
                  <td className={TD}>{typeWord(t)}</td>
                  <td className={TD}>{statusBadge(t)}</td>
                  <td className={`${TD} text-right tabular-nums`}>{t.version}</td>
                  <td className={`${TD} text-right whitespace-nowrap`}>{relative(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableCard>
      )}
    </div>
  );
}
