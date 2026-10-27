import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { BRAND_NAME } from "@/components/ui/Brand";
import { IconCheckCircle } from "@/components/ui/icons";
import { Alert } from "@/components/ui/primitives";
import { login } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

const POINTS = [
  "Structured data extracted from P&IDs, isometrics and hook-up drawings",
  "Bills of material and design basis verified across documents",
  "Spooling, container loading and plate nesting planned from the drawings",
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;

  return (
    <AuthShell
      panel={
        <>
          <h2 className="text-4xl font-semibold leading-tight tracking-tight text-sidebar-strong">Cross-document engineering review</h2>
          <p className="mt-4 text-base leading-relaxed">
            Project drawings and documents are read, cross-checked and reported, ready for the checker&apos;s review.
          </p>
          <ul className="mt-8 flex flex-col gap-3.5">
            {POINTS.map((point) => (
              <li key={point} className="flex items-start gap-3 text-sm leading-relaxed">
                <IconCheckCircle size={18} className="mt-0.5 flex-none text-sidebar-accent" />
                {point}
              </li>
            ))}
          </ul>
        </>
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to {BRAND_NAME}</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">Enter your username and password to continue.</p>

      <div className="mt-6 flex flex-col gap-3 empty:hidden">
        {params.error && <Alert tone="danger">{params.error}</Alert>}
        {params.message && <Alert tone="info">{params.message}</Alert>}
      </div>

      <form action={login} className="mt-6 flex flex-col gap-4">
        <div>
          <label htmlFor="username" className="field-label">
            Username
          </label>
          <input
            id="username"
            name="username"
            required
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            className="input h-10"
          />
          <p className="field-hint">No username yet? Sign in with your email address.</p>
        </div>
        <div>
          <label htmlFor="password" className="field-label">
            Password
          </label>
          <input id="password" name="password" type="password" required minLength={8} className="input h-10" />
        </div>
        <button className="btn btn-primary mt-2 h-10 w-full">Sign in</button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        No account yet?{" "}
        <Link href="/signup" className="link font-medium">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
