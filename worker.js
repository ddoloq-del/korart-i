const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // /fal-upload → fal storage presigned upload 프록시 (2단계: initiate → PUT)
      if (url.pathname === '/fal-upload') {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (request.method !== 'POST') {
          return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
        }
        const authHeader = request.headers.get('Authorization');
        const { base64, fileName, contentType } = await request.json();

        // Step 1: initiate upload → presigned upload_url + file_url
        let initRes;
        try {
          initRes = await fetch(
            'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
            {
              method: 'POST',
              headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                content_type: contentType || 'image/jpeg',
                file_name: fileName || 'upload.jpg',
              }),
            }
          );
        } catch (e) {
          return new Response(JSON.stringify({ error: 'initiate failed', detail: e.message }), {
            status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (!initRes.ok) {
          const t = await initRes.text();
          return new Response(t, { status: initRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const { upload_url: uploadUrl, file_url: fileUrl } = await initRes.json();

        // Step 2: base64 → Uint8Array, PUT to presigned URL
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        let putRes;
        try {
          putRes = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': contentType || 'image/jpeg' },
            body: bytes,
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: 'put failed', detail: e.message }), {
            status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        if (!putRes.ok) {
          const t = await putRes.text();
          return new Response(JSON.stringify({ error: 'put error', status: putRes.status, body: t.slice(0, 200) }), {
            status: putRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify({ url: fileUrl }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // /fal-proxy-abs?url=<encoded> → 절대 URL 프록시 (submit 응답의 status_url/response_url 직접 사용)
      if (url.pathname === '/fal-proxy-abs') {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
          return new Response(JSON.stringify({ error: 'missing url param' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const proxyHeaders = new Headers();
        const auth = request.headers.get('Authorization');
        if (auth) proxyHeaders.set('Authorization', auth);
        const ct = request.headers.get('Content-Type');
        if (ct) proxyHeaders.set('Content-Type', ct);
        let falRes;
        try {
          falRes = await fetch(targetUrl, {
            method: request.method,
            headers: proxyHeaders,
            body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: 'fal-proxy-abs fetch failed', detail: e.message }), {
            status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        const resHeaders = new Headers(corsHeaders);
        resHeaders.set('Content-Type', falRes.headers.get('Content-Type') || 'application/json');
        return new Response(falRes.body, { status: falRes.status, headers: resHeaders });
      }

      // /fal-proxy/* → queue.fal.run으로 모든 요청 포워딩 (CORS 우회)
      if (url.pathname.startsWith('/fal-proxy/')) {
        if (request.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders });
        }
        const falPath = url.pathname.replace('/fal-proxy/', '');
        // 모든 모델을 queue.fal.run으로 통일 (submit→poll→result 방식)
        const falUrl = 'https://queue.fal.run/' + falPath + (url.search || '');

        const proxyHeaders = new Headers();
        const auth = request.headers.get('Authorization');
        if (auth) proxyHeaders.set('Authorization', auth);
        const ct = request.headers.get('Content-Type');
        if (ct) proxyHeaders.set('Content-Type', ct);

        let falRes;
        try {
          falRes = await fetch(falUrl, {
            method: request.method,
            headers: proxyHeaders,
            body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: 'fal-proxy fetch failed', detail: e.message }), {
            status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const resHeaders = new Headers(corsHeaders);
        resHeaders.set('Content-Type', falRes.headers.get('Content-Type') || 'application/json');
        return new Response(falRes.body, { status: falRes.status, headers: resHeaders });
      }

      // /ffmpeg-proxy/* → jsdelivr CDN 프록시 (CORP 헤더 추가 — COEP credentialless 환경에서 Worker spawn 가능)
      if (url.pathname.startsWith('/ffmpeg-proxy/')) {
        const targetPath = url.pathname.replace('/ffmpeg-proxy/', '');
        const targetUrl = 'https://cdn.jsdelivr.net/' + targetPath;
        try {
          const upstream = await fetch(targetUrl, {
            cf: { cacheTtl: 86400, cacheEverything: true },
          });
          if (!upstream.ok) {
            return new Response('ffmpeg proxy upstream error: ' + upstream.status, { status: upstream.status });
          }
          const newHeaders = new Headers(upstream.headers);
          newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
          newHeaders.set('Access-Control-Allow-Origin', '*');
          // Worker 스크립트는 적절한 MIME 필요
          if (targetPath.endsWith('.js')) newHeaders.set('Content-Type', 'application/javascript; charset=utf-8');
          if (targetPath.endsWith('.wasm')) newHeaders.set('Content-Type', 'application/wasm');
          return new Response(upstream.body, { status: upstream.status, headers: newHeaders });
        } catch (e) {
          return new Response('ffmpeg proxy fetch failed: ' + e.message, { status: 502 });
        }
      }

      // /studio-drama 또는 /studio-drama/ → studio-drama.html 서빙 (COOP/COEP 헤더 추가 — FFmpeg.wasm SharedArrayBuffer 필요)
      if (url.pathname === '/studio-drama' || url.pathname === '/studio-drama/' || url.pathname === '/studio-drama.html') {
        const assetUrl = new URL('/studio-drama.html', request.url);
        const assetResp = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
        const newResp = new Response(assetResp.body, assetResp);
        newResp.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        newResp.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        return newResp;
      }

      // /studio 또는 /studio/ → studio.html 서빙
      if (url.pathname === '/studio' || url.pathname === '/studio/') {
        const assetUrl = new URL('/studio.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }

      // /terms 또는 /terms/ → terms.html 서빙
      if (url.pathname === '/terms' || url.pathname === '/terms/') {
        const assetUrl = new URL('/terms.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }

      // /privacy 또는 /privacy/ → privacy.html 서빙
      if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
        const assetUrl = new URL('/privacy.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }

      // 나머지 요청은 assets에서 처리
      return await env.ASSETS.fetch(request);
    } catch (err) {
      return new Response('Internal Server Error: ' + (err.message || err), { status: 500 });
    }
  }
};
