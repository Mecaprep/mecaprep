// MecaPrep — stripe-webhook
// ----------------------------------------------------------------------
// Called directly by Stripe (NOT by the browser) whenever a payment event
// happens. This is the ONLY place that actually grants premium/credits —
// the front-end never sets those itself, it only ever *asks* for a
// Checkout Session (see create-checkout-session) and waits for this
// webhook to do the real unlock once Stripe confirms the money moved.
//
// Deployment note: this function MUST be deployed with JWT verification
// disabled (Supabase Dashboard → Edge Functions → stripe-webhook →
// "Enforce JWT Verification" OFF) since Stripe calls it directly, without
// any Supabase session — its own request is authenticated instead via the
// Stripe-Signature header checked below.
//
// Required secret (Supabase Dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY     same key as create-checkout-session
//   STRIPE_WEBHOOK_SECRET whsec_... — from the Stripe webhook endpoint you
//                         point at this function's URL

import Stripe from "npm:stripe@14";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!);
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const supabaseService = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  const rawBody = await req.text(); // must stay unparsed — signature covers the exact bytes

  if (!signature) return new Response("Missing Stripe-Signature header", { status: 400 });

  let event: Stripe.Event;
  try {
    // Deno only has async WebCrypto, hence *Async* rather than the
    // Node-only synchronous constructEvent.
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  // Idempotency: Stripe can and does redeliver the same event. Recording
  // the event id first, and bailing out on a duplicate, means a one-off
  // credit purchase can never be granted twice.
  const { error: dedupeError } = await supabaseService
    .from("stripe_events")
    .insert({ id: event.id });
  if (dedupeError) {
    console.log("stripe-webhook: duplicate or logging error for event", event.id, dedupeError.message);
    return new Response("ok (already processed)", { status: 200 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.client_reference_id || session.metadata?.supabase_user_id;
        if (!userId) {
          console.error("stripe-webhook: checkout.session.completed with no user id", session.id);
          break;
        }
        if (session.mode === "subscription") {
          await supabaseService.rpc("set_premium", { p_user_id: userId, p_premium: true });
        } else if (session.mode === "payment") {
          // Set server-side by create-checkout-session (1, 5 or 10), never by the browser.
          const credits = Number.parseInt(session.metadata?.credits ?? "1", 10);
          const amount = Number.isFinite(credits) && credits >= 1 && credits <= 10 ? credits : 1;
          await supabaseService.rpc("grant_credit", { p_user_id: userId, p_amount: amount });
        }
        if (typeof session.customer === "string") {
          await supabaseService.rpc("set_stripe_customer", {
            p_user_id: userId,
            p_stripe_customer_id: session.customer,
          });
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const { data: userId } = await supabaseService.rpc("user_id_for_stripe_customer", {
          p_stripe_customer_id: customerId,
        });
        if (userId) {
          await supabaseService.rpc("set_premium", { p_user_id: userId, p_premium: false });
        }
        break;
      }
      default:
        // other event types intentionally ignored
        break;
    }
  } catch (e) {
    // The event id is already recorded above, so a bug here won't cause
    // Stripe to retry forever — but it DOES mean this specific payment
    // needs a manual look at the function logs.
    console.error("stripe-webhook: error handling", event.type, e);
  }

  return new Response("ok", { status: 200 });
});
