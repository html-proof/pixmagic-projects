import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AdsApiError,
  AdsAuthError,
  AdsPermissionError,
  AdsRateLimitedError,
  AdsReportPendingError,
  AdsRetryableError,
  classifyAdError,
  isMetaPermissionError,
  META_ACCOUNT_PAGES,
  META_OTHER_CAMPAIGNS,
  metaAdAccounts,
  metaAdsReadTargets,
  metaCampaignDays,
  metaClassifyPermissionError,
  metaRangeInsights,
  metaReport,
  metaRetryAfterS,
  type FetchLike,
} from "../src/index.js";

/**
 * The Meta Marketing API client against answers shaped like Graph API ones: rate limits and their
 * usage headers, permission errors, the account list's statuses, daily campaign rows that must add
 * up to the account's own total (archived and deleted campaigns included), report jobs, and the
 * live report's order, truncation and splits.
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function fake(route: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return route(url, init);
  };
  return { fetchImpl, calls };
}

const meta = (fetchImpl: FetchLike) => ({ appId: "app1", appSecret: "sec", version: "v25.0", fetchImpl });
const level = (u: URL) => u.searchParams.get("level");
const failureOf = <T>(p: Promise<T>) =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => err as Error & { retryAfterS?: number | null; code?: number; errorCode?: string },
  );

describe("Meta's throttling, with how long Meta says it lasts", () => {
  it("reads the wait from X-Business-Use-Case-Usage (minutes) and X-Ad-Account-Usage (seconds), the longer winning", async () => {
    const buc = JSON.stringify({ "1234": [{ type: "ads_insights", call_count: 100, total_cputime: 20, total_time: 30, estimated_time_to_regain_access: 7 }], "99": [{ type: "ads_management", estimated_time_to_regain_access: 0 }] });
    const limited = fake(() => json({ error: { message: "User request limit reached", code: 17, error_subcode: 2446079 } }, 400, { "x-business-use-case-usage": buc }));
    const err = await failureOf(metaAdAccounts(meta(limited.fetchImpl), "T"));
    expect(err).toBeInstanceOf(AdsRateLimitedError);
    expect(err).toMatchObject({ retryAfterS: 420, code: 17, errorCode: "rate_limited" });
    expect(classifyAdError(err)).toMatchObject({ status: "error", code: "rate_limited", retryable: true, retryAfterS: 420 });

    const account = fake(() => json({ error: { message: "There have been too many calls to this ad-account.", code: 80004 } }, 400, { "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 100, ads_api_access_tier: "standard_access" }) }));
    expect(await failureOf(metaAdAccounts(meta(account.fetchImpl), "T"))).toMatchObject({ retryAfterS: 100, code: 80004 });
    // Both say: the longer wait.
    const h = new Headers({ "x-business-use-case-usage": buc, "x-ad-account-usage": JSON.stringify({ reset_time_duration: 900 }) });
    expect(metaRetryAfterS(h)).toBe(900);
    // Nothing said, or nothing readable: no wait given.
    expect(metaRetryAfterS(new Headers({ "x-business-use-case-usage": "not json", "x-ad-account-usage": "{}" }))).toBeNull();
    expect(metaRetryAfterS(null)).toBeNull();
    const silent = fake(() => json({ error: { message: "Application request limit reached", code: 4 } }, 400));
    expect(await failureOf(metaAdAccounts(meta(silent.fetchImpl), "T"))).toMatchObject({ retryAfterS: null, code: 4 });
  });
});

describe("Meta permission errors", () => {
  it("an account this login can't load (100/33) or a permission error (10, 200-299) is permission missing, keeping Meta's code", async () => {
    const unloadable = fake(() =>
      json({ error: { message: "Unsupported get request. Object with ID 'act_1' does not exist, cannot be loaded due to missing permissions, or does not support this operation.", type: "GraphMethodException", code: 100, error_subcode: 33 } }, 400),
    );
    const err = await failureOf(metaCampaignDays(meta(unloadable.fetchImpl), "T", "1", "2026-10-01", "2026-10-01"));
    expect(err).toBeInstanceOf(AdsPermissionError);
    expect(classifyAdError(err)).toMatchObject({ status: "permission", code: "no_access" });
    const denied = fake(() => json({ error: { message: "(#200) Requires ads_read permission", code: 200 } }, 403));
    const d = await failureOf(metaAdAccounts(meta(denied.fetchImpl), "T"));
    expect(d).toBeInstanceOf(AdsPermissionError);
    expect(isMetaPermissionError(d)).toBe(true);
    // Another code-100 refusal is a bad request, not a permission.
    const invalid = fake(() => json({ error: { message: "(#100) Invalid parameter", code: 100 } }, 400));
    expect(await failureOf(metaAdAccounts(meta(invalid.fetchImpl), "T"))).not.toBeInstanceOf(AdsPermissionError);
  });

  it("metaClassifyPermissionError: ads_read taken back means connect again; still granted means this login lost the account", async () => {
    const permissions = (adsRead: string | null) =>
      fake((u) => {
        if (u.pathname.endsWith("/me/permissions")) return adsRead === null ? json({ error: { message: "down", code: 2 } }, 500) : json({ data: [{ permission: "ads_read", status: adsRead }] });
        return json({ error: { message: "unexpected" } }, 400);
      });
    const lost = new AdsPermissionError("(#200) Requires ads_read permission", 200);
    const revoked = await metaClassifyPermissionError(meta(permissions("declined").fetchImpl), "T", lost);
    expect(revoked).toBeInstanceOf(AdsAuthError);
    expect(revoked).toMatchObject({ errorCode: "scope_missing" });
    expect(classifyAdError(revoked).status).toBe("reconnect");
    expect(await metaClassifyPermissionError(meta(permissions("granted").fetchImpl), "T", lost)).toBe(lost);
    // Meta can't say what's granted: it stays a permission error.
    expect(await metaClassifyPermissionError(meta(permissions(null).fetchImpl), "T", lost)).toBe(lost);
    // A permission error made elsewhere with Meta's code becomes one too.
    const plain = new AdsApiError("(#10) Application does not have permission for this action", 400, 10);
    expect(await metaClassifyPermissionError(meta(permissions("granted").fetchImpl), "T", plain)).toBeInstanceOf(AdsPermissionError);
    // Anything else comes back as it is, without asking Meta.
    const other = new AdsRetryableError("busy");
    const quiet = permissions("granted");
    expect(await metaClassifyPermissionError(meta(quiet.fetchImpl), "T", other)).toBe(other);
    expect(quiet.calls).toHaveLength(0);
  });
});

describe("appsecret_proof on the ads calls", () => {
  it("a person's token goes with its proof; the app token asking Meta's token inspector doesn't", async () => {
    const proof = createHmac("sha256", "sec").update("USER_T").digest("hex");
    const f = fake((u) => (u.pathname.endsWith("/debug_token") ? json({ data: { granular_scopes: [{ scope: "ads_read" }] } }) : json({ data: [{ id: "act_1" }] })));
    await metaAdAccounts(meta(f.fetchImpl), "USER_T");
    await metaAdsReadTargets(meta(f.fetchImpl), "USER_T");
    expect(f.calls[0]!.url.searchParams.get("appsecret_proof")).toBe(proof);
    const inspector = f.calls.find((c) => c.url.pathname.endsWith("/debug_token"))!;
    expect(inspector.url.searchParams.has("appsecret_proof")).toBe(false);
    expect(new Headers(inspector.init?.headers).get("authorization")).toBe("Bearer app1|sec");
  });
});

describe("the ad accounts a Meta login reaches", () => {
  it("says each account's status at Meta and why it's disabled", async () => {
    const f = fake((u) => {
      expect(u.searchParams.get("fields")).toBe("id,name,currency,timezone_name,account_status,disable_reason");
      return json({
        data: [
          { id: "act_1", name: "Live", account_status: 1 },
          { id: "act_2", name: "Unpaid", account_status: 3, disable_reason: 3 },
          { id: "act_3", name: "Banned", account_status: 2, disable_reason: 1 },
          { id: "act_4", name: "Gone", account_status: 101 },
        ],
      });
    });
    expect((await metaAdAccounts(meta(f.fetchImpl), "T")).map((a) => [a.accountId, a.status, a.statusDetail])).toEqual([
      ["act_1", "active", null],
      ["act_2", "payment_issue", "Because of a payment problem"],
      ["act_3", "disabled", "Because of Meta's advertising policies"],
      ["act_4", "closed", null],
    ]);
  });

  it("a login that reaches more accounts than are listed gets a list marked as cut", async () => {
    let pages = 0;
    const f = fake(() => {
      pages++;
      return json({ data: [{ id: `act_${pages}` }], paging: { next: `https://graph.facebook.com/v25.0/me/adaccounts?after=${pages}` } });
    });
    const accounts = await metaAdAccounts(meta(f.fetchImpl), "T");
    expect(accounts).toHaveLength(META_ACCOUNT_PAGES);
    expect(accounts.truncated).toBe(true);
    const short = fake(() => json({ data: [{ id: "act_1" }] }));
    expect((await metaAdAccounts(meta(short.fetchImpl), "T")).truncated).toBeUndefined();
  });
});

describe("Meta's daily campaign numbers add up to the account's own total", () => {
  const purchase = (n: number) => [{ action_type: "omni_purchase", value: String(n) }];

  it("asks for link clicks and every campaign status, and keeps what deleted campaigns spent as 'Other campaigns'", async () => {
    const f = fake((u) => {
      const filtering = u.searchParams.get("filtering");
      if (level(u) === "campaign") {
        expect(u.searchParams.get("fields")).toBe("campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,action_values");
        expect(JSON.parse(filtering!)).toEqual([{ field: "campaign.effective_status", operator: "IN", value: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"] }]);
        return json({
          data: [
            { campaign_id: "1", campaign_name: "Live", date_start: "2026-10-01", spend: "10.00", impressions: "100", clicks: "9", inline_link_clicks: "4", actions: purchase(1), action_values: purchase(30) },
            { campaign_id: "2", campaign_name: "Archived", date_start: "2026-10-01", spend: "5.50", impressions: "50", clicks: "3" },
            { campaign_id: "1", campaign_name: "Live", date_start: "2026-10-02", spend: "8", impressions: "80", clicks: "2", inline_link_clicks: "2" },
          ],
        });
      }
      expect(level(u)).toBe("account");
      expect(u.searchParams.get("time_increment")).toBe("1");
      expect(filtering).toBeNull();
      return json({
        data: [
          // A deleted campaign spent 4.50 on the 1st and made a sale: in the account's total, not in the campaign rows.
          { date_start: "2026-10-01", spend: "20.00", impressions: "190", clicks: "15", inline_link_clicks: "7", actions: purchase(2), action_values: purchase(55) },
          { date_start: "2026-10-02", spend: "8", impressions: "80", clicks: "2", inline_link_clicks: "2" },
          // Only deleted campaigns ran on the 3rd.
          { date_start: "2026-10-03", spend: "3.25", impressions: "30", clicks: "1" },
        ],
      });
    });
    const rows = await metaCampaignDays(meta(f.fetchImpl), "T", "1", "2026-10-01", "2026-10-03");
    expect(f.calls).toHaveLength(2);
    expect(rows.filter((r) => r.campaignId !== "other").map((r) => [r.campaignId, r.day, r.clicks, r.linkClicks])).toEqual([
      ["1", "2026-10-01", 9, 4],
      ["2", "2026-10-01", 3, 0],
      ["1", "2026-10-02", 2, 2],
    ]);
    const other = rows.filter((r) => r.campaignId === META_OTHER_CAMPAIGNS.campaignId);
    expect(other).toEqual([
      { provider: "meta", accountId: "act_1", ...META_OTHER_CAMPAIGNS, day: "2026-10-01", spend: 4.5, impressions: 40, clicks: 3, linkClicks: 3, conversions: 1, conversionValue: 25, purchases: 1, purchaseValue: 25, leads: 0 },
      { provider: "meta", accountId: "act_1", ...META_OTHER_CAMPAIGNS, day: "2026-10-03", spend: 3.25, impressions: 30, clicks: 1, linkClicks: 0, conversions: 0, conversionValue: 0, purchases: 0, purchaseValue: 0, leads: 0 },
    ]);
    // Every day's stored spend is the account's.
    const spendOn = (day: string) => Math.round(rows.filter((r) => r.day === day).reduce((s, r) => s + r.spend, 0) * 100) / 100;
    expect([spendOn("2026-10-01"), spendOn("2026-10-02"), spendOn("2026-10-03")]).toEqual([20, 8, 3.25]);
  });

  it("campaigns a cent above the account after rounding add no negative row", async () => {
    const f = fake((u) =>
      level(u) === "campaign"
        ? json({ data: [{ campaign_id: "1", date_start: "2026-10-01", spend: "3.334", impressions: "10" }, { campaign_id: "2", date_start: "2026-10-01", spend: "3.334", impressions: "10" }] })
        : json({ data: [{ date_start: "2026-10-01", spend: "6.66", impressions: "20" }] }),
    );
    const rows = await metaCampaignDays(meta(f.fetchImpl), "T", "1", "2026-10-01", "2026-10-01");
    expect(rows.map((r) => r.campaignId)).toEqual(["1", "2"]);
  });

  it("Meta refusing the status filter: campaigns are read without it, and the account's total still holds", async () => {
    const seen: Array<string | null> = [];
    const f = fake((u) => {
      if (level(u) === "account") return json({ data: [{ date_start: "2026-10-01", spend: "12" }] });
      seen.push(u.searchParams.get("filtering"));
      if (u.searchParams.has("filtering")) return json({ error: { message: "(#100) Filtering field campaign.effective_status with operation in is not supported", code: 100 } }, 400);
      return json({ data: [{ campaign_id: "1", campaign_name: "Live", date_start: "2026-10-01", spend: "10" }] });
    });
    const rows = await metaCampaignDays(meta(f.fetchImpl), "T", "1", "2026-10-01", "2026-10-01");
    expect(seen.map((s) => s !== null)).toEqual([true, false]);
    expect(rows.map((r) => [r.campaignId, r.spend])).toEqual([
      ["1", 10],
      ["other", 2],
    ]);
  });

  it("never part of a window: one that pages past the limit is split in halves; a single day that does is an error", async () => {
    const reads: string[] = [];
    const f = fake((u) => {
      if (level(u) === "account") return json({ data: [] });
      const range = u.searchParams.get("time_range");
      if (range) reads.push(range);
      const { since, until } = range ? (JSON.parse(range) as { since: string; until: string }) : { since: "", until: "" };
      // Two days at once never stop paging; one day at a time fits in a page.
      if (!range || since !== until) return json({ data: [{ campaign_id: "1", date_start: "2026-10-01", spend: "1" }], paging: { next: "https://graph.facebook.com/v25.0/act_1/insights?after=more" } });
      return json({ data: [{ campaign_id: "1", date_start: since, spend: "1" }] });
    });
    const rows = await metaCampaignDays(meta(f.fetchImpl), "T", "1", "2026-10-01", "2026-10-02");
    expect(rows.map((r) => r.day)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(reads.map((r) => JSON.parse(r) as unknown)).toEqual([
      { since: "2026-10-01", until: "2026-10-02" },
      { since: "2026-10-01", until: "2026-10-01" },
      { since: "2026-10-02", until: "2026-10-02" },
    ]);
    const endless = fake((u) => (level(u) === "account" ? json({ data: [] }) : json({ data: [{ campaign_id: "1", date_start: "2026-10-01", spend: "1" }], paging: { next: "https://graph.facebook.com/v25.0/act_1/insights?after=more" } })));
    await expect(metaCampaignDays(meta(endless.fetchImpl), "T", "1", "2026-10-01", "2026-10-01")).rejects.toBeInstanceOf(AdsApiError);
    await expect(metaCampaignDays(meta(endless.fetchImpl), "T", "1", "2026-10-02", "2026-10-01")).rejects.toThrow("Invalid date range");
  });
});

describe("Meta's report jobs", () => {
  it("a first page that runs out of time becomes a report job, done only at 100%", async () => {
    let polls = 0;
    const f = fake((u, init) => {
      if (init?.method === "POST") return json({ report_run_id: level(u) === "account" ? "801" : "802" });
      if (u.pathname === "/v25.0/act_1/insights") {
        if (level(u) === "account") return json({ data: [{ date_start: "2026-08-01", spend: "3" }] });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      if (u.pathname === "/v25.0/802") {
        polls++;
        // "Job Completed" isn't done until async_percent_completion is 100.
        return json({ async_status: polls < 3 ? "Job Running" : "Job Completed", async_percent_completion: polls < 4 ? 90 : 100 });
      }
      if (u.pathname === "/v25.0/802/insights") return json({ data: [{ campaign_id: "9", campaign_name: "Big", date_start: "2026-08-01", spend: "3" }] });
      return json({ error: { message: `unexpected ${u.pathname}` } }, 400);
    });
    const rows = await metaCampaignDays(meta(f.fetchImpl), "T", "1", "2026-07-01", "2026-10-01", { pollMs: 0 });
    expect(polls).toBe(4);
    expect(rows).toEqual([expect.objectContaining({ campaignId: "9", day: "2026-08-01", spend: 3 })]);
    const job = f.calls.find((c) => c.init?.method === "POST")!;
    expect(new URLSearchParams(String(job.init?.body)).get("filtering")).toContain("ARCHIVED");
  });

  it("a failed job's own error is what's thrown (v25.0 returns error_code and error_message)", async () => {
    const failing = (why: Record<string, unknown>) =>
      fake((u, init) => {
        if (init?.method === "POST") return json({ report_run_id: "803" });
        if (u.pathname === "/v25.0/act_1/insights") return json({ error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 } }, 500);
        if (u.pathname === "/v25.0/803" && u.searchParams.get("fields")?.startsWith("error_code")) return json(why);
        if (u.pathname === "/v25.0/803") return json({ async_status: "Job Failed", async_percent_completion: 0 });
        return json({ error: { message: "unexpected" } }, 400);
      });
    const bad = await failureOf(metaCampaignDays(meta(failing({ error_code: 100, error_message: "Invalid breakdown combination" }).fetchImpl), "T", "1", "2026-07-01", "2026-10-01", { pollMs: 0 }));
    expect(bad).toBeInstanceOf(AdsApiError);
    expect(bad.message).toBe("Meta's report job failed: Invalid breakdown combination");
    const throttled = await failureOf(metaCampaignDays(meta(failing({ error_code: 17, error_message: "User request limit reached" }).fetchImpl), "T", "1", "2026-07-01", "2026-10-01", { pollMs: 0 }));
    expect(throttled).toBeInstanceOf(AdsRateLimitedError);
    // Meta not saying why: worth another try.
    expect(await failureOf(metaCampaignDays(meta(failing({}).fetchImpl), "T", "1", "2026-07-01", "2026-10-01", { pollMs: 0 }))).toBeInstanceOf(AdsRetryableError);
  });
});

describe("the Meta Ads report", () => {
  it("asks for the biggest spenders first, archived and deleted included; says when Meta had more", async () => {
    let page = 0;
    const f = fake((u) => {
      // Delivery statuses of the ads listed.
      if (u.searchParams.has("ids")) return json({ "1": { id: "1", effective_status: "ARCHIVED" } });
      if (level(u) === "account") {
        expect(u.searchParams.has("filtering")).toBe(false);
        return json({ data: [{ spend: "100", impressions: "1000", reach: "500" }] });
      }
      expect(level(u)).toBe("ad");
      if (!u.searchParams.has("after")) {
        expect(JSON.parse(u.searchParams.get("sort")!)).toEqual(["spend_descending"]);
        expect(JSON.parse(u.searchParams.get("filtering")!)[0]).toMatchObject({ field: "ad.effective_status", operator: "IN", value: expect.arrayContaining(["ARCHIVED", "DELETED", "ADSET_PAUSED"]) });
      }
      page++;
      // Meta always has another page: the report reads up to its cap and says it was cut.
      return json({ data: [{ ad_id: String(page), ad_name: `Ad ${page}`, spend: String(100 - page) }], paging: { next: `https://graph.facebook.com/v25.0/act_1/insights?level=ad&after=${page}` } });
    });
    const r = await metaReport(meta(f.fetchImpl), "T", "1", "ad", "2026-10-01", "2026-10-07");
    expect(r.rows.map((x) => [x.id, x.status])).toEqual([
      ["1", "ARCHIVED"],
      ["2", null],
      ["3", null],
      ["4", null],
    ]);
    expect(r.truncated).toBe(true);
    // The account level on its own, a page at a time up to maxRows.
    const one = fake(() => json({ data: [{ ad_id: "5", spend: "60" }], paging: { next: "https://graph.facebook.com/v25.0/act_1/insights?after=x" } }));
    expect(await metaRangeInsights(meta(one.fetchImpl), "T", "1", "ad", "2026-10-01", "2026-10-07", 1)).toHaveLength(1);
    expect(one.calls).toHaveLength(1);
    expect(one.calls[0]!.url.searchParams.get("limit")).toBe("1");
  });

  it("Meta refusing the filter or the sort: the report comes without them", async () => {
    const f = fake((u) => {
      if (u.searchParams.has("sort")) return json({ error: { message: "(#100) Invalid parameter", code: 100 } }, 400);
      return json({ data: [{ campaign_id: "1", campaign_name: "A", spend: "5" }] });
    });
    const rows = await metaRangeInsights(meta(f.fetchImpl), "T", "1", "campaign", "2026-10-01", "2026-10-07");
    expect(rows).toHaveLength(1);
    expect(f.calls.map((c) => c.url.searchParams.has("filtering"))).toEqual([true, false]);
  });

  it("a range too heavy to answer at once runs as a report job; not done in time, the person is told it's being prepared", async () => {
    const heavy = (status: string) =>
      fake((u, init) => {
        if (init?.method === "POST") return json({ report_run_id: "901" });
        if (u.pathname === "/v25.0/act_1/insights") return json({ error: { message: "Please reduce the amount of data you're asking for, then retry your request", code: 1 } }, 500);
        if (u.pathname === "/v25.0/901") return json({ async_status: status, async_percent_completion: status === "Job Completed" ? 100 : 40 });
        if (u.pathname === "/v25.0/901/insights") return json({ data: [{ campaign_id: "1", campaign_name: "A", spend: "5" }] });
        return json({ error: { message: "unexpected" } }, 400);
      });
    expect(await metaRangeInsights(meta(heavy("Job Completed").fetchImpl), "T", "1", "campaign", "2026-01-01", "2026-10-01", 2000, undefined, { pollMs: 0 })).toHaveLength(1);
    const slow = heavy("Job Running");
    const err = await failureOf(metaReport(meta(slow.fetchImpl), "T", "1", "campaign", "2026-01-01", "2026-10-01", 200, { pollMs: 0, polls: 3 }));
    expect(err).toBeInstanceOf(AdsReportPendingError);
    expect(err).toBeInstanceOf(AdsRetryableError);
    expect(slow.calls.filter((c) => c.url.pathname === "/v25.0/901").length).toBeLessThanOrEqual(8);
  });

  it("the whole account split by age and by gender, Meta's own aggregates", async () => {
    const f = fake((u) => {
      const b = u.searchParams.get("breakdowns");
      if (b === "age") return json({ data: [{ age: "25-34", spend: "7" }, { age: "Unknown", spend: "1" }] });
      if (b === "gender") return json({ data: [{ gender: "female", spend: "5" }, { gender: "male", spend: "3" }, { gender: "unknown", spend: "0.5" }] });
      expect(b).toBeNull();
      return json({ data: [{ spend: "8.5", reach: "100" }] });
    });
    expect((await metaReport(meta(f.fetchImpl), "T", "1", "age", "2026-10-01", "2026-10-07")).rows.map((r) => [r.name, r.spend])).toEqual([
      ["Aged 25-34", 7],
      ["Unknown age", 1],
    ]);
    expect((await metaReport(meta(f.fetchImpl), "T", "1", "gender", "2026-10-01", "2026-10-07")).rows.map((r) => r.name)).toEqual(["Women", "Men", "Unknown"]);
    // A split asks for the same metrics as every other view.
    expect(f.calls.every((c) => c.url.searchParams.get("fields") === "spend,impressions,reach,frequency,clicks,inline_link_clicks,actions,action_values")).toBe(true);
  });
});
