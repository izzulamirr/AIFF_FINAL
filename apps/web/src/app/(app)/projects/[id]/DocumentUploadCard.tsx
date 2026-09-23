"use client";

import Link from "next/link";
import { useState } from "react";
import { PROJECT_UPLOAD_KINDS, acceptFor, formatHintFor } from "@/lib/docTypes";
import { MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { IconArrowRight, IconLibrary, IconUpload } from "@/components/ui/icons";

// What a project takes in: the two things being checked.
//
// The type is CHOSEN AS A CARD, not from a dropdown. With seven options a select
// was the only sensible control; with two, a select hides half the choice behind
// a click and gives neither option room to say what it is for. Laid out side by
// side, each carries its own sentence, and which one you want is obvious before
// you touch anything.
//
// A client component for one reason: the selected type changes the wording on
// the file input and the button, so that the card reads as one instruction
// rather than as a form with a heading. The upload itself is the server action
// passed in.

export function DocumentUploadCard({ action, libraryHref }: { action: (formData: FormData) => Promise<void>; libraryHref: string }) {
  const [kindKey, setKindKey] = useState<string>(PROJECT_UPLOAD_KINDS[0].key);
  const chosen = PROJECT_UPLOAD_KINDS.find((k) => k.key === kindKey) ?? PROJECT_UPLOAD_KINDS[0];

  return (
    <form action={action} className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">Upload a document</h2>
          <p className="card-description">Drawings and tables are read as soon as they arrive.</p>
        </div>

        {/* Where the OTHER kinds went. Somebody looking for "P&ID" on this page
            needs to be told, not left to conclude the app cannot take one. */}
        <Link href={libraryHref} className="group ml-auto flex items-center gap-1.5 text-[0.8125rem] font-medium text-link">
          P&amp;IDs, legends and line lists
          <IconArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      <div className="flex flex-col gap-5 p-5">
        <fieldset className="flex flex-col gap-2.5">
          <legend className="field-label mb-2.5">Document type</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {PROJECT_UPLOAD_KINDS.map((type) => {
              const active = type.key === kindKey;
              return (
                <label
                  key={type.key}
                  className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${
                    active ? "border-primary bg-primary-soft/50 shadow-sm" : "hover:border-border-strong hover:bg-muted/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="uploadKind"
                    value={type.key}
                    checked={active}
                    onChange={() => setKindKey(type.key)}
                    className="sr-only"
                  />
                  <span
                    className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] transition ${
                      active ? "border-primary" : "border-input"
                    }`}
                    aria-hidden="true"
                  >
                    {active && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                  <span className="min-w-0">
                    <span className={`flex items-center gap-2 text-sm font-medium ${active ? "text-link" : ""}`}>
                      {type.label}
                      {/* The format belongs on the CHOICE, not only beside the
                          file input: an admin pipe spec is XLSX only, and that
                          is worth knowing before picking the type rather than
                          after being refused. */}
                      <span className="badge badge-mono">{formatHintFor(type)}</span>
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{type.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            {/* Keyed by type, so choosing a different one clears a file already
                picked -- otherwise an XLSX stays selected under "ISO" and is
                refused on submit, which reads as the app losing the file. */}
            <label htmlFor="file" className="field-label">
              {formatHintFor(chosen)} file <span className="font-normal text-muted-foreground">(max {MAX_UPLOAD_MB} MB)</span>
            </label>
            <input key={chosen.key} id="file" type="file" name="file" accept={acceptFor(chosen)} required className="input input-file" />
          </div>
          <button className="btn btn-primary flex-none">
            <IconUpload size={16} />
            Upload {chosen.label}
          </button>
        </div>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <IconLibrary size={13} className="flex-none" />
          Reading starts straight away; each document&apos;s progress shows in the table below.
        </p>
      </div>
    </form>
  );
}
