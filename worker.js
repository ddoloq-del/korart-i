// Korart-i Cloudflare Worker
// - Supabase JWT 검증 (Authorization: Bearer <jwt>)
// - 포인트 잔액 검증 / 차감
// - fal API 자체 키(FAL_API_KEY)로 호출, 클라이언트에 키 노출 안 함

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Estimated-Points, X-Fal-Endpoint',
  'Access-Control-Expose-Headers': 'X-Points-Charged, X-Points-Remaining, X-Unlimited',
};

const j = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { ...corsHeaders, ...extraHeaders, 'Content-Type': 'application/json' },
});

// ============================================
// JWT → Supabase user_id 추출
// ============================================
async function getUserFromJWT(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  const jwt = m[1];

  // Supabase auth REST: GET /auth/v1/user
  try {
    const r = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: {
        'Authorization': 'Bearer ' + jwt,
        'apikey': env.SUPABASE_SERVICE_KEY,
      },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? { id: u.id, email: u.email, jwt } : null;
  } catch (e) {
    return null;
  }
}

// ============================================
// profiles에서 포인트/unlimited 조회
// ============================================
async function getProfile(env, userId) {
  const r = await fetch(
    env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + userId + '&select=points,unlimited',
    {
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
      },
    }
  );
  if (!r.ok) return null;
  const arr = await r.json();
  return arr[0] || null;
}

// ============================================
// 포인트 차감 + 거래 기록 (트랜잭션)
// ============================================
async function chargePoints(env, userId, amount, description, falEndpoint, requestId, metadata) {
  // unlimited이면 차감 안 함, 거래만 amount=0으로 기록
  const profile = await getProfile(env, userId);
  if (!profile) return { ok: false, error: 'profile not found' };

  if (profile.unlimited) {
    // 거래 기록만 (실제 차감은 0)
    await insertTransaction(env, userId, 'usage', 0, profile.points, description, falEndpoint, requestId, metadata);
    return { ok: true, charged: 0, remaining: profile.points, unlimited: true };
  }

  // 잔액 확인
  if (profile.points < amount) {
    return { ok: false, error: 'insufficient_points', balance: profile.points, required: amount };
  }

  // 차감 (PostgREST PATCH)
  const newBalance = profile.points - amount;
  const upd = await fetch(
    env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + userId,
    {
      method: 'PATCH',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ points: newBalance }),
    }
  );
  if (!upd.ok) return { ok: false, error: 'update failed' };

  await insertTransaction(env, userId, 'usage', -amount, newBalance, description, falEndpoint, requestId, metadata);

  return { ok: true, charged: amount, remaining: newBalance, unlimited: false };
}

async function insertTransaction(env, userId, type, amount, balanceAfter, description, falEndpoint, requestId, metadata) {
  await fetch(env.SUPABASE_URL + '/rest/v1/point_transactions', {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      user_id: userId,
      type,
      amount,
      balance_after: balanceAfter,
      description: description || null,
      fal_endpoint: falEndpoint || null,
      fal_request_id: requestId || null,
      metadata: metadata || null,
    }),
  });
}

// ============================================
// fal API 호출에 사용할 Authorization 헤더 생성
// ============================================
function falAuthHeader(env) {
  return 'Key ' + env.FAL_API_KEY;
}

