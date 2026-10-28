import Link from "next/link";
import { Suspense } from "react";
import { signup } from "@/lib/auth-actions";

export default function SignupPage({ searchParams }: PageProps<"/signup">) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form action={signup} className="flex w-full max-w-sm flex-col gap-4">
        <h1 className="text-2xl font-semibold">Create your teacher account</h1>

        {/* The ?error= part depends on the request, so it fills in after the static form. */}
        <Suspense>
          <ErrorNotice searchParams={searchParams} />
        </Suspense>

        <label className="flex flex-col gap-1 text-sm">
          Full name
          <input name="full_name" required autoComplete="name" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required autoComplete="email" className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input name="password" type="password" required minLength={6} autoComplete="new-password" className="rounded border px-3 py-2" />
        </label>

        <button type="submit" className="rounded bg-foreground px-3 py-2 font-medium text-background">
          Sign up
        </button>
        <p className="text-sm">
          Already have an account? <Link href="/login" className="underline">Log in</Link>
        </p>
      </form>
    </main>
  );
}

async function ErrorNotice({ searchParams }: Pick<PageProps<"/signup">, "searchParams">) {
  const { error } = await searchParams;
  return error ? <p className="rounded bg-red-100 p-3 text-sm text-red-800">{error}</p> : null;
}
