import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { IconGauge, IconUpload } from "@/components/ui/icons";
import { Alert } from "@/components/ui/primitives";
import { signup } from "./actions";

export const metadata: Metadata = { title: "Create account" };

// What each kind of account can do, said on the page so nobody signs up
// expecting the other. There is no choice to make here: every account starts as
// a User, and Document Control is assigned separately (see lib/roles.ts).
const ACCESS = [
  {
    icon: IconUpload,
    title: "Document Control (DCC)",
    text: "Uploads and manages every drawing and document, and sets up the projects.",
  },
  {
    icon: IconGauge,
    title: "User",
    text: "Reviews the extracted data: spooling, instrument hook-up, container check and cutting plans.",
  },
];

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; name?: string; username?: string; email?: string }>;
}) {
  const params = await searchParams;

  return (
    <AuthShell
      panel={
        <>
          <h2 className="text-4xl font-semibold leading-tight tracking-tight text-sidebar-strong">Two kinds of account</h2>
          <p className="mt-4 text-base leading-relaxed">Document Control puts the drawings in; everyone else checks what comes out.</p>
          <ul className="mt-8 flex flex-col gap-4">
            {ACCESS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex items-start gap-4 rounded-xl border border-sidebar-border bg-white/[0.03] p-4">
                <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-sidebar-active text-sidebar-accent">
                  <Icon size={20} />
                </span>
                <div>
                  <p className="font-medium text-sidebar-strong">{title}</p>
                  <p className="mt-1 text-sm leading-relaxed">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      }
    >
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">New accounts have User access: you can review the data but not upload documents.</p>

      <div className="mt-6 flex flex-col gap-3 empty:hidden">{params.error && <Alert tone="danger">{params.error}</Alert>}</div>

      <form action={signup} className="mt-6 flex flex-col gap-4">
        <div>
          <label htmlFor="name" className="field-label">
            Full name
          </label>
          <input id="name" name="name" required autoComplete="name" defaultValue={params.name ?? ""} className="input h-10" />
        </div>
        <div>
          <label htmlFor="username" className="field-label">
            Username
          </label>
          <input
            id="username"
            name="username"
            required
            minLength={3}
            maxLength={32}
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,31}"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={params.username ?? ""}
            className="input h-10"
          />
          <p className="field-hint">What you sign in with. Letters, digits, dot, dash or underscore.</p>
        </div>
        <div>
          <label htmlFor="email" className="field-label">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            defaultValue={params.email ?? ""}
            className="input h-10"
          />
        </div>
        <div>
          <label htmlFor="password" className="field-label">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="input h-10"
          />
          <p className="field-hint">At least 8 characters.</p>
        </div>
        <div>
          <label htmlFor="confirm" className="field-label">
            Confirm password
          </label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="input h-10"
          />
        </div>
        <button className="btn btn-primary mt-2 h-10 w-full">Create account</button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="link font-medium">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