// ============================================
// 메인 라우터
// ============================================
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // ─────────────────────────────────────────
      // OPTIONS (CORS preflight)
      // ─────────────────────────────────────────
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // ─────────────────────────────────────────
      // /api/me — 현재 사용자 포인트 잔액 조회
      // ─────────────────────────────────────────
      if (url.pathname === '/api/me') {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);
        const profile = await getProfile(env, user.id);
        if (!profile) return j({ error: 'profile not found' }, 404);
        return j({
          user_id: user.id,
          email: user.email,
          points: profile.points,
          unlimited: profile.unlimited,
        });
      }

      // ─────────────────────────────────────────
      // /api/transactions — 본인 거래 이력
      // ─────────────────────────────────────────
      if (url.pathname === '/api/transactions') {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const r = await fetch(
          env.SUPABASE_URL + '/rest/v1/point_transactions?user_id=eq.' + user.id +
          '&order=created_at.desc&limit=' + limit,
          {
            headers: {
              'apikey': env.SUPABASE_SERVICE_KEY,
              'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
            },
          }
        );
        const data = await r.json();
        return j({ transactions: data });
      }

      // ─────────────────────────────────────────
      // /fal-upload — fal storage 업로드 (포인트 무료)
      // ─────────────────────────────────────────
      if (url.pathname === '/fal-upload') {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);
        if (request.method !== 'POST') return j({ error: 'method' }, 405);

        const { base64, fileName, contentType } = await request.json();

        // Step 1: initiate
        const initRes = await fetch(
          'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3',
          {
            method: 'POST',
            headers: {
              'Authorization': falAuthHeader(env),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              content_type: contentType || 'image/jpeg',
              file_name: fileName || 'upload.jpg',
            }),
          }
        );
        if (!initRes.ok) {
          const t = await initRes.text();
          return new Response(t, { status: initRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const { upload_url: uploadUrl, file_url: fileUrl } = await initRes.json();

        // Step 2: PUT
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const putRes = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType || 'image/jpeg' },
          body: bytes,
        });
        if (!putRes.ok) {
          const t = await putRes.text();
          return j({ error: 'put error', status: putRes.status, body: t.slice(0, 200) }, putRes.status);
        }

        return j({ url: fileUrl });
      }

      // ─────────────────────────────────────────
      // /fal-proxy-abs?url=<encoded>
      // queue.fal.run의 status_url/response_url 직접 프록시
      // 포인트 검증 X (이미 submit 시점에 차감됨)
      // ─────────────────────────────────────────
      if (url.pathname === '/fal-proxy-abs') {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);

        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) return j({ error: 'missing url param' }, 400);

        // 안전: queue.fal.run 만 허용 (혹은 fal.media)
        const t = new URL(targetUrl);
        if (!t.hostname.endsWith('.fal.run') && !t.hostname.endsWith('.fal.media') && !t.hostname.endsWith('.fal.ai')) {
          return j({ error: 'invalid host' }, 400);
        }

        const proxyHeaders = new Headers();
        proxyHeaders.set('Authorization', falAuthHeader(env));
        const ct = request.headers.get('Content-Type');
        if (ct) proxyHeaders.set('Content-Type', ct);

        const falRes = await fetch(targetUrl, {
          method: request.method,
          headers: proxyHeaders,
          body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        });
        const resHeaders = new Headers(corsHeaders);
        resHeaders.set('Content-Type', falRes.headers.get('Content-Type') || 'application/json');
        return new Response(falRes.body, { status: falRes.status, headers: resHeaders });
      }

      // ─────────────────────────────────────────
      // /fal-proxy/<endpoint_path>
      // - X-Estimated-Points 헤더로 예상 포인트 받음
      // - JWT 검증 + 포인트 차감 + fal 호출
      // - 첫 POST에 차감, 이후 GET (폴링)은 그냥 패스
      // ─────────────────────────────────────────
      if (url.pathname.startsWith('/fal-proxy/')) {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);

        const falPath = url.pathname.replace('/fal-proxy/', '');
        const falUrl = 'https://queue.fal.run/' + falPath + (url.search || '');

        // POST이면 포인트 차감 (생성 요청)
        let chargeResult = null;
        if (request.method === 'POST') {
          const estPoints = parseInt(request.headers.get('X-Estimated-Points') || '0');
          if (estPoints > 0) {
            chargeResult = await chargePoints(
              env,
              user.id,
              estPoints,
              'fal: ' + falPath,
              falPath,
              null,
              null
            );
            if (!chargeResult.ok) {
              if (chargeResult.error === 'insufficient_points') {
                return j({
                  error: 'insufficient_points',
                  balance: chargeResult.balance,
                  required: chargeResult.required,
                }, 402);
              }
              return j({ error: chargeResult.error }, 500);
            }
          }
        }

        const proxyHeaders = new Headers();
        proxyHeaders.set('Authorization', falAuthHeader(env));
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
          // fal 호출 실패 → 차감 환불
          if (chargeResult && chargeResult.charged > 0) {
            await refundPoints(env, user.id, chargeResult.charged, 'fal call failed: ' + falPath);
          }
          return j({ error: 'fal-proxy fetch failed', detail: e.message }, 502);
        }

        // fal이 4xx/5xx 반환 시 → 환불
        if (!falRes.ok && chargeResult && chargeResult.charged > 0) {
          await refundPoints(env, user.id, chargeResult.charged, 'fal error ' + falRes.status + ': ' + falPath);
        }

        const resHeaders = new Headers(corsHeaders);
        resHeaders.set('Content-Type', falRes.headers.get('Content-Type') || 'application/json');
        if (chargeResult) {
          resHeaders.set('X-Points-Charged', String(chargeResult.charged));
          resHeaders.set('X-Points-Remaining', String(chargeResult.remaining));
          resHeaders.set('X-Unlimited', chargeResult.unlimited ? '1' : '0');
        }
        return new Response(falRes.body, { status: falRes.status, headers: resHeaders });
      }

      // ─────────────────────────────────────────
      // 페이지 라우트
      // ─────────────────────────────────────────
      if (url.pathname === '/studio-drama' || url.pathname === '/studio-drama/' || url.pathname === '/studio-drama.html') {
        const assetUrl = new URL('/studio-drama.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }
      if (url.pathname === '/studio' || url.pathname === '/studio/') {
        const assetUrl = new URL('/studio.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }
      if (url.pathname === '/terms' || url.pathname === '/terms/') {
        const assetUrl = new URL('/terms.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }
      if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
        const assetUrl = new URL('/privacy.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }
      if (url.pathname === '/mypage' || url.pathname === '/mypage/') {
        const assetUrl = new URL('/mypage.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }

      // 나머지 — 정적 자산
      return await env.ASSETS.fetch(request);
    } catch (err) {
      return new Response('Internal Server Error: ' + (err.message || err), { status: 500 });
    }
  },
};

// ============================================
// 환불 (fal 호출 실패 시)
// ============================================
async function refundPoints(env, userId, amount, description) {
  const profile = await getProfile(env, userId);
  if (!profile) return;
  if (profile.unlimited) {
    await insertTransaction(env, userId, 'refund', 0, profile.points, description, null, null, null);
    return;
  }
  const newBalance = profile.points + amount;
  await fetch(
    env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + userId,
    {
      method: 'PATCH',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ points: newBalance }),
    }
  );
  await insertTransaction(env, userId, 'refund', amount, newBalance, description, null, null, null);
}
