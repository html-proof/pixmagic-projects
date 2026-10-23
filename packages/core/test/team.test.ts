import { describe, expect, it } from "vitest";
import { accessFingerprint, accessSummary, checkAssignment, cleanInviteMessage, maskEmail, queryTeam, teamInvitationEmail, TeamError, teamTrend, TREND_DAYS, type TeamRow } from "../src/team/index.js";

describe("the invitation email", () => {
  const base = {
    workspace: "Acme <Goods>",
    inviter: { name: "Sam Owner", email: "sam@acme.test" },
    role: "custom" as const,
    permissions: ["customers.list", "products.view", "marketing.ads"],
    message: "Hi <b>there</b>",
    url: "https://bizinsights.io/invite#token=abc",
    expiresAt: new Date("2026-10-23T04:00:00Z"),
    timezone: "Australia/Melbourne",
  };

  it("says who invited them to what, what they'll see, until when, and how to ignore it", () => {
    const m = teamInvitationEmail(base);
    expect(m.subject).toBe("You've been invited to view a bizinsights dashboard");
    expect(m.text).toContain("You've been invited to securely view a shared business dashboard through bizinsights: Acme <Goods>, shared by Sam Owner (sam@acme.test).");
    expect(m.text).toContain("The dashboard owner has selected the information you are allowed to view.");
    expect(m.text).toContain("Your access includes:\n  - Customer details\n  - Product details\n  - Marketing");
    expect(m.text).toContain("No account registration or password is required.");
    expect(m.text).toContain("This invitation expires on October 23, 2026 at 3:00 PM GMT+11.");
    expect(m.text).toContain("The dashboard owner can change or revoke access at any time.");
    expect(m.text).toContain(base.url);
    expect(m.text).toContain("If you were not expecting this invitation, you can ignore this email.");
    expect(m.text).toContain("bizinsights Team");
    // One accessible button (white on #2f6f4f, contrast 6.6:1), Outlook-safe (a table cell), no images or tracking.
    expect(m.html).toContain(">Open Shared Dashboard</a>");
    expect(m.html).toMatch(/bgcolor="#2f6f4f"/);
    expect(m.html).not.toMatch(/<img|<style/i);
    expect(m.html).toContain('name="viewport"');
    // The owner's own text is escaped in the HTML.
    expect(m.html).toContain("Acme &lt;Goods&gt;");
    expect(m.html).toContain("Hi &lt;b&gt;there&lt;/b&gt;");
    expect(m.html).not.toContain("<b>there</b>");
    expect(m.html).toContain('href="https://bizinsights.io/invite#token=abc"');
  });

  it("signs off as the link sender, with where to get help, keeping replies for the inviter", () => {
    const senders = {
      EMAIL_FROM: "bizinsights <no-reply@bizinsights.io>",
      OTP_FROM_EMAIL: "support@bizinsights.io",
      OTP_FROM_NAME: "BizInsights Support",
      LINK_FROM_EMAIL: "link@bizinsights.io",
      LINK_FROM_NAME: "BizInsights",
      SUPPORT_EMAIL: "support@bizinsights.io",
    };
    const m = teamInvitationEmail({ ...base, senders });
    expect(m.text).toContain("Questions? Reply to this email to reach Sam Owner.");
    expect(m.text).toContain("Need help with bizinsights? Contact support@bizinsights.io.");
    expect(m.text).toMatch(/Regards,\nBizInsights\nlink@bizinsights\.io$/);
    expect(m.html).toContain('Need help with bizinsights? Contact <a href="mailto:support@bizinsights.io"');
    expect(m.html).toContain('Regards,<br>BizInsights<br><a href="mailto:link@bizinsights.io"');
    // The link's token stays in the fragment, which browsers never send to a server.
    expect(m.html).toContain('href="https://bizinsights.io/invite#token=abc"');
    expect(teamInvitationEmail({ ...base, senders: { ...senders, SUPPORT_EMAIL: "" } }).text).not.toContain("Need help");
  });

  it("copes with an unknown time zone and keeps line breaks out of the subject", () => {
    const m = teamInvitationEmail({ ...base, workspace: "Evil\r\nBcc: x@y.z", timezone: "Not/AZone", message: null });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).toContain("UTC");
    expect(m.html).not.toContain("blockquote");
  });

  it("summarizes full access and none", () => {
    expect(accessSummary({ role: "admin", permissions: [] })).toBe("everything in the workspace");
    expect(accessSummary({ role: "custom", permissions: [] })).toMatch(/^nothing yet/);
    expect(accessSummary({ role: "viewer", permissions: ["analytics.sales"] })).toBe("Analytics");
  });
});

describe("the inviter's message", () => {
  it("is plain text without links", () => {
    expect(cleanInviteMessage("  ")).toBeNull();
    expect(cleanInviteMessage(null)).toBeNull();
    expect(cleanInviteMessage("Welcome aboard!\nSee you Monday.\u0007")).toBe("Welcome aboard!\nSee you Monday.");
    for (const bad of ["Go to https://x.test", "visit www.example.com", "log in at example.com/login"]) {
      expect(() => cleanInviteMessage(bad), bad).toThrow(TeamError);
    }
    expect(() => cleanInviteMessage("x".repeat(501))).toThrow(/under 500/);
  });
});

