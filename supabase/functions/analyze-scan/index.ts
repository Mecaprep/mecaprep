// MecaPrep — analyze-scan
// ----------------------------------------------------------------------
// The photo scanner's server side. The browser sends a (downscaled) photo
// of a course sheet plus the list of quiz sub-themes; Claude reads the
// photo and picks the matching sub-theme. This function — not the
// browser — decides whether the scan is allowed and how it is paid for,
// so the free-scan limit can't be reset by clearing browser storage:
//
//   subscriber, < 50 this month → included
//   first scan of the account   → free (exactly one per account, ever)
//   otherwise, a credit left    → one credit is spent
//   otherwise                   → 402 (paywall, or "monthly limit" message)
//
// A scan that fails, or finds no usable theme, refunds its credit and
// doesn't consume the free scan. Every call (charged or not) counts
// toward a daily cap so one account can't run up the AI bill.
//
// Required secret (Supabase Dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   from console.anthropic.com → API keys
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically.

import Anthropic from "npm:@anthropic-ai/sdk@0.125.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const FREE_SCANS_PER_ACCOUNT = 1;
const PREMIUM_SCANS_PER_MONTH = 50; // keep in sync with the Tarifs/paywall copy in index.html
const SCAN_DAILY_CAP = 20;
const MAX_IMAGE_BASE64_CHARS = 6_500_000; // ≈ 4.9 MB decoded, under the API's 5 MB per-image limit
const MAX_TARGETS_CHARS = 12_000;
const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    extractedText: { anyOf: [{ type: "string" }, { type: "null" }] },
    themeKey: { anyOf: [{ type: "string" }, { type: "null" }] },
    subcatKey: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["extractedText", "themeKey", "subcatKey"],
  additionalProperties: false,
};

