"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function readText(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

// Go back to the form and show `message` there. redirect() stops the action here.
function backWithError(path: string, message: string): never {
  redirect(`${path}?${new URLSearchParams({ error: message })}`);
}

export async function login(formData: FormData) {
  const email = readText(formData, "email").trim();
  const password = readText(formData, "password");
  if (!email || !password) backWithError("/login", "Enter your email and password.");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) backWithError("/login", error.message);

  redirect("/");
}

export async function signup(formData: FormData) {
  const fullName = readText(formData, "full_name").trim();
  const email = readText(formData, "email").trim();
  const password = readText(formData, "password");
  if (!fullName || !email || !password) backWithError("/signup", "Fill in every field.");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // Saved as raw_user_meta_data; the on_auth_user_created trigger copies it into teachers.full_name.
    options: { data: { full_name: fullName } },
  });
  if (error) backWithError("/signup", error.message);

  // No session means the project requires email confirmation before the first login.
  if (!data.session) {
    redirect(`/login?${new URLSearchParams({ message: "Check your email to confirm your account, then log in." })}`);
  }

  redirect("/");
}

export async function logout() {
  const supabase = await createSupabaseServerClient();
  // "local" = log out this browser only, not the teacher's other devices.
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}
