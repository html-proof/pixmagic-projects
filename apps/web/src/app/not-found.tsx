import { ErrorState } from "@/components/ErrorState";

/** Exported as 404.html, which the server answers for any path with no page (apps/aws/src/staticSite.ts). */
export default function NotFound() {
  return <ErrorState kind="notFound" fullPage />;
}
