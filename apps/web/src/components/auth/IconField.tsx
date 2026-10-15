import { Mail } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";

/** A labelled input in the split auth pages' style (`auth-field`), with an icon inside on the left. */
export function IconField({ id, label, icon, ...input }: { id: string; label: string; icon: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="relative [--auth-field-pl:2.75rem]">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex w-11 items-center justify-center text-muted">{icon}</span>
        <input id={id} className="auth-field" {...input} />
      </div>
    </div>
  );
}

export function EmailField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
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
    />
  );
}