describe("checkAssignment", () => {
  const owner = { workspaceId: "w", userId: "u", role: "owner" as const };
  it("needs an owner or admin, never grants ownership, and keeps supervisors apart from staff permissions", () => {
    expect(() => checkAssignment({ ...owner, role: "manager" }, { role: "viewer", permissions: [] })).toThrow(/Only owners and admins/);
    expect(() => checkAssignment(owner, { role: "owner", permissions: [] })).toThrow(TeamError);
    expect(() => checkAssignment(owner, { role: "custom", permissions: ["staff.team"], staffRole: "supervisor" })).toThrow(/supervisor/);
    expect(checkAssignment(owner, { role: "admin", permissions: [], staffRole: "hr_manager" })).toEqual({ role: "admin", permissions: [], staffRole: null });
    expect(checkAssignment(owner, { role: "viewer", permissions: ["products.view", "analytics.sales"] })).toEqual({ role: "viewer", permissions: ["analytics.sales", "products.view"], staffRole: null });
  });
});

describe("helpers", () => {
  it("fingerprints what a membership allows, and nothing else", () => {
    const a = accessFingerprint({ role: "custom", permissions: ["b", "a"], staffRole: null, revokedAt: null });
    expect(a).toBe(accessFingerprint({ role: "custom", permissions: ["a", "b"], staffRole: null, revokedAt: null }));
    expect(a).not.toBe(accessFingerprint({ role: "custom", permissions: ["a", "b"], staffRole: null, revokedAt: new Date() }));
    expect(a).not.toBe(accessFingerprint({ role: "viewer", permissions: ["a", "b"], staffRole: null, revokedAt: null }));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("masks an address", () => {
    expect(maskEmail("jo@example.com")).toBe("j•@example.com");
    expect(maskEmail("client@example.com")).toBe("cl••••@example.com");
  });

  it("searches, filters, sorts and pages the team", () => {
    const row = (email: string, status: TeamRow["status"], role: TeamRow["role"], since: string, name: string | null = null): TeamRow => ({
      kind: status === "active" || status === "revoked" ? "member" : "invitation",
      id: email,
      email,
      name,
      role,
      permissions: [],
      modules: [],
      staffRole: null,
      status,
      since,
      invitedBy: null,
    });
    const rows = [
      row("zed@x.test", "active", "owner", "2026-01-01", "Zed Owner"),
      row("amy@x.test", "pending", "viewer", "2026-03-01"),
      row("bob@x.test", "revoked", "analyst", "2026-02-01", "Bob"),
      row("cat@x.test", "expired", "custom", "2026-04-01"),
    ];
    expect(queryTeam(rows, {}).rows.map((r) => r.email)).toEqual(["zed@x.test", "amy@x.test", "cat@x.test", "bob@x.test"]);
    expect(queryTeam(rows, { q: "BOB" }).rows.map((r) => r.email)).toEqual(["bob@x.test"]);
    expect(queryTeam(rows, { status: "invitations" }).total).toBe(2);
    expect(queryTeam(rows, { status: "members" }).total).toBe(2);
    expect(queryTeam(rows, { role: "custom" }).rows.map((r) => r.email)).toEqual(["cat@x.test"]);
    expect(queryTeam(rows, { sort: "since", dir: "desc" }).rows[0]!.email).toBe("cat@x.test");
    expect(queryTeam(rows, { sort: "name" }).rows.map((r) => r.email)).toEqual(["amy@x.test", "bob@x.test", "cat@x.test", "zed@x.test"]);
    const paged = queryTeam(rows, { pageSize: 3, page: 2 });
    expect(paged).toMatchObject({ total: 4, pages: 2, page: 2 });
    expect(paged.rows).toHaveLength(1);
    expect(queryTeam(rows, { pageSize: 3, page: 9 }).page).toBe(2);
  });
});

describe("the team page's trend lines", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it("rebuilds each count, day by day, from the dates on record", () => {
    const t = teamTrend(
      [
        { createdAt: daysAgo(100), revokedAt: null },
        { createdAt: daysAgo(10), revokedAt: daysAgo(3) },
      ],
      [
        { createdAt: daysAgo(8), acceptedAt: daysAgo(6), revokedAt: null, expiresAt: daysAgo(1) },
        { createdAt: daysAgo(5), acceptedAt: null, revokedAt: null, expiresAt: daysAgo(2) },
        { createdAt: daysAgo(1), acceptedAt: null, revokedAt: null, expiresAt: daysAgo(-6) },
      ],
      now,
    );
    for (const series of Object.values(t)) expect(series).toHaveLength(TREND_DAYS);
    const at = (n: number) => TREND_DAYS - 1 - n;
    expect(t.totalMembers[at(29)]).toBe(1);
    expect(t.totalMembers[at(0)]).toBe(2);
    expect(t.activeMembers[at(4)]).toBe(2);
    expect(t.activeMembers[at(0)]).toBe(1);
    // Day 7: the first invitation is waiting; day 4: it was accepted, the second one waits.
    expect(t.pendingInvitations[at(7)]).toBe(1);
    expect(t.pendingInvitations[at(4)]).toBe(1);
    expect(t.endedInvitations[at(4)]).toBe(0);
    // Today: the second one has expired, the third waits.
    expect(t.pendingInvitations[at(0)]).toBe(1);
    expect(t.endedInvitations[at(0)]).toBe(1);
  });
});
