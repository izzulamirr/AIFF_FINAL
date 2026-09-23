import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

// Standard Supabase SSR session-refresh proxy -- keeps the auth cookie
// current on every request so Server Components always see a valid session.
// (Next.js 16 renamed the "middleware" file convention to "proxy".)
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Route groups like (app) don't appear in the actual URL -- gate real
  // path prefixes instead. Add new protected prefixes here as they're built.
  // (Every page under (app) also redirects unauthenticated visitors itself --
  // see (app)/layout.tsx -- this is defense-in-depth, not the only check.)
  //
  // `/organizations` is the old name for `/clients` and still redirects, so it
  // is gated too -- otherwise the one path that survives the rename is the one
  // that skips the check.
  const isProtectedPath = [
    "/dashboard",
    "/projects",
    "/clients",
    "/organizations",
    "/review",
    "/cutting",
    "/users",
    "/library",
  ].some((prefix) => request.nextUrl.pathname.startsWith(prefix));

  if (!user && isProtectedPath) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|login|signup|api/auth).*)"],
};
