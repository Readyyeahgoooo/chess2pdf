import { NextResponse } from "next/server";
import { DEFAULT_OPENROUTER_MODEL, aiModeTitle, buildChessAiMessages, sanitizeChessAiRequest, type ChessAiRequest } from "@/lib/ai-chess";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 18_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 6;
const RATE_LIMIT_DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_MAX_PER_DAY = 40;

type OpenRouterChoice = {
  message?: {
    content?: string;
  };
};

type RateLimitBucket = {
  minuteStart: number;
  minuteCount: number;
  dayStart: number;
  dayCount: number;
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();

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

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        title: "Request too large",
        explanation: "AI coach requests are limited to derived chess data only.",
      },
      { status: 413 },
    );
  }

  const ip = clientIp(request);
  const limited = checkRateLimit(ip);
  if (limited) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        title: "AI rate limit reached",
        explanation: limited,
      },
      { status: 429 },
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

  const safeBody = sanitizeChessAiRequest(body);
  const model = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || "https://chess2pdf.vercel.app";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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
        messages: buildChessAiMessages(safeBody),
        temperature: 0.35,
        max_tokens: 450,
      }),
      signal: controller.signal,
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
  } finally {
    clearTimeout(timeout);
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

function clientIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }
  return request.headers.get("x-real-ip") || "unknown";
}

function checkRateLimit(ip: string) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(ip) ?? {
    minuteStart: now,
    minuteCount: 0,
    dayStart: now,
    dayCount: 0,
  };

  if (now - bucket.minuteStart > RATE_LIMIT_WINDOW_MS) {
    bucket.minuteStart = now;
    bucket.minuteCount = 0;
  }
  if (now - bucket.dayStart > RATE_LIMIT_DAY_MS) {
    bucket.dayStart = now;
    bucket.dayCount = 0;
  }

  bucket.minuteCount += 1;
  bucket.dayCount += 1;
  rateLimitBuckets.set(ip, bucket);

  if (bucket.minuteCount > RATE_LIMIT_MAX_PER_WINDOW) {
    return "Please wait a minute before asking the AI coach again.";
  }
  if (bucket.dayCount > RATE_LIMIT_MAX_PER_DAY) {
    return "Daily AI coach limit reached for this connection.";
  }
  return "";
}
