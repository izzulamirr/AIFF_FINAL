"use client";

import type { ButtonHTMLAttributes } from "react";
import { useFormStatus } from "react-dom";

// A form's submit button that shows the request is in flight.
//
// Every form in the app posts to a server action, and a plain <button> gives no
// sign anything happened until the page re-renders -- long enough on a slow
// action to click twice and submit twice. This disables itself and shows a small
// spinner while its own form is pending, and is otherwise exactly a <button>:
// same classes, same children.
//
// It must sit INSIDE the <form> it submits -- useFormStatus reads the nearest
// parent form.
export function SubmitButton({
  children,
  pendingLabel,
  className = "btn btn-primary",
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  /** What the button says while pending. Defaults to its normal label. */
  pendingLabel?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" {...rest} className={className} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending && (
        <svg className="h-3.5 w-3.5 flex-none animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
          <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      )}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