function buildPrompt(targets: string) {
  return [
    "Tu analyses la photo d'une fiche ou d'un support de cours de mécanique automobile (niveau CAP/Bac Pro Maintenance des Véhicules).",
    "1. extractedText : transcris fidèlement, en 150 caractères maximum, le passage de texte le plus lisible et le plus significatif visible sur la photo. Si aucun texte exploitable n'est lisible, mets null — n'invente jamais de texte.",
    "2. themeKey / subcatKey : parmi la liste de sujets ci-dessous (format clé_thème/clé_sous-thème — Thème / Sous-thème : description), choisis celui qui correspond le mieux au contenu réellement visible sur la photo, et renvoie ses deux clés exactement comme écrites.",
    "<sujets>\n" + targets + "\n</sujets>",
    "3. Si la photo ne correspond clairement à aucun de ces sujets (photo illisible, hors mécanique automobile, ou sujet non couvert), mets themeKey et subcatKey à null plutôt que de deviner.",
  ].join("\n\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (!ANTHROPIC_API_KEY) {
    return json({ error: "Le scanner n'est pas encore activé — réessaie bientôt." }, 503);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Connecte-toi pour utiliser le scanner." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Connecte-toi pour utiliser le scanner." }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => null);
    const image = typeof body?.image === "string" ? body.image : "";
    const mediaType = body?.mediaType;
    const targets = typeof body?.targets === "string" ? body.targets : "";
    if (!image || image.length > MAX_IMAGE_BASE64_CHARS || !ALLOWED_MEDIA_TYPES.includes(mediaType)) {
      return json({ error: "Photo invalide ou trop lourde — essaie une autre image." }, 400);
    }
    if (!targets || targets.length > MAX_TARGETS_CHARS) {
      return json({ error: "Requête invalide." }, 400);
    }

    const db = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count: todayCount } = await db
      .from("ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("kind", "scan").gte("created_at", since);
    if ((todayCount ?? 0) >= SCAN_DAILY_CAP) {
      return json({ error: "Limite de scans atteinte pour aujourd'hui — réessaie demain." }, 429);
    }

    const { data: ent } = await db
      .from("entitlements").select("premium, credits").eq("user_id", userId).maybeSingle();
    const { count: freeUsed } = await db
      .from("ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("kind", "scan").eq("billing", "free");

    // Subscribers get PREMIUM_SCANS_PER_MONTH included per calendar month
    // (UTC); past that they fall through to the free scan / credits below.
    let premiumUsed = 0;
    if (ent?.premium) {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const { count } = await db
        .from("ai_usage")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId).eq("kind", "scan").eq("billing", "premium").gte("created_at", monthStart);
      premiumUsed = count ?? 0;
    }

    let billing: "premium" | "free" | "credit";
    let creditsLeft: number | null = ent?.credits ?? 0;
    if (ent?.premium && premiumUsed < PREMIUM_SCANS_PER_MONTH) {
      billing = "premium";
    } else if ((freeUsed ?? 0) < FREE_SCANS_PER_ACCOUNT) {
      billing = "free";
    } else {
      const { data: remaining, error: spendErr } = await db.rpc("spend_credit", { p_user_id: userId, p_amount: 1 });
      if (spendErr) throw spendErr;
      if (remaining === null) {
        return json({
          error: ent?.premium
            ? `Tu as utilisé tes ${PREMIUM_SCANS_PER_MONTH} scans inclus ce mois-ci. Ils reviennent le 1er du mois — ou prends des crédits sur la page Tarifs pour continuer.`
            : "Ton scan gratuit est déjà utilisé — prends un crédit ou l'abonnement pour continuer.",
          code: ent?.premium ? "monthly_limit" : "payment_required",
        }, 402);
      }
      billing = "credit";
      creditsLeft = remaining;
    }

    // Whatever goes wrong from here, give the credit back and log the call as uncharged.
    async function refundAndLog() {
      if (billing === "credit") {
        await db.rpc("grant_credit", { p_user_id: userId, p_amount: 1 });
        creditsLeft = (creditsLeft ?? 0) + 1;
      }
      await db.from("ai_usage").insert({ user_id: userId, kind: "scan", billing: "none" });
    }

    let result: { extractedText: string | null; themeKey: string | null; subcatKey: string | null } | null = null;
    try {
      const response = await anthropic.beta.messages.create({
        model: "claude-opus-5",
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        // Re-runs the request on Anthropic's recommended fallback model if
        // Opus 5's safety classifiers ever decline it.
        fallbacks: "default",
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: RESULT_SCHEMA },
        },
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: buildPrompt(targets) },
          ],
        }],
      });

      if (response.stop_reason === "end_turn") {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text).join("");
        result = JSON.parse(text);
      } else {
        console.error("analyze-scan: unusable stop_reason", response.stop_reason);
      }
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) {
        await refundAndLog();
        return json({ error: "Le scanner est très sollicité — réessaie dans un instant.", credits: creditsLeft }, 503);
      }
      if (e instanceof Anthropic.BadRequestError) {
        console.error("analyze-scan: bad request", e.message);
        await refundAndLog();
        return json({ error: "Cette photo n'a pas pu être analysée (format ou taille) — essaie une autre image.", credits: creditsLeft }, 400);
      }
      console.error("analyze-scan: Claude call failed", e);
      await refundAndLog();
      return json({ error: "L'analyse a échoué — réessaie.", credits: creditsLeft }, 502);
    }

    const knownTopic = !!result?.themeKey && !!result?.subcatKey &&
      targets.split("\n").some((line) => line.startsWith(`${result!.themeKey}/${result!.subcatKey} `));
    if (!result || !knownTopic) {
      await refundAndLog();
      return json({
        extractedText: result?.extractedText ?? null, themeKey: null, subcatKey: null,
        billing: "none", credits: creditsLeft,
      });
    }

    await db.from("ai_usage").insert({ user_id: userId, kind: "scan", billing });
    const premiumLeft = billing === "premium" ? PREMIUM_SCANS_PER_MONTH - premiumUsed - 1 : null;
    return json({ ...result, billing, credits: creditsLeft, premiumLeft });
  } catch (e) {
    console.error("analyze-scan error:", e);
    return json({ error: "Erreur interne — réessaie." }, 500);
  }
});
