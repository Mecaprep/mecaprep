// MecaPrep — create-checkout-session
// ----------------------------------------------------------------------
// Called by the browser (with the visitor's Supabase session) when they
// click "S'abonner" or "Acheter 1 crédit". Creates a Stripe Checkout
// Session and hands back its URL; the front-end just redirects there.
//
// Required secrets (Supabase Dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY          sk_test_... (or sk_live_... once you go live)
//   STRIPE_PRICE_SUBSCRIPTION  price_... — the 4,99€/mois recurring Price
//   STRIPE_PRICE_CREDIT        price_... — the 0,99€ one-off Price (1 credit)
//   STRIPE_PRICE_CREDIT_5      price_... — the 3,99€ one-off Price (5 credits)
//   STRIPE_PRICE_CREDIT_10     price_... — the 6,99€ one-off Price (10 credits)
//   SITE_URL                   e.g. https://mecaprep.github.io/mecaprep
//                              (where Stripe sends the visitor back to)
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically by Supabase — nothing to set for those.

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

    // Verify the caller is a real, signed-in MecaPrep visitor.
    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Not authenticated" }, 401);
    const user = userData.user;

    const body = await req.json().catch(() => ({}));
    const plan = body?.plan;
    // credits = how many the webhook grants once Stripe confirms payment
    const PLANS: Record<string, { priceEnv: string; credits: number }> = {
      subscription: { priceEnv: "STRIPE_PRICE_SUBSCRIPTION", credits: 0 },
      credit: { priceEnv: "STRIPE_PRICE_CREDIT", credits: 1 },
      credit5: { priceEnv: "STRIPE_PRICE_CREDIT_5", credits: 5 },
      credit10: { priceEnv: "STRIPE_PRICE_CREDIT_10", credits: 10 },
    };
    const planDef = typeof plan === "string" ? PLANS[plan] : undefined;
    if (!planDef) return json({ error: "Unknown plan" }, 400);
    const priceId = Deno.env.get(planDef.priceEnv);
    if (!priceId) return json({ error: "Price not configured for this plan" }, 500);

    // service_role client: reads/writes entitlements, bypassing RLS —
    // safe here because this whole function runs server-side only.
    const supabaseService = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: existing } = await supabaseService
      .from("entitlements")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    // A stored customer id can point at nothing the current Stripe key can
    // see — most commonly a test-mode id left over from before switching
    // STRIPE_SECRET_KEY to a live key (test and live customers live in
    // completely separate namespaces). Verify it resolves before reusing
    // it; a missing/deleted customer is treated the same as having none.
    let customerId = existing?.stripe_customer_id as string | null | undefined;
    if (customerId) {
      try {
        const customer = await stripe.customers.retrieve(customerId);
        if (customer.deleted) customerId = null;
      } catch (e) {
        if (e instanceof Stripe.errors.StripeInvalidRequestError && e.code === "resource_missing") {
          customerId = null;
        } else {
          throw e;
        }
      }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await supabaseService.rpc("set_stripe_customer", {
        p_user_id: user.id,
        p_stripe_customer_id: customerId,
      });
    }

    const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:8731";
    const session = await stripe.checkout.sessions.create({
      mode: plan === "subscription" ? "subscription" : "payment",
      customer: customerId,
      client_reference_id: user.id,
      metadata: { supabase_user_id: user.id, credits: String(planDef.credits) },
      line_items: [{ price: priceId, quantity: 1 }],
      // Query before the hash: the app reads ?checkout= from location.search,
      // and its hash router only recognises an exact "#/tarifs".
      success_url: `${siteUrl}/?checkout=success#/tarifs`,
      cancel_url: `${siteUrl}/?checkout=cancelled#/tarifs`,
    });

    return json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    return json({ error: "Internal error" }, 500);
  }
});
