import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Pages that can be opened without logging in.
const PUBLIC_PATHS = ["/login", "/signup"];

/**
 * Runs before every page (see `config.matcher` below).
 * 1. Refreshes the Supabase login if its token has expired.
 * 2. Sends logged-out users to /login, and logged-in users away from /login and /signup.
 * This is a quick first check only; data access is checked again on the server.
 */
export default async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  // Anti-caching headers Supabase asks us to send whenever it sets login cookies.
  const cacheHeaders: Record<string, string> = {};

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          // On the request: so the page rendering right after this sees the fresh login.
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          // On the response: so the browser saves the fresh login.
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          Object.assign(cacheHeaders, headers);
          Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
        },
      },
    },
  );

  // Verifies the token's signature, refreshing it first if it has expired.
  const { data } = await supabase.auth.getClaims();
  const isLoggedIn = Boolean(data?.claims);
  const isPublicPath = PUBLIC_PATHS.includes(request.nextUrl.pathname);

  if (!isLoggedIn && !isPublicPath) return redirectTo("/login");
  if (isLoggedIn && isPublicPath) return redirectTo("/");
  return response;

  // A redirect is a new response, so carry over any cookies and headers set above.
  function redirectTo(path: string) {
    const redirect = NextResponse.redirect(new URL(path, request.url));
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
    Object.entries(cacheHeaders).forEach(([key, value]) => redirect.headers.set(key, value));
    return redirect;
  }
}

export const config = {
  // Skip API routes (they check tokens themselves) and static files (CSS, JS, images).
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
