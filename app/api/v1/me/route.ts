import { createClient } from "@supabase/supabase-js";
import { query } from "@/lib/db";

// Used only to check login tokens. It keeps no session of its own, so one copy serves every request.
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// GET /api/v1/me: tells the Flutter app which teacher its login token belongs to.
export async function GET(request: Request) {
  // 1. Read the token from the "Authorization: Bearer <token>" header.
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return errorResponse(401, "unauthorized", "Missing Authorization: Bearer token.");

  // 2. Check Supabase's signature on the token. claims.sub is the teacher's id.
  const { data } = await supabase.auth.getClaims(token);
  const teacherId = data?.claims.sub;
  if (!teacherId) return errorResponse(401, "unauthorized", "Invalid or expired token.");

  // 3. Load the teacher, with the email from Supabase's own users table.
  const [teacher] = await query(
    `SELECT t.id, t.full_name AS "fullName", u.email, t.created_at AS "createdAt"
       FROM teachers t
       JOIN auth.users u ON u.id = t.id
      WHERE t.id = $1`,
    [teacherId],
  );
  if (!teacher) return errorResponse(404, "teacher_not_found", "No teacher profile for this account.");

  // 4. Send it back as JSON.
  return Response.json({ teacher });
}

// Every API error has the same shape, so the app can handle them all the same way.
function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}
