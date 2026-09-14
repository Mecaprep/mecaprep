// MecaPrep — create-portal-session
// ----------------------------------------------------------------------
// Called by the browser when a signed-in visitor clicks "Gérer mon
// abonnement" in the account panel. Creates a Stripe Billing Portal
// session and hands back its URL — the front-end just redirects there.
// Stripe's own portal handles cancellation, payment method updates and
// invoice history, so MecaPrep never has to build any of that itself.
//
// One-time setup required in the Stripe Dashboard (test mode too):
//   Settings → Billing → Customer portal → configure and activate it
//   (at minimum, allow "Cancel subscriptions").
//
// Reuses the same secrets as create-checkout-session — nothing new to set.

import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);

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
    const { data: entitlement } = await supabaseService
      .from("entitlements")
      .select("stripe_customer_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    const customerId = entitlement?.stripe_customer_id as string | null | undefined;
    if (!customerId) return json({ error: "Aucun abonnement à gérer pour le moment." }, 404);

    const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:8731";
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${siteUrl}/#/tarifs`,
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("create-portal-session error:", e);
    return json({ error: "Internal error" }, 500);
  }
});
