"use client";

import { useRef, useState, useTransition } from "react";
import { IconBuilding, IconCheck } from "@/components/ui/icons";

// One person's organizations, in the users table.
//
// The cell itself stays a quiet list of names -- it is read far more often than
// it is changed, and a row of remove crosses and a dropdown on every line turned
// the table into a form. Changing it opens a panel: every organization Document
// Control can hand out, in one list, each either on or off.
//
// The panel is a native <dialog>. A popover would have been clipped by
// `.table-wrap`'s own horizontal scroll; the top layer is not.

export interface OrgOption {
  id: string;
  name: string;
}

export function OrganizationAccess({
  personLabel,
  isSelf,
  memberOf,
  assignable,
  setAccess,
}: {
  personLabel: string;
  /** Your own row: shown, never editable -- see the action for why. */
  isSelf: boolean;
  memberOf: OrgOption[];
  /** What Document Control may hand out: the organizations it is in itself. */
  assignable: OrgOption[];
  /** Bound to this account by the page. */
  setAccess: (organizationId: string, member: boolean) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);

  const isMember = (id: string) => memberOf.some((o) => o.id === id);
  // In an organization this account cannot hand out -- somebody else's, or one
  // Document Control has since left. Shown so the list is the whole truth, and
  // said to be unchangeable rather than quietly left out.
  const locked = memberOf.filter((o) => !assignable.some((a) => a.id === o.id));

  function toggle(organizationId: string, next: boolean) {
    setFailed(null);
    startTransition(async () => {
      try {
        await setAccess(organizationId, next);
      } catch (err) {
        setFailed(err instanceof Error ? err.message : "That did not save.");
      }
    });
  }

  return (
    <>
      <div className="flex items-center gap-3">
        {/* Plain text, not a row of pills: the Role column beside it is already
            a badge, and three more per row made the table read as a form. */}
        <p className={`min-w-0 text-sm${memberOf.length === 0 ? " text-muted-foreground" : ""}`}>
          {memberOf.length === 0 ? "No access" : memberOf.map((o) => o.name).join(", ")}
        </p>

        {!isSelf && assignable.length > 0 && (
          // `ml-auto` so the buttons line up down the column rather than sitting
          // ragged against names of different lengths. The column is no longer
          // given a minimum width, so it sizes to its widest row and the gap on
          // the shorter ones stays small.
          <button type="button" className="btn btn-ghost btn-xs ml-auto flex-none" onClick={() => dialog.current?.showModal()}>
            Change
          </button>
        )}
      </div>

      <dialog ref={dialog} className="modal" onClose={() => setFailed(null)}>
        <div className="modal-header">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-soft text-link">
            <IconBuilding />
          </span>
          <div className="min-w-0">
            <p className="modal-title">Organizations</p>
            <p className="truncate text-xs text-muted-foreground">{personLabel}</p>
          </div>
        </div>

        <p className="border-b px-5 py-3 text-xs leading-relaxed text-muted-foreground">
          They see the projects, drawings and library of the organizations switched on here, and nothing else.
        </p>

        <div className="modal-body">
          {assignable.map((o) => {
            const on = isMember(o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="switch"
                aria-checked={on}
                disabled={pending}
                className="option-row"
                onClick={() => toggle(o.id, !on)}
              >
                <span className="option-check">
                  <IconCheck size={13} strokeWidth={2.5} />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{o.name}</span>
                <span className="flex-none text-xs text-muted-foreground">{on ? "Has access" : "No access"}</span>
              </button>
            );
          })}
        </div>

        {locked.length > 0 && (
          <p className="border-t px-5 py-3 text-xs text-muted-foreground">
            Also in <span className="text-foreground">{locked.map((o) => o.name).join(", ")}</span> — you don&apos;t belong to
            {locked.length === 1 ? " it" : " those"}, so {locked.length === 1 ? "it is" : "they are"} not yours to change.
          </p>
        )}

        {failed && <p className="border-t px-5 py-3 text-xs text-danger">{failed}</p>}

        <div className="modal-footer">
          <span className="mr-auto text-xs text-muted-foreground">{pending ? "Saving…" : "Saved as you switch"}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </div>
      </dialog>
    </>
  );
}
