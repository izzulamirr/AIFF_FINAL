import { BrandMark } from "./icons";

// The product's name, said in one place so every page, tab title and report
// carries the same one.
export const BRAND_NAME = "AIFF";
export const BRAND_FULL_NAME = "Artificial Intelligence for Fabrication";

/** The mark beside the name, with the full name under it where there is room. */
export function BrandLockup({
  size = 28,
  full = false,
  className = "",
  nameClassName = "",
  fullClassName = "text-muted-foreground",
}: {
  size?: number;
  /** Show "Artificial Intelligence for Fabrication" under the name. */
  full?: boolean;
  className?: string;
  nameClassName?: string;
  fullClassName?: string;
}) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <BrandMark size={size} />
      <span className="flex flex-col leading-tight">
        <span className={`font-semibold tracking-[0.08em] ${nameClassName}`}>{BRAND_NAME}</span>
        {full && <span className={`text-[0.6875rem] tracking-wide ${fullClassName}`}>{BRAND_FULL_NAME}</span>}
      </span>
    </span>
  );
}
