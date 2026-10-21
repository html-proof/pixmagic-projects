"use client";
import type { DemoBreakdownRow } from "@app/shared/adsDemo";
import { fmtSpan } from "@/components/dashboard/format";
import type { GoogleAdsAnalytics } from "@/lib/googleAds";
import { Section, SplitTable, figureWriters } from "./ui";

/** Section 5: desktop, mobile and tablet. */
export function DevicesSection({ devices, currency, demo, range, note }: { devices: DemoBreakdownRow[] | null; currency: string; demo: boolean; range: { from: string; to: string }; note: string | null }) {
  const w = figureWriters(currency);
  return (
    <Section id="devices" title="Device analytics" help={`${fmtSpan(range.from, range.to)}: impressions, clicks, spend and conversions by the device the ads were seen on.`} demo={demo}>
      {devices ? <SplitTable rows={devices} w={w} what="Device" testid="ga-devices-table" /> : <p className="text-sm text-muted">{note ?? "No device split for this account."}</p>}
    </Section>
  );
}

/** Section 6: aggregated audience splits (age groups, countries, audience segments, devices): nothing about any person. */
export function AudienceSection({ audience, currency, demo, range }: { audience: GoogleAdsAnalytics["audience"]; currency: string; demo: boolean; range: { from: string; to: string } }) {
  const w = figureWriters(currency);
  const parts: Array<{ id: string; title: string; what: string; rows: DemoBreakdownRow[] | null }> = [
    { id: "age", title: "Age groups", what: "Age group", rows: audience.age },
    { id: "countries", title: "Geographical regions", what: "Country", rows: audience.countries },
    { id: "segments", title: "Audience segments", what: "Segment", rows: audience.segments },
    { id: "devices", title: "Device categories", what: "Device", rows: audience.devices },
  ];
  return (
    <Section id="audience" title="Audience analytics" help={`${fmtSpan(range.from, range.to)}. ${audience.note ?? ""}`} demo={demo}>
      <div className="space-y-5">
        {parts.map((p) => (
          <div key={p.id}>
            <h3 className="mb-2 text-sm font-semibold">{p.title}</h3>
            {p.rows ? <SplitTable rows={p.rows} w={w} what={p.what} testid={`ga-audience-${p.id}`} /> : <p className="text-sm text-muted">Not available for this account.</p>}
          </div>
        ))}
      </div>
    </Section>
  );
}
