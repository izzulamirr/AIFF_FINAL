"use client";

import { useState } from "react";
import { LIBRARY_UPLOAD_KINDS, acceptFor, formatHintFor } from "@/lib/docTypes";
import { MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { IconUpload } from "@/components/ui/icons";

// Uploading the reference a project's checks are made AGAINST.
//
// These are `documents` rows and they ARE extracted -- the P&ID legend teaches
// P&ID symbol reading, the line list is what every ISO's design basis is checked
// against. They sit in the library because that is what they are to a person:
// material you set up once for a project and then stop thinking about, unlike
// the ISOs which arrive continuously. Nothing about how they are read changed.
//
// A SELECT here, where the project page uses two cards: six options is past the
// number a row of cards can carry without becoming the whole page, and each type
// still gets its sentence -- underneath, for whichever one is chosen.
export function ReferenceUploadCard({ action }: { action: (formData: FormData) => Promise<void> }) {
  const [kindKey, setKindKey] = useState<string>(LIBRARY_UPLOAD_KINDS[0].key);
  const chosen = LIBRARY_UPLOAD_KINDS.find((k) => k.key === kindKey) ?? LIBRARY_UPLOAD_KINDS[0];

  return (
    <form action={action} className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">Add reference for this project</h2>
          <p className="card-description">Read as soon as it arrives, and used by every check on this project&apos;s ISOs.</p>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="sm:w-56">
            <label htmlFor="ref-docType" className="field-label">
              Document type
            </label>
            <select
              id="ref-docType"
              name="uploadKind"
              required
              value={kindKey}
              onChange={(e) => setKindKey(e.target.value)}
              className="input"
            >
              {LIBRARY_UPLOAD_KINDS.map((type) => (
                <option key={type.key} value={type.key}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-0 flex-1">
            <label htmlFor="ref-file" className="field-label">
              {formatHintFor(chosen)} file <span className="font-normal text-muted-foreground">(max {MAX_UPLOAD_MB} MB)</span>
            </label>
            {/* Keyed by type: changing the type clears a file already picked,
                rather than leaving one the new type will refuse. */}
            <input
              key={chosen.key}
              id="ref-file"
              type="file"
              name="file"
              accept={acceptFor(chosen)}
              required
              className="input input-file"
            />
          </div>
        </div>

        {/* The chosen type's own sentence. The legend's carries an ORDER -- put
            it in before the P&IDs -- which is the one instruction here that
            costs a re-extraction if it is missed. */}
        <p className="text-xs leading-relaxed text-muted-foreground">{chosen.hint}</p>

        <button className="btn btn-primary self-start">
          <IconUpload size={16} />
          Upload {chosen.label}
        </button>
      </div>
    </form>
  );
}
