import { NextResponse } from "next/server";
import { aiModeTitle, buildChessAiMessages, type ChessAiRequest } from "@/lib/ai-chess";

export const runtime = "nodejs";

type OpenRouterChoice = {
  message?: {
    content?: string;
  };
};

export async function POST(request: Request) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        title: "AI is not configured",
        explanation: "Set OPENROUTER_API_KEY in Vercel to enable chess explanations.",
      },
      { status: 200 },
    );
  }

  let body: ChessAiRequest;
  try {
    body = (await request.json()) as ChessAiRequest;
  } catch {
    return NextResponse.json({ ok: false, configured: true, title: "Bad request", explanation: "Invalid JSON body." }, { status: 400 });
  }

  if (!isValidBody(body)) {
    return NextResponse.json({ ok: false, configured: true, title: "Bad request", explanation: "Missing chess context." }, { status: 400 });
  }

  const model = process.env.OPENROUTER_MODEL || "openrouter/auto";
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || "https://chess2pdf.vercel.app";

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": siteUrl.startsWith("http") ? siteUrl : `https://${siteUrl}`,
        "X-Title": "Chess2pdf",
      },
      body: JSON.stringify({
        model,
        messages: buildChessAiMessages(body),
        temperature: 0.35,
        max_tokens: 500,
      }),
    });

    const payload = (await response.json()) as { choices?: OpenRouterChoice[]; error?: { message?: string } };
    if (!response.ok) {
      const message = payload.error?.message || "OpenRouter request failed.";
      return NextResponse.json({ ok: false, configured: true, title: "AI request failed", explanation: message }, { status: response.status });
    }

    const explanation = payload.choices?.[0]?.message?.content?.trim();
    if (!explanation) {
      return NextResponse.json({ ok: false, configured: true, title: "No AI response", explanation: "The model did not return text." }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      configured: true,
      title: aiModeTitle(body.mode),
      explanation,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        title: "AI request failed",
        explanation: error instanceof Error ? error.message : "Unknown AI error.",
      },
      { status: 500 },
    );
  }
}

function isValidBody(body: ChessAiRequest) {
  return (
    (body.mode === "line-summary" || body.mode === "deviation") &&
    typeof body.startingFen === "string" &&
    typeof body.currentFen === "string" &&
    Array.isArray(body.recognizedMoves) &&
    Array.isArray(body.playedMoves)
  );
}
