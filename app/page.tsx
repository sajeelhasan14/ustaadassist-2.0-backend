import { Suspense } from "react";
import { logout } from "@/lib/auth-actions";
import { query } from "@/lib/db";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Temporary home page that proves login works end to end. Replaced by the dashboard in Step 0.6.
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      {/* Who is logged in depends on this request's cookies, so it streams in after the static shell. */}
      <Suspense fallback={<p>Loading…</p>}>
        <CurrentTeacher />
      </Suspense>
      <form action={logout}>
        <button type="submit" className="rounded border px-3 py-2">Log out</button>
      </form>
    </main>
  );
}

async function CurrentTeacher() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const teacherId = data?.claims.sub;

  const [teacher] = teacherId
    ? await query<{ full_name: string }>("SELECT full_name FROM teachers WHERE id = $1", [teacherId])
    : [];

  return (
    <>
      <h1 className="text-2xl font-semibold">Logged in as {teacher?.full_name ?? "unknown"}</h1>
      <p className="text-sm text-gray-500">Teacher id: {teacherId}</p>
    </>
  );
}
