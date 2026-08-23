/**
 * =============================================================================
 * CLOUDFLARE WORKER: MULTI-CLOUD API GATEWAY & FAILOVER LOAD BALANCER
 * =============================================================================
 * Skrip ini dideploy ke Cloudflare Workers (100% Gratis, 100.000 req/hari).
 * Berfungsi sebagai satu-satunya pintu masuk (Single Gateway URL) untuk aplikasi
 * Flutter / Web / Klien, meneruskan request ke backend yang aktif secara otomatis.
 *
 * CARA KERJA:
 * 1. Aplikasi Flutter memanggil https://<nama-worker>.workers.dev/api/...
 * 2. Worker mencoba menghubungi Server 1 (misal: Render).
 * 3. Jika Server 1 timeout (5 detik) atau error 5xx (mati/sleep), Worker otomatis
 *    mengalihkan request yang sama ke Server 2 (misal: Alwaysdata / Back4App / VPS).
 * 4. Daftar backend dapat ditambah/diubah KAPAN SAJA di Dashboard Cloudflare
 *    melalui Environment Variable "BACKEND_URLS" tanpa perlu update aplikasi Flutter!
 * =============================================================================
 */

export default {
  async fetch(request, env, ctx) {
    // 1. Tangani CORS Preflight (OPTIONS request dari web frontend)
    if (request.method === "OPTIONS") {
      return handleCorsPreflight();
    }

    // 2. Ambil daftar backend dari Environment Variable BACKEND_URLS di Cloudflare Dashboard
    // Contoh format di Dashboard: "https://backend-jamur.onrender.com,https://backend-jamur.alwaysdata.net"
    const backendEnv = env.BACKEND_URLS || "";
    const backendList = backendEnv
      .split(",")
      .map((url) => url.trim().replace(/\/+$/, "")) // Bersihkan trailing slash
      .filter(Boolean);

    // Fallback jika variabel belum diset di dashboard Cloudflare
    if (backendList.length === 0) {
      return jsonResponse(
        {
          error: "Konfigurasi Gateway Belum Lengkap",
          message:
            "Silakan tambahkan Environment Variable 'BACKEND_URLS' di Dashboard Cloudflare Workers.",
        },
        500
      );
    }

    const incomingUrl = new URL(request.url);
    const pathAndQuery = incomingUrl.pathname + incomingUrl.search;

    // Buffer body jika request memiliki payload (POST / PUT / PATCH) agar bisa dicoba ulang ke server berikutnya jika server pertama gagal
    let requestBody = null;
    if (["POST", "PUT", "PATCH"].includes(request.method.toUpperCase())) {
      requestBody = await request.arrayBuffer();
    }

    // 3. Loop Failover: Coba setiap backend secara berurutan
    for (let i = 0; i < backendList.length; i++) {
      const backendBase = backendList[i];
      const targetUrl = backendBase + pathAndQuery;

      try {
        // Siapkan header (teruskan semua header asli, kecuali host)
        const headers = new Headers(request.headers);
        headers.set("Host", new URL(backendBase).host);
        headers.set("X-Forwarded-Host", incomingUrl.host);
        headers.set("X-Forwarded-Proto", incomingUrl.protocol.replace(":", ""));

        // Timeout 6 detik per backend agar user tidak menunggu terlalu lama jika server sedang cold-start/mati
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const proxyRequest = new Request(targetUrl, {
          method: request.method,
          headers: headers,
          body: requestBody ? requestBody.slice(0) : undefined,
          redirect: "follow",
          signal: controller.signal,
        });

        const response = await fetch(proxyRequest);
        clearTimeout(timeoutId);

        // Jika respons bukan 5xx (500-599) dan bukan 429 (Rate Limit platform), kembalikan hasilnya!
        if (response.status < 500 && response.status !== 429) {
          // Tambahkan header CORS & Gateway Identifier
          const responseHeaders = new Headers(response.headers);
          addCorsHeaders(responseHeaders);
          responseHeaders.set("X-Gateway-Routed-To", backendBase);

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        }

        console.warn(
          `[Gateway] Server ${backendBase} merespons status ${response.status}. Mencoba server cadangan...`
        );
      } catch (err) {
        // Gagal (Network error / Timeout / Offline) -> Lanjut ke server berikutnya
        console.warn(
          `[Gateway] Gagal terhubung ke ${backendBase}: ${err.message}. Beralih ke server berikutnya...`
        );
      }
    }

    // 4. Jika SEMUA server di daftar gagal merespons
    return jsonResponse(
      {
        error: "Service Unavailable",
        message: "Semua server backend sedang offline atau dalam pemeliharaan.",
        timestamp: new Date().toISOString(),
      },
      503
    );
  },
};

// Helper: Tambahkan header CORS
function addCorsHeaders(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
}

// Helper: Response untuk CORS Preflight
function handleCorsPreflight() {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, {
    status: 204,
    headers: headers,
  });
}

// Helper: Response format JSON
function jsonResponse(data, status = 200) {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  addCorsHeaders(headers);
  return new Response(JSON.stringify(data), {
    status: status,
    headers: headers,
  });
}
