import Link from "next/link";
import { BrandMark, IconArrowRight } from "@/components/ui/icons";

export default function Home() {
  return (
    <div className="blueprint relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden p-6 text-center text-sidebar-foreground">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(55% 45% at 50% 0%, rgba(59,130,246,0.22), transparent 70%)" }}
      />
      <div className="relative flex flex-col items-center gap-6">
        <BrandMark size={52} />
        <div>
          <h1 className="text-4xl font-semibold tracking-tight text-sidebar-strong sm:text-5xl">EASY</h1>
          <p className="mx-auto mt-4 max-w-md text-base leading-relaxed">
            AI-powered cross-document engineering review &mdash; P&amp;ID, H&amp;MB, PFD, and spec sheet consistency checking.
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
