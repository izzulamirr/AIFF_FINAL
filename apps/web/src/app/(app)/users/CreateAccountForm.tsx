"use client";

import { useRef, useState, useTransition } from "react";
import type { AppRole } from "@/lib/roles";
import type { CreateAccountResult } from "./actions";
import type { ClientOption } from "./ClientAccess";

// Add a person: their account is created already confirmed, with its role and
// clients set, so they can sign in as soon as they are given the username and
// password. Folded away until asked for -- the table below is what this page is
// mostly for.

// No 0/O or 1/l/I: the password is read out or copied by hand.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function CreateAccountForm({
  roles,
  clients,
  createAccount,
}: {
  roles: Array<{ value: AppRole; label: string }>;
  clients: ClientOption[];
  createAccount: (formData: FormData) => Promise<CreateAccountResult>;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [result, setResult] = useState<CreateAccountResult | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setResult(null);
    startTransition(async () => {
      try {
        const outcome = await createAccount(formData);
        setResult(outcome);
        if (outcome.ok) {
          form.current?.reset();
          setPassword("");
          setShowPassword(false);
        }
      } catch (err) {
        setResult({ ok: false, message: err instanceof Error ? err.message : "The account was not created." });
      }
    });
  }

  return (
    <section className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">Add a user</h2>
          <p className="card-description">Created already confirmed: no confirmation email, and they can sign in straight away.</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm ml-auto" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Add user"}
        </button>
      </div>

      {open && (
        <form ref={form} action={submit} className="flex flex-col gap-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className="field-label">Full name</span>
              <input name="name" required autoComplete="off" className="input" />
            </label>
            <label>
              <span className="field-label">Username</span>
              <input name="username" required minLength={3} maxLength={32} autoCapitalize="none" spellCheck={false} autoComplete="off" className="input" />
              <span className="field-hint">What they sign in with. Letters, digits, dot, dash or underscore.</span>
            </label>
            <label>
              <span className="field-label">Email</span>
              <input name="email" type="email" required autoComplete="off" className="input" />
            </label>
            <div>
              <label htmlFor="new-account-password" className="field-label">
                Password
              </label>
              <div className="flex gap-2">
                <input
                  id="new-account-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input"
                />
                <button type="button" className="btn btn-secondary flex-none" onClick={() => setShowPassword((s) => !s)}>
                  {showPassword ? "Hide" : "Show"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary flex-none"
                  onClick={() => {
                    setPassword(generatePassword());
                    setShowPassword(true);
                  }}
                >
                  Generate
                </button>
              </div>
              <span className="field-hint">At least 8 characters. Give it to them yourself; nothing is emailed.</span>
            </div>
            <label>
              <span className="field-label">Role</span>
              <select name="role" defaultValue="user" className="input">
                {roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {clients.length > 0 && (
            <fieldset>
              <legend className="field-label">Clients they can see</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {clients.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="organizationId" value={c.id} />
                    {c.name}
                  </label>
                ))}
              </div>
              <span className="field-hint">Without any, they sign in to an empty app. This can be changed later.</span>
            </fieldset>
          )}

          {result && (
            <p role="status" className={`text-sm ${result.ok ? "text-success" : "text-danger"}`}>
              {result.message}
            </p>
          )}

          <div className="flex justify-end">
            <button type="submit" disabled={pending} className="btn btn-primary">
              {pending ? "Creating…" : "Create account"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
