"use client";

import { useRef, type ReactNode } from "react";
import { IconUsers } from "@/components/ui/icons";

// Everything that CHANGES one account, behind a single "Manage" button: the
// sign-in name, the role, confirming the email, and switching the account off or
// on. Kept out of the row so the table reads as a directory -- who, what role,
// which clients -- rather than as a form with a field on every line.
//
// A native <dialog>, like ClientAccess: the top layer is not clipped by the
// table's own horizontal scroll.

export function ManageAccount({
  personLabel,
  email,
  usernameForm,
  role,
  confirm,
  danger,
}: {
  personLabel: string;
  email: string;
  /** The username field, as a server-action form. */
  usernameForm: ReactNode;
  /** The role picker, or a note on why it cannot be changed. */
  role: ReactNode;
  /** Confirm-email action, where the email is not yet confirmed. */
  confirm?: ReactNode;
  /** Deactivate / reactivate / delete, where the account can be changed. */
  danger?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button type="button" className="btn btn-secondary btn-xs" onClick={() => dialog.current?.showModal()}>
        Manage
      </button>

      <dialog ref={dialog} className="modal">
        <div className="modal-header">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-soft text-link">
            <IconUsers />
          </span>
          <div className="min-w-0">
            <p className="modal-title truncate">{personLabel}</p>
            {/* The email under the name -- unless the name IS the email. */}
            {email !== personLabel && <p className="truncate text-xs text-muted-foreground">{email}</p>}
          </div>
        </div>

        <div className="flex flex-col gap-5 px-5 py-5">
          <section className="flex flex-col gap-1.5">
            <p className="field-label">Username</p>
            {usernameForm}
            <p className="text-xs text-muted-foreground">What they sign in with. Without one they sign in by email.</p>
          </section>

          <section className="flex flex-col gap-1.5">
            <p className="field-label">Role</p>
            {role}
          </section>

          {confirm && (
            <section className="flex flex-col gap-1.5">
              <p className="field-label">Email</p>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-xs">
                <span>Not confirmed yet, so they cannot sign in.</span>
                {confirm}
              </div>
            </section>
          )}

          {danger && (
            <section className="flex flex-col gap-1.5 border-t border-border pt-4">
              <p className="field-label">Account</p>
              <div className="flex flex-wrap items-center gap-2">{danger}</div>
            </section>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary btn-sm ml-auto" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </div>
      </dialog>
    </>
  );
}
