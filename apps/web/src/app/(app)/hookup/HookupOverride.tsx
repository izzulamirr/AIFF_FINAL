"use client";

import { useRouter, useSearchParams } from "next/navigation";

// Lets a reviewer pin a different typical to one instrument when the
// automatic match (ISA variable + line service) picks the wrong sheet --
// hook-up sets are titled inconsistently between projects, so the match is a
// good default rather than a guarantee. The choice is carried in the URL as
// hk_<tag>, so a verified view can be linked and re-opened as-is.
export function HookupOverride({
  instrumentTag,
  selectedKey,
  sheets,
}: {
  instrumentTag: string;
  selectedKey: string;
  sheets: Array<{ key: string; label: string }>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const onChange = (value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(`hk_${instrumentTag}`, value);
    else next.delete(`hk_${instrumentTag}`);
    router.push(`/hookup?${next.toString()}`);
  };

  return (
    <label className="text-xs text-gray-600">
      Use typical:{" "}
      <select value={selectedKey} onChange={(e) => onChange(e.target.value)} className="rounded border px-2 py-1 text-xs">
        <option value="">-- automatic --</option>
        {sheets.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  );
}
