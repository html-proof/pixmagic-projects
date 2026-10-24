import { z } from "zod";
import { systemDb } from "@app/db";
import { buildReport, employeeScope, employeeStatement, logger, payslip, REPORT_GROUPS, REPORT_TYPES, reportFile, staffKpis, staffTrends, type ExportFile, type StaffActor } from "@app/core";
import { randomToken, sha256Hex } from "@app/shared";
import { GRANULARITIES, PAYMENT_STATUSES, RANGE_PRESETS, staffCan, type StaffPermission } from "@app/shared/staff";
import { body, HttpError, requireUser, type Ctx, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit, LIMITS } from "../rateLimit.js";
import { daySchema, idSchema, rangeSchema, requireEmployee, requireStaff } from "../staffAccess.js";

const BASE = "/workspaces/:ws/staff";
/** How long a download link works, and it works once. */
const EXPORT_TTL_S = 300;

const reportSchema = z.object({
  type: z.enum(REPORT_TYPES),
  groupBy: z.enum(REPORT_GROUPS),
  preset: z.enum(RANGE_PRESETS).default("this_month"),
  from: daySchema.optional(),
  to: daySchema.optional(),
  periodId: idSchema.optional(),
  employeeId: idSchema.optional(),
  departmentId: idSchema.optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
});

const exportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("report"), format: z.enum(["csv", "xlsx", "pdf"]), report: reportSchema }),
  z.object({ kind: z.literal("payslip"), itemId: idSchema }),
  z.object({ kind: z.literal("statement"), employeeId: idSchema, preset: z.enum(RANGE_PRESETS).default("this_year"), from: daySchema.optional(), to: daySchema.optional() }),
]);
type ExportRequest = z.infer<typeof exportSchema>;

/** What a download token stands for: who asked, where, and for what. Checked again on download. */
type ExportGrant = { userId: string; workspaceId: string; as: "staff"; request: ExportRequest } | { userId: string; workspaceId: string; as: "employee"; itemId: string };

const exportKey = (token: string) => `staff:export:${sha256Hex(token)}`;

async function grantDownload(c: Ctx, deps: Deps, grant: ExportGrant) {
  await limit(deps.coord, `rl:staff-export:${grant.userId}`, LIMITS.staffExports, "Too many downloads. Wait a few minutes and try again.");
  const token = randomToken(24);
  await deps.coord.put(exportKey(token), JSON.stringify(grant), EXPORT_TTL_S);
  return c.json({ url: `/api/staff/exports/${token}`, expiresInSeconds: EXPORT_TTL_S });
}

const permissionFor = (r: ExportRequest): StaffPermission => (r.kind === "report" && r.report.type === "attendance" ? "staff:export" : "pay:view");

function fileResponse(file: ExportFile) {
  const ascii = file.filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(file.body as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "content-length": String(file.body.length),
      "cache-control": "no-store",
    },
  });
}

async function buildFile(actor: StaffActor, request: ExportRequest): Promise<ExportFile> {
  const ws = await systemDb.workspace.findUnique({ where: { id: actor.workspaceId }, select: { name: true } });
  if (request.kind === "report") return reportFile(await buildReport(actor, request.report), request.format, ws?.name ?? "");
  if (request.kind === "payslip") return payslip(actor.workspaceId, request.itemId, { scope: employeeScope(actor), allowDraft: true });
  return employeeStatement(actor, request.employeeId, request);
}

/** Analytics, reports and every staff download (reports, payslips, statements). */
export function staffReportRoutes(app: App, deps: Deps) {
  const analyticsLimit = (userId: string) => limit(deps.coord, `rl:staff-analytics:${userId}`, LIMITS.staffAnalytics, "Too many requests. Wait a minute and try again.");

  app.get(`${BASE}/analytics`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:view");
    await analyticsLimit(actor.userId);
    return c.json(await staffKpis(actor, rangeSchema.parse(c.req.query())));
  });

  app.get(`${BASE}/analytics/trends`, async (c) => {
    const actor = await requireStaff(c, deps, c.req.param("ws"), "attendance:view");
    const q = rangeSchema.extend({ granularity: z.enum(GRANULARITIES).optional() }).parse(c.req.query());
    await analyticsLimit(actor.userId);
    return c.json(await staffTrends(actor, q));
  });

  app.get(`${BASE}/reports`, async (c) => {
    // Who is asking before what they ask: every role with a report holds staff:view.
    const actor = await requireStaff(c, deps, c.req.param("ws"), "staff:view");
    const q = reportSchema.parse(c.req.query());
    if (!staffCan(actor.access, q.type === "attendance" ? "attendance:view" : "pay:view")) throw new HttpError(403, "You don't have permission to do that", "forbidden");
    await analyticsLimit(actor.userId);
    return c.json(await buildReport(actor, q));
  });

  /** Ask for a download: answers a link that works once, for five minutes, for this user only. */
  app.post(`${BASE}/exports`, async (c) => {
    const ws = c.req.param("ws");
    const actor = await requireStaff(c, deps, ws, "staff:export");
    const request = exportSchema.parse(await body(c));
    if (!staffCan(actor.access, permissionFor(request))) throw new HttpError(403, "You don't have permission to do that", "forbidden");
    return grantDownload(c, deps, { userId: actor.userId, workspaceId: ws, as: "staff", request });
  });

  /** An employee's own payslip (approved payroll only). */
  app.post("/employee/:ws/payslips/:itemId/download", async (c) => {
    const ctx = await requireEmployee(c, deps, c.req.param("ws"));
    const itemId = c.req.param("itemId");
    const item = await systemDb.payrollItem.findFirst({ where: { id: itemId, workspaceId: ctx.workspaceId, employeeId: ctx.employee.id } });
    if (!item) throw new HttpError(404, "Not found", "not_found");
    return grantDownload(c, deps, { userId: ctx.userId, workspaceId: ctx.workspaceId, as: "employee", itemId });
  });

  /**
   * The download itself. Needs the same signed-in user the link was made for, and re-checks their
   * permission (it may have been taken away in the last five minutes). The file is built now, from
   * the database, and never stored.
   */
  app.get("/staff/exports/:token", async (c) => {
    const user = await requireUser(c, deps);
    const gone = () => new HttpError(404, "This download link has expired or was already used. Start the download again.", "expired");
    const key = exportKey(c.req.param("token"));
    // Check whose link it is before using it up: someone else opening it must not spend it.
    const seen = await deps.coord.peek(key);
    if (!seen || (JSON.parse(seen) as ExportGrant).userId !== user.id) throw gone();
    const raw = await deps.coord.take(key);
    if (!raw) throw gone();
    const grant = JSON.parse(raw) as ExportGrant;
    try {
      if (grant.as === "employee") {
        const ctx = await requireEmployee(c, deps, grant.workspaceId);
        return fileResponse(await payslip(grant.workspaceId, grant.itemId, { employeeId: ctx.employee.id, allowDraft: false }));
      }
      const actor = await requireStaff(c, deps, grant.workspaceId, permissionFor(grant.request));
      return fileResponse(await buildFile(actor, grant.request));
    } catch (err) {
      if (!(err instanceof HttpError)) logger.warn({ err: (err as Error).message }, "staff export failed");
      throw err;
    }
  });
}
