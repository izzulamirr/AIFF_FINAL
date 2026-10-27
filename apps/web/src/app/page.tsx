import Link from "next/link";
import { BRAND_FULL_NAME, BRAND_NAME } from "@/components/ui/Brand";
import { BrandMark, IconArrowRight } from "@/components/ui/icons";

export default function Home() {
  return (
    <div className="blueprint relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden p-6 text-center text-sidebar-foreground">
      <div className="relative flex flex-col items-center gap-6">
        <BrandMark size={52} />
        <div>
          <h1 className="text-4xl font-semibold tracking-[0.08em] text-sidebar-strong sm:text-5xl">{BRAND_NAME}</h1>
          <p className="mt-2 text-sm tracking-wide text-sidebar-muted">{BRAND_FULL_NAME}</p>
          <p className="mx-auto mt-5 max-w-md text-base leading-relaxed">
            Cross-document engineering review of P&amp;IDs, isometrics, hook-up and cutting drawings.
          </p>
        </div>
        <Link href="/login" className="btn btn-primary h-11 px-6 text-[0.9375rem]">
          Sign in
          <IconArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
}
