"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { roleOf } from "@/lib/roles";

export async function login(formData: FormData) {
  const supabase = await createClient();

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  // Document Control lands on its dashboard; a plain User goes straight into
  // the guided Organization -> Project -> Features path, since it has no
  // sidebar to reach the dashboard's tool grid from.
  redirect(roleOf(data.user) === "dcc" ? "/dashboard" : "/clients");
}
