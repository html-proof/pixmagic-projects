"use client";
import { useState, type InputHTMLAttributes } from "react";
export function ValidatedInput(props: InputHTMLAttributes<HTMLInputElement> & { id: string }) {
  const [error, setError] = useState("");
  const errorId = `${props.id}-error`;
  return <><input {...props} aria-invalid={error ? true : undefined} aria-describedby={error ? [props["aria-describedby"], errorId].filter(Boolean).join(" ") : props["aria-describedby"]}
    onInvalid={(event) => { setError(event.currentTarget.validity.valueMissing ? "This field is required." : event.currentTarget.validity.tooShort ? `Use at least ${event.currentTarget.minLength} characters.` : event.currentTarget.type === "email" ? "Enter a valid email address." : "Check this field's format and try again."); props.onInvalid?.(event); }}
    onChange={(event) => { if (event.currentTarget.validity.valid) setError(""); props.onChange?.(event); }} />
    {error && <p id={errorId} className="mt-1 text-sm text-danger" role="alert">{error}</p>}</>;
}
