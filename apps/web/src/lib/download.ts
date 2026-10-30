import { contextHeaders } from "./apiClient";
import { ApiError, apiFailure, readApiResponse, UNREACHABLE } from "./apiResponse";

/**
 * Save a file the API answers (a CSV download) under the name it gives, as this tab's session (the
 * account's, or a shared dashboard's). A refusal throws an ApiError with the API's own code, as api()
 * does, so the page can say why (or, for a live report no longer kept, read it again and retry).
 */
export async function saveApiFile(path: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: "same-origin", headers: contextHeaders() });
  } catch {
    throw new ApiError(0, "network", UNREACHABLE);
  }
  if (!res.ok) throw apiFailure(res.status, await readApiResponse(res));
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "bizinsights.csv";
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
