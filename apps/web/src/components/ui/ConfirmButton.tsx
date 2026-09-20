"use client";

import type { ReactNode } from "react";

// A submit button that asks first. The form around it stays a server-rendered
// form with a server action; this only stops the submit if the answer is no.
// For changes worth a second thought -- who gets to upload and delete, say.
export function ConfirmButton({ message, className, children }: { message: string; className?: string; children: ReactNode }) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
