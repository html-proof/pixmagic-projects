"use client";
import { Mail, RotateCw } from "lucide-react";
import { ErrorPanel } from "@/components/ErrorState";
import { CONTACT } from "@/lib/contact";

/**
 * What CloudFront shows, with a 503 and at the address asked for, for any page while the server
 * can't answer it (down, timing out, out of capacity): the AWS build moves this page out of the
 * server's files into the site bucket (apps/aws/scripts/build.mjs, infra/cdk/lib/app-stack.ts), so it
 * has no address of its own there. Its styles and scripts come from that bucket too. Support is a
 * mail link: /support is one of the pages that can't load.
 */
export default function Unavailable() {
  return <ErrorPanel kind="unavailable" code="503" title="Service temporarily unavailable" body="bizinsights can't load this page right now. This is on our side, not yours. Please try again in a few minutes." fullPage>
    <button type="button" className="btn-primary px-5 py-2.5" onClick={() => window.location.reload()}><RotateCw aria-hidden className="size-4" />Try again</button>
    <a className="btn-secondary px-5 py-2.5" href={`mailto:${CONTACT.supportEmail}`}><Mail aria-hidden className="size-4" />Email support</a>
  </ErrorPanel>;
}
