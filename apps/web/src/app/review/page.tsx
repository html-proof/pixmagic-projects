"use client";
import { useEffect, useId, useState } from "react";
import { api, ApiError, actionError } from "@/lib/apiClient";
import { PublicLinkError } from "@/components/PublicLinkError";

// ---------------------------------------------------------------------------
// The customer's review form, linked from the delivered / review-request messages. One review of
// the order as a whole and one per product, tied to the real order the link belongs to; sending
// it again edits it. Honest feedback either way: nothing is offered in return.
// ---------------------------------------------------------------------------

interface Form {
  store: { name: string };
  order: { name: string; placedAt: string; deliveredAt: string | null; cancelled: boolean };
  products: Array<{ productId: string; title: string }>;
  existing: Array<{ productId: string; rating: number; body: string; reviewerName: string }>;
  canEdit: boolean;
}

interface Entry {
  rating: number;
  body: string;
}

function StarInput({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const name = useId();
  return (
    <fieldset>
      <legend className="sr-only">{label}</legend>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className="cursor-pointer">
            <input type="radio" name={name} value={n} className="peer sr-only" checked={value === n} onChange={() => onChange(n)} />
            <span
              aria-hidden
              className={`block text-3xl leading-none transition peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent ${n <= value ? "text-[#e3a008]" : "text-muted/45"}`}
            >
              ★
            </span>
            <span className="sr-only">
              {n} star{n === 1 ? "" : "s"}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function ReviewPage() {
  const [token, setToken] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"published" | "pending" | null>(null);

  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoadError(null);
    const t = new URLSearchParams(window.location.search).get("t");
    if (!t) {
      setLoadError(new ApiError(410, "expired_link", ""));
      return;
    }
    setToken(t);
    api<Form>(`/public/review/${encodeURIComponent(t)}`, { credentials: "omit", referrerPolicy: "no-referrer" })
      .then((f) => {
        if (!live) return;
        setForm(f);
        setEntries(Object.fromEntries(f.existing.map((e) => [e.productId, { rating: e.rating, body: e.body }])));
        setName(f.existing[0]?.reviewerName ?? "");
      })
      .catch((error: unknown) => { if (live) setLoadError(error); });
    return () => { live = false; };
  }, [attempt]);

  const submit = async () => {
    if (!token) return;
    const reviews = Object.entries(entries)
      .filter(([, e]) => e.rating > 0)
      .map(([productId, e]) => ({ productId, rating: e.rating, body: e.body }));
    if (!reviews.length) {
      setError("Choose a star rating first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ status: string }>(`/public/review/${encodeURIComponent(token)}`, {
        method: "POST", credentials: "omit", referrerPolicy: "no-referrer", body: { reviewerName: name, reviews },
      });
      setDone(body.status === "published" ? "published" : "pending");
    } catch (e) {
      setError(actionError(e, "send your review"));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
        <div className="card text-center">
          <p className="text-4xl" aria-hidden>
            ❤️
          </p>
          <h1 className="mt-2 text-xl font-semibold">Thank you for your review</h1>
          <p className="mt-2 text-sm text-muted">
            {done === "published" ? `It's now visible on ${form?.store.name}.` : `${form?.store.name} will publish it shortly.`} You can change it from the same link.
          </p>
        </div>
      </main>
    );
  }
  if (!form) {
    return (
      <main className="mx-auto max-w-md space-y-3 px-4 py-10" aria-busy={!loadError}>
        {loadError ? (
          <PublicLinkError error={loadError} onRetry={() => setAttempt((n) => n + 1)} />
        ) : (
          <>
            <div className="skeleton h-8 w-2/3" />
            <div className="skeleton h-48" />
          </>
        )}
      </main>
    );
  }

  const set = (id: string, patch: Partial<Entry>) => setEntries((e) => ({ ...e, [id]: { rating: e[id]?.rating ?? 0, body: e[id]?.body ?? "", ...patch } }));
  const closed = form.order.cancelled || !form.canEdit;

  return (
    <main className="mx-auto max-w-md space-y-4 px-4 py-8">
      <header>
        <p className="text-sm font-medium text-muted">{form.store.name}</p>
        <h1 className="mt-1 text-2xl font-semibold">How was your order?</h1>
        <p className="mt-1 text-sm text-muted">Order {form.order.name}. Good or bad, your honest opinion helps other customers and the store.</p>
      </header>

      {closed ? (
        <div className="card text-sm text-muted">{form.order.cancelled ? "This order was cancelled, so it can't be reviewed." : "Reviews for this order can no longer be changed."}</div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <section className="card space-y-3">
            <h2 className="font-semibold">Your order overall</h2>
            <StarInput label="Rating for the order overall" value={entries[""]?.rating ?? 0} onChange={(n) => set("", { rating: n })} />
            <div>
              <label className="label" htmlFor="rv-body">
                Tell us more <span className="font-normal text-muted">(optional)</span>
              </label>
              <textarea id="rv-body" className="input min-h-24" maxLength={2000} value={entries[""]?.body ?? ""} onChange={(e) => set("", { body: e.target.value })} placeholder="Delivery, packaging, quality…" />
            </div>
          </section>

          {form.products.length > 0 && (
            <section className="card space-y-4">
              <h2 className="font-semibold">
                The products <span className="text-sm font-normal text-muted">(optional)</span>
              </h2>
              {form.products.map((p) => (
                <div key={p.productId} className="space-y-2 border-t border-border pt-3 first:border-0 first:pt-0">
                  <p className="text-sm font-medium">{p.title}</p>
                  <StarInput label={`Rating for ${p.title}`} value={entries[p.productId]?.rating ?? 0} onChange={(n) => set(p.productId, { rating: n })} />
                  {(entries[p.productId]?.rating ?? 0) > 0 && (
                    <textarea
                      aria-label={`Comment about ${p.title}`}
                      className="input min-h-20"
                      maxLength={2000}
                      value={entries[p.productId]?.body ?? ""}
                      onChange={(e) => set(p.productId, { body: e.target.value })}
                      placeholder="What did you think of it?"
                    />
                  )}
                </div>
              ))}
            </section>
          )}

          <section className="card space-y-2">
            <label className="label" htmlFor="rv-name">
              Name to show with your review <span className="font-normal text-muted">(optional)</span>
            </label>
            <input id="rv-name" className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Asha K." autoComplete="given-name" />
            <p className="text-xs text-muted">Leave it empty to post anonymously. Please don&apos;t include phone numbers or addresses in your review.</p>
          </section>

          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? "Sending…" : form.existing.length ? "Update my review" : "Send my review"}
          </button>
          <p className="text-center text-xs text-muted">Reviews are never paid for or rewarded. The store may only remove a review that is abusive, spam or off-topic.</p>
        </form>
      )}
    </main>
  );
}
