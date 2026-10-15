"use client";
import { Eye, EyeOff } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * A password input with a show/hide toggle (a real button, so it works from the keyboard).
 * `icon` sits inside the field on the left; `inputClassName` replaces the standard input style.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  required = true,
  minLength,
  icon,
  inputClassName = "input pr-11",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: "current-password" | "new-password";
  hint?: string;
  required?: boolean;
  minLength?: number;
  icon?: ReactNode;
  inputClassName?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {/* The padding `auth-field` leaves for the icon and the toggle (the standard input has its own pr-11). */}
      <div className={`relative [--auth-field-pr:2.75rem] ${icon ? "[--auth-field-pl:2.75rem]" : ""}`}>
        {icon && <span className="pointer-events-none absolute inset-y-0 left-0 flex w-11 items-center justify-center text-muted">{icon}</span>}
        <input
          id={id}
          className={inputClassName}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          maxLength={256}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff size={icon ? 18 : 16} aria-hidden /> : <Eye size={icon ? 18 : 16} aria-hidden />}
        </button>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}
