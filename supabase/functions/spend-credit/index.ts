// MecaPrep — spend-credit
// ----------------------------------------------------------------------
// Called when a signed-in visitor uses one of their paid credits (to
// unlock a locked theme, or for an extra scanner use). This is the ONLY
// way credits are ever decremented — the front-end never does it itself,
// so a visitor can't just edit local state to reuse the same credit
// forever. The user id comes from their verified Supabase session, never
// from the request body, so nobody can spend someone else's credit either.
//
// No extra secrets needed beyond what Supabase injects automatically
// (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Not authenticated" }, 401);

    const supabaseService = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: remaining, error } = await supabaseService.rpc("spend_credit", {
      p_user_id: userData.user.id,
      p_amount: 1,
    });

    if (error) {
      console.error("spend-credit rpc error:", error);
      return json({ error: "Internal error" }, 500);
    }
    if (remaining === null) return json({ error: "Aucun crédit disponible" }, 402);

    return json({ ok: true, credits: remaining });
  } catch (e) {
    console.error("spend-credit error:", e);
    return json({ error: "Internal error" }, 500);
  }
});
