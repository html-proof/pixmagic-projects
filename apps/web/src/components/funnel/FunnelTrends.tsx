"use client";
import { useState } from "react";
import { FUNNEL_STEPS } from "@app/shared/journey";
import { ChartChoice, Empty } from "@/components/dashboard/Primitives";
import { LineChart, type LineSeries } from "@/components/dashboard/LineChart";
import type { FunnelPageModule } from "@/components/dashboard/types";
import { fmtNum, fmtPct } from "@/lib/api";
import { count, FunnelSection } from "./FunnelUi";
import { STAGES } from "./stageGuide";

type Grain = "day" | "week";
type Measure = "visits" | "share";

/** Days past which the chart groups them into weeks, so a long range stays readable. */
const WEEKS_FROM = 93;

/** The days, or weeks of seven days from the first, with visits reached per step added up (null: none of its days recorded). */
function periods(daily: FunnelPageModule["daily"], grain: Grain) {
  if (grain === "day") return daily;
  const out: FunnelPageModule["daily"] = [];
  for (let i = 0; i < daily.length; i += 7) {
    const week = daily.slice(i, i + 7);
    const known = week.filter((d) => d.reached);
    out.push({ day: week[0]!.day, reached: known.length ? FUNNEL_STEPS.map((_, k) => known.reduce((a, d) => a + d.reached![k]!, 0)) : null });
  }
  return out;
}

const COLORS = ["var(--viz-cat-1)", "var(--viz-cat-2)", "var(--viz-cat-3)", "var(--viz-tier-2)", "var(--viz-total)"];

/**
 * How the funnel changed over the dates: visits reaching each stage (or each stage's share of the
 * visits) day by day, and the conversion rate. Days before visits were counted are gaps, never 0.
 */
export function FunnelTrends({ f, today }: { f: FunnelPageModule; today: string }) {
  const long = f.daily.length >= WEEKS_FROM;
  const [grainChoice, setGrain] = useState<Grain>("day");
  const [measure, setMeasure] = useState<Measure>("visits");
  const grain: Grain = long ? "week" : grainChoice;
  const rows = periods(f.daily, grain);
  const days = rows.map((d) => d.day);
  const any = rows.some((d) => d.reached && d.reached[0]! > 0);
  const series: LineSeries[] = FUNNEL_STEPS.map((step, k) => ({
    key: step,
    label: STAGES[step].name,
    color: COLORS[k]!,
    values: rows.map((d) => (!d.reached ? null : measure === "visits" ? d.reached[k]! : d.reached[0]! > 0 ? d.reached[k]! / d.reached[0]! : null)),
  }));
  const conversion: LineSeries[] = [
    { key: "conversion", label: "Conversion rate", color: "var(--viz-cat-1)", values: rows.map((d) => (d.reached && d.reached[0]! > 0 ? d.reached[4]! / d.reached[0]! : null)) },
    { key: "checkout", label: "Checkout completion", color: "var(--viz-cat-2)", values: rows.map((d) => (d.reached && d.reached[3]! > 0 ? d.reached[4]! / d.reached[3]! : null)) },
  ];
  const note = grain === "week" ? "Each point is the seven days from the date shown." : "Each point is one day; today's is still running.";
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <FunnelSection
        id="trend"
        title="Funnel trend over time"
        sub="How many visits reached each stage, so you can see whether a change at one stage came from more visits or from a different share going on."
        aside={
          <>
            <ChartChoice<Measure> label="Show" value={measure} options={[["visits", "Visits (count)"], ["share", "Share of visits (%)"]]} onChange={setMeasure} />
            {!long && <ChartChoice<Grain> label="Group by" value={grainChoice} options={[["day", "Daily"], ["week", "Weekly"]]} onChange={setGrain} />}
          </>
        }
      >
        {any ? (
          <>
            <LineChart
              days={days}
              series={series}
              label={`${measure === "visits" ? "Visits" : "Share of visits"} reaching each stage, ${grain === "week" ? "week" : "day"} by ${grain === "week" ? "week" : "day"}`}
              format={(v) => (measure === "visits" ? count(v, "visit") : fmtPct(v))}
              fmtAxis={(v) => (measure === "visits" ? fmtNum(v) : fmtPct(v))}
              integer={measure === "visits"}
              today={grain === "day" ? today : undefined}
              height={220}
              grid
            />
            <p className="mt-2 text-xs text-muted">
              Vertical axis: {measure === "visits" ? "tracked visits" : "share of the day's visits"}. Horizontal axis: date. {note}
            </p>
          </>
        ) : (
          <Empty>No visits recorded in these dates to chart.</Empty>
        )}
      </FunnelSection>
      <FunnelSection id="conversion-trend" title="Conversion rate trend" sub="Whether the share of visits that buy is improving or declining, with how often a started checkout is completed.">
        {any ? (
          <>
            <LineChart
              days={days}
              series={conversion}
              label={`Conversion rate and checkout completion, ${grain === "week" ? "week" : "day"} by ${grain === "week" ? "week" : "day"}`}
              format={fmtPct}
              fmtAxis={(v) => fmtPct(v)}
              today={grain === "day" ? today : undefined}
              height={220}
              grid
            />
            <p className="mt-2 text-xs text-muted">
              Vertical axis: percentage. Conversion rate = visits that bought ÷ visits; checkout completion = visits that bought ÷ visits that started checkout. A day without visits (or checkouts) is a gap. {note}
            </p>
          </>
        ) : (
          <Empty>No visits recorded in these dates to chart.</Empty>
        )}
      </FunnelSection>
    </div>
  );
}
