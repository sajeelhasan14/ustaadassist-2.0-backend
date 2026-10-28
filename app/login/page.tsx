import Link from "next/link";
import { Suspense } from "react";
import { login } from "@/lib/auth-actions";

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form action={login} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Log in to UstaadAssist</h1>

        {/* The ?error= / ?message= part depends on the request, so it fills in after the static form. */}
        <Suspense>
          <Notices searchParams={searchParams} />
        </Suspense>

        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required autoComplete="email" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input name="password" type="password" required autoComplete="current-password" className="rounded border px-3 py-2" />
        </label>

        <button type="submit" className="rounded bg-foreground px-3 py-2 font-medium text-background">
          Log in
        </button>
        <p className="text-sm">
          No account? <Link href="/signup" className="underline">Sign up</Link>
        </p>
      </form>
    </main>
  );
}

async function Notices({ searchParams }: Pick<PageProps<"/login">, "searchParams">) {
  const { error, message } = await searchParams;
  return (
    <>
      {message && <p className="rounded bg-green-100 p-3 text-sm text-green-800">{message}</p>}
      {error && <p className="rounded bg-red-100 p-3 text-sm text-red-800">{error}</p>}
    </>
  );
}
