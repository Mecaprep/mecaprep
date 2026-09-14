// MecaPrep — ai-chat
// ----------------------------------------------------------------------
// Server side of the "Assistant mécanique" chat bubble. The browser sends
// the recent conversation; this function adds the (server-held) system
// instructions, calls Claude, and returns the reply. Signed-in visitors
// only, with a per-account daily cap — every message is billed to the
// MecaPrep Anthropic account, so an open endpoint would be an open tab.
//
// Required secret: ANTHROPIC_API_KEY (same one as analyze-scan).

import Anthropic from "npm:@anthropic-ai/sdk@0.125.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const DAILY_CAP_FREE = 5;
const DAILY_CAP_PREMIUM = 50;
const MAX_TURNS = 16;
const MAX_CHARS_PER_TURN = 2000;

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

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

const SYSTEM_PROMPT = [
  "Tu es l'Assistant Mécanique de MecaPrep, une app de révision pour le CAP/Bac Pro Maintenance des Véhicules. Tu es expert en mécanique automobile toutes marques confondues. Réponds toujours en français, avec le ton concret d'un mécano expérimenté qui explique à un collègue ou un élève. Sois concis : quelques phrases ou une courte liste, pas de longs pavés — l'élève lit sur son téléphone.",
  "Sujet : si la question ne concerne pas la mécanique, l'entretien, le diagnostic ou la réglementation automobile, décline poliment en une phrase et recentre sur la mécanique auto.",
  "Sources : tu n'as pas accès au web et aucune mémoire entre les conversations. Réponds à partir de connaissances générales et documentées du secteur, sans prétendre avoir consulté une source à l'instant. Pour une donnée exacte propre à un modèle précis (couple de serrage, référence pièce, procédure constructeur, rappel en cours), dis-le et renvoie vers la documentation technique du constructeur ou un professionnel équipé.",
  "Sécurité : si la question touche au freinage, à la direction, à la structure porteuse, aux airbags, ceintures ou systèmes de retenue, ou à la haute tension d'un véhicule hybride/électrique, termine par une ligne rappelant de faire vérifier par un professionnel qualifié avant toute intervention réelle.",
].join("\n\n");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Connecte-toi pour utiliser l'assistant." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Connecte-toi pour utiliser l'assistant." }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => null);
    const raw = Array.isArray(body?.messages) ? body.messages.slice(-MAX_TURNS) : [];
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const m of raw) {
      if ((m?.role !== "user" && m?.role !== "assistant") || typeof m?.content !== "string") {
        return json({ error: "Requête invalide." }, 400);
      }
      const content = m.content.trim().slice(0, MAX_CHARS_PER_TURN);
      if (content) messages.push({ role: m.role, content });
    }
    while (messages.length && messages[0].role !== "user") messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return json({ error: "Requête invalide." }, 400);
    }

    const db = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: ent } = await db.from("entitlements").select("premium").eq("user_id", userId).maybeSingle();
    const premium = !!ent?.premium;
    const cap = premium ? DAILY_CAP_PREMIUM : DAILY_CAP_FREE;

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count: todayCount } = await db
      .from("ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("kind", "chat").gte("created_at", since);
    if ((todayCount ?? 0) >= cap) {
      return json({
        error: premium
          ? "Tu as atteint la limite de questions pour aujourd'hui — reviens demain."
          : `Tu as utilisé tes ${DAILY_CAP_FREE} questions gratuites du jour. L'abonnement en donne ${DAILY_CAP_PREMIUM} par jour.`,
        code: "daily_limit",
      }, 429);
    }

    let response;
    try {
      response = await anthropic.beta.messages.create({
        model: "claude-opus-5",
        max_tokens: 4096,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) {
        return json({ error: "L'assistant est très sollicité — réessaie dans un instant." }, 503);
      }
      console.error("ai-chat: Claude call failed", e);
      return json({ error: "Désolé, une erreur est survenue. Réessaie dans un instant." }, 502);
    }

    await db.from("ai_usage").insert({ user_id: userId, kind: "chat", billing: premium ? "premium" : "free" });

    if (response.stop_reason === "refusal") {
      return json({ text: "Je ne peux pas répondre à cette demande. Reformule ta question sur un sujet mécanique.", remaining: cap - (todayCount ?? 0) - 1 });
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text).join("").trim();
    return json({
      text,
      truncated: response.stop_reason === "max_tokens",
      remaining: cap - (todayCount ?? 0) - 1,
    });
  } catch (e) {
    console.error("ai-chat error:", e);
    return json({ error: "Erreur interne — réessaie." }, 500);
  }
});
