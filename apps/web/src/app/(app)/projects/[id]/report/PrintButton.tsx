"use client";

import { useEffect, useRef, useState } from "react";

// Print / save as PDF -- and, for a checker, issue the line's next check print in
// the same step: printing the report for the designer IS issuing CP-01, CP-02 ...
// or, with no errors left, Final (which marks the line done). `issueLabel` names it.
//
// The mark is made BEFORE the print dialog opens, and on the browser's own print
// (Ctrl+P, File > Print) as well as this button, so there is no way to print
// without marking. A browser does not say whether the dialog was then cancelled,
// so asking to print counts; a line marked by mistake is reopened from its page.
//
// A failed mark never blocks the print: the report is still wanted, and the
// reason is shown beside the button instead.
export function PrintButton({ markDone, issueLabel = "done" }: { markDone?: () => Promise<void>; issueLabel?: string }) {
  const marked = useRef(false);
  const [status, setStatus] = useState<string | null>(null);

  // Stable across renders so the print listener registered once always sees it.
  const markRef = useRef(markDone);
  useEffect(() => {
    markRef.current = markDone;
  }, [markDone]);

  async function mark() {
    const run = markRef.current;
    if (!run || marked.current) return;
    marked.current = true;
    try {
      await run();
      setStatus(`${issueLabel} issued.`);
    } catch (err) {
      marked.current = false;
      setStatus(err instanceof Error ? `Not issued: ${err.message}` : "Not issued.");
    }
  }

  useEffect(() => {
    const onBeforePrint = () => void mark();
    window.addEventListener("beforeprint", onBeforePrint);
    return () => window.removeEventListener("beforeprint", onBeforePrint);
  }, []);

  return (
    <span className="flex flex-wrap items-center justify-end gap-3">
      {markDone && (
        <span className={`text-xs ${status?.startsWith("Not") ? "text-danger" : "text-muted-foreground"}`}>
          {status ?? `Printing issues this report as ${issueLabel}.`}
        </span>
      )}
      <button
        type="button"
        onClick={async () => {
          await mark();
          window.print();
        }}
        className="btn btn-primary"
      >
        Print / save as PDF
      </button>
    </span>
  );
}
