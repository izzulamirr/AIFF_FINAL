"use client";

import { useActionState, useEffect, useRef } from "react";
import { IconUpload } from "@/components/ui/icons";
import { Alert } from "@/components/ui/primitives";
import { CATEGORY_LABEL, LIBRARY_ACCEPT, LIBRARY_CATEGORIES } from "@/lib/libraryKinds";
import { MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { addLibraryItem, type UploadState } from "./actions";

// Adds a file to one library. `projectId` empty means the overall library.
//
// A client component only so a rejected upload -- wrong file type, too large --
// shows its reason beside the button instead of on the framework's error page, and
// the form clears itself once a file has gone in.
export function LibraryUploadForm({
  organizationId,
  projectId,
  heading,
  description,
}: {
  organizationId: string;
  projectId?: string;
  heading: string;
  description: string;
}) {
  const [state, action, pending] = useActionState<UploadState, FormData>(addLibraryItem, {});
  const formRef = useRef<HTMLFormElement>(null);
  const suffix = projectId ?? "all";

  useEffect(() => {
    if (state.added) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="card flex flex-col gap-4">
      <div>
        <h2 className="card-title">{heading}</h2>
        <p className="card-description">{description}</p>
      </div>

      <input type="hidden" name="organizationId" value={organizationId} />
      {projectId && <input type="hidden" name="projectId" value={projectId} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`category-${suffix}`} className="field-label">
            Kind of file
          </label>
          <select id={`category-${suffix}`} name="category" required defaultValue="" className="input">
            <option value="" disabled>
              Choose…
            </option>
            {LIBRARY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`title-${suffix}`} className="field-label">
            Title <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input id={`title-${suffix}`} name="title" type="text" maxLength={200} placeholder="Defaults to the file name" className="input" />
        </div>
      </div>

      <div>
        <label htmlFor={`description-${suffix}`} className="field-label">
          Note <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input id={`description-${suffix}`} name="description" type="text" maxLength={500} placeholder="Revision, what it covers…" className="input" />
      </div>

      <div>
        <label htmlFor={`file-${suffix}`} className="field-label">
          File <span className="font-normal text-muted-foreground">(max {MAX_UPLOAD_MB} MB)</span>
        </label>
        <input id={`file-${suffix}`} type="file" name="file" accept={LIBRARY_ACCEPT} required className="input input-file" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn btn-primary" disabled={pending}>
          <IconUpload size={16} />
          {pending ? "Uploading…" : "Add to library"}
        </button>
        {state.added && !pending && <span className="text-sm text-success">Added &ldquo;{state.added}&rdquo;.</span>}
      </div>
      {state.error && !pending && <Alert tone="danger">{state.error}</Alert>}
    </form>
  );
}
