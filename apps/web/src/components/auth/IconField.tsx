import { Mail } from "lucide-react";
import type { FocusEvent, InputHTMLAttributes, ReactNode } from "react";

/**
 * A labelled input in the split auth pages' style (`auth-field`), with an icon inside on the left.
 * `error` (when set) marks it invalid and shows the problem underneath (see useFieldErrors).
 */
export function IconField({
  id,
  label,
  icon,
  error,
  ...input
}: { id: string; label: string; icon: ReactNode; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="relative [--auth-field-pl:2.75rem]">
        <span className={`pointer-events-none absolute inset-y-0 left-0 flex w-11 items-center justify-center ${error ? "text-danger" : "text-muted"}`}>{icon}</span>
        <input
          id={id}
          className={`auth-field ${error ? "border-danger" : ""}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          {...input}
        />
      </div>
      {error && <FieldError id={id}>{error}</FieldError>}
    </div>
  );
}

/** A field's problem, under it; the field points at it with aria-describedby `<id>-error`. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={`${id}-error`} className="mt-1.5 text-sm text-danger">
      {children}
    </p>
  );
}

export function EmailField({
  id,
  value,
  onChange,
  onBlur,
  error,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  error?: string | null;
}) {
  return (
    <IconField
      id={id}
      label="Email Address"
      icon={<Mail size={18} aria-hidden />}
      type="email"
      autoComplete="email"
      placeholder="you@company.com"
      required
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      error={error}
    />
  );
}
