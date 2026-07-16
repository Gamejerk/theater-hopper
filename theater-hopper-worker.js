/**
 * Theater Hopper — Cloudflare Worker Proxy
 * ─────────────────────────────────────────
 * Routes:
 *   GET /theaters?zip=90210&date=2026-04-17   →  Fandango NAPI (showtimes)
 *   GET /tmdb/<path>?<params>                 →  TMDB API     (movie metadata)
 *
 * ── Server-side caching ───────────────────────────────────────────────────
 * Cloudflare's Cache API caches responses at the edge so repeated searches
 * for the same zip+date serve from cache instead of hitting Fandango/TMDB.
 *   • Fandango showtimes:  2 hours  (showtimes are stable within a day)
 *   • TMDB search/detail:  24 hours (movie metadata rarely changes)
 *
 * ── Deploy steps ──────────────────────────────────────────────────────────
 *  1. Go to https://workers.cloudflare.com  →  create a free account
 *  2. Click "Create application" → "Create Worker"
 *  3. Paste this entire file into the editor, click "Deploy"
 *  4. Open "Settings" → "Variables" → add a secret:
 *       Name:  TMDB_API_KEY
 *       Value: your key from https://www.themoviedb.org/settings/api  (free)
 *  5. Copy your worker URL  (e.g. https://theater-hopper.YOUR-NAME.workers.dev)
 *  6. Paste it into theater-hopper.html  →  const PROXY_URL = "https://..."
 * ──────────────────────────────────────────────────────────────────────────
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS headers — allow any origin so the HTML file works from disk/CDN ──
    const cors = {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return respond({ error: "Method not allowed" }, 405, cors);
    }

    try {

      // ── /theaters?zip=XXXXX&date=YYYY-MM-DD ───────────────────────────────
      if (url.pathname === "/theaters") {
        const zip    = url.searchParams.get("zip");
        const date   = url.searchParams.get("date");   // YYYY-MM-DD
        const radius = url.searchParams.get("radius"); // miles, optional
        if (!zip || !date) {
          return respond({ error: "zip and date are required" }, 400, cors);
        }

        // Check edge cache first — same zip+date+radius serves cached data
        const cacheKey = `https://cache.theater-hopper/theaters/${zip}/${date}/${radius || "10"}`;
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          const body = await cached.text();
          return new Response(body, { status: 200, headers: { ...cors, "Content-Type": "application/json", "X-Cache": "HIT" } });
        }

        const upstream = new URL("https://www.fandango.com/napi/theaterswithshowtimes");
        upstream.searchParams.set("zipCode", zip);
        upstream.searchParams.set("date",    date);
        if (radius) upstream.searchParams.set("radius", radius);

        const res  = await fetch(upstream.toString(), {
          headers: {
            // Mimic a real browser so Fandango doesn't reject us
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept":          "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer":         "https://www.fandango.com/",
            "Origin":          "https://www.fandango.com",
          },
        });

        const body = await res.text();
        const response = new Response(body, {
          status: res.status,
          headers: {
            ...cors,
            "Content-Type":  "application/json",
            "Cache-Control": "public, max-age=7200", // 2 hours
            "X-Cache":       "MISS",
          },
        });

        // Store in edge cache only on success
        if (res.ok) {
          await caches.default.put(cacheKey, response.clone());
        }
        return response;
      }

      // ── /tmdb/<path>?<params>  ─────────────────────────────────────────────
      // Example: /tmdb/search/movie?query=Thunderbolt
      //          /tmdb/movie/12345?append_to_response=credits
      if (url.pathname.startsWith("/tmdb/")) {
        if (!env.TMDB_API_KEY) {
          return respond({ error: "TMDB_API_KEY secret not configured in Worker settings" }, 500, cors);
        }

        const path   = url.pathname.replace("/tmdb", ""); // strip /tmdb prefix
        const params = new URLSearchParams(url.search);
        params.set("api_key", env.TMDB_API_KEY);          // inject key server-side (never exposed to client)

        const upstream = `https://api.themoviedb.org/3${path}?${params.toString()}`;

        // Cache TMDB responses for 24 hours — movie metadata is very stable
        const cacheKey = `https://cache.theater-hopper/tmdb${path}?${url.search}`;
        const cached = await caches.default.match(cacheKey);
        if (cached) {
          const body = await cached.text();
          return new Response(body, { status: 200, headers: { ...cors, "Content-Type": "application/json", "X-Cache": "HIT" } });
        }

        const res = await fetch(upstream, {
          headers: { "Accept": "application/json" },
        });

        const body = await res.text();
        const response = new Response(body, {
          status: res.status,
          headers: {
            ...cors,
            "Content-Type":  "application/json",
            "Cache-Control": "public, max-age=86400", // 24 hours
            "X-Cache":       "MISS",
          },
        });

        // Cache only successful TMDB responses
        if (res.ok) {
          await caches.default.put(cacheKey, response.clone());
        }
        return response;
      }

      // ── Health check ─────────────────────────────────────────────────────
      if (url.pathname === "/" || url.pathname === "/health") {
        return respond({ ok: true, service: "Theater Hopper Proxy" }, 200, cors);
      }

      return respond({ error: "Not found" }, 404, cors);

    } catch (e) {
      console.error("Worker error:", e);
      return respond({ error: e.message }, 502, cors);
    }
  },
};

function respond(obj, status, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

