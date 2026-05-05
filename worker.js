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

// secret 값 정화 — BOM(U+FEFF), 양쪽 공백, 따옴표, 줄바꿈, 제어문자 제거
function clean(v) {
  if (!v) return '';
  return String(v)
    .replace(/^\uFEFF/, '')
    .replace(/^[\s\u0000-\u001F"']+|[\s\u0000-\u001F"']+$/g, '');
}

function getEnv(env) {
  return {
    SUPABASE_URL: clean(env.SUPABASE_URL).replace(/\/$/, ''),
    SUPABASE_SERVICE_KEY: clean(env.SUPABASE_SERVICE_KEY),
    FAL_API_KEY: clean(env.FAL_API_KEY),
    ASSETS: env.ASSETS,
  };
}

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

  // 차감 (PostgREST PATCH) — 부동소수 오차 방지: 소수점 둘째 자리까지 round
  const newBalance = Math.round((profile.points - amount) * 100) / 100;
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

  // 차감액도 소수점 둘째 자리까지 round (transactions 기록 일관성)
  const chargedAmount = Math.round(amount * 100) / 100;
  await insertTransaction(env, userId, 'usage', -chargedAmount, newBalance, description, falEndpoint, requestId, metadata);

  return { ok: true, charged: chargedAmount, remaining: newBalance, unlimited: false };
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
  async fetch(request, rawEnv) {
    try {
      const env = getEnv(rawEnv);
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
      // ★ 폴링 응답이 FAILED/ERROR면 자동 환불 (검열·생성 실패 시 보호)
      // ★ COMPLETED인데 결과 URL 없으면 환불
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

        // 응답 body를 읽어서 FAILED/ERROR 또는 결과 누락 감지 (환불 처리)
        // body를 한 번 읽으면 stream 소진되므로 text로 읽고 다시 Response 생성
        const resContentType = falRes.headers.get('Content-Type') || 'application/json';
        const bodyText = await falRes.text();

        try {
          // JSON일 때만 파싱 시도
          if (resContentType.includes('json') && bodyText) {
            const data = JSON.parse(bodyText);
            const statusVal = data && data.status;
            // request_id 추출 (환불 메모용)
            const reqId = (data && data.request_id) || (() => {
              // status_url path에서 추출 (e.g. /openai/.../requests/<id>/status)
              const m = targetUrl.match(/\/requests\/([^/?]+)/);
              return m ? m[1] : null;
            })();

            // ① FAILED / ERROR 상태
            if (statusVal === 'FAILED' || statusVal === 'ERROR') {
              await refundForRequest(env, user.id, reqId, 'fal status=' + statusVal);
            }
            // ② COMPLETED인데 결과 URL이 없는 경우 (검열로 결과 비어있음)
            else if (statusVal === 'COMPLETED' || (!statusVal && (data.images || data.video || data.url || data.image))) {
              // status_url이 아니라 response_url에서 받은 결과 응답
              // status === 'COMPLETED' 면 폴링 응답, status 없으면 response 응답
              const hasResult = !!(
                (data.images && data.images.length > 0 && data.images[0].url) ||
                (data.image && data.image.url) ||
                (data.video && data.video.url) ||
                data.url
              );
              // status === 'COMPLETED'인 폴링 응답에는 결과가 없을 수 있으므로 (response_url 따로 fetch)
              // 진짜 결과 응답인 경우에만 검사 — status 없이 images/video/url 키 있는 경우
              if (!statusVal && !hasResult) {
                await refundForRequest(env, user.id, reqId, 'fal completed but no result (likely content moderation)');
              }
            }
          }
        } catch (e) {
          // 파싱 실패는 무시 (환불 안 함, 정상 응답일 가능성 있음)
        }

        const resHeaders = new Headers(corsHeaders);
        resHeaders.set('Content-Type', resContentType);
        return new Response(bodyText, { status: falRes.status, headers: resHeaders });
      }

      // ─────────────────────────────────────────
      // /fal-sync/<endpoint_path> — fal.run 직접 호출 (이미지 생성용, 즉시 응답)
      // queue 패턴 안 쓰는 빠른 작업에 사용
      // ─────────────────────────────────────────
      if (url.pathname.startsWith('/fal-sync/')) {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);

        const falPath = url.pathname.replace('/fal-sync/', '');
        const falUrl = 'https://fal.run/' + falPath + (url.search || '');

        let chargeResult = null;
        if (request.method === 'POST') {
          const estPoints = parseFloat(request.headers.get('X-Estimated-Points') || '0');
          if (estPoints > 0) {
            chargeResult = await chargePoints(env, user.id, estPoints, 'fal: ' + falPath, falPath, null, null);
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
          if (chargeResult && chargeResult.charged > 0) {
            await refundPoints(env, user.id, chargeResult.charged, 'fal call failed: ' + falPath);
          }
          return j({ error: 'fal-sync fetch failed', detail: e.message }, 502);
        }

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
      // /fal-proxy/<endpoint_path>      // /fal-proxy/<endpoint_path>
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
          const estPoints = parseFloat(request.headers.get('X-Estimated-Points') || '0');
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

        // 응답 body를 한 번 읽어서 request_id 추출 → 거래 기록에 연결
        const resContentType_p = falRes.headers.get('Content-Type') || 'application/json';
        const bodyText_p = await falRes.text();

        // POST 성공 + 차감했으면 fal request_id를 거래에 연결 (나중에 환불 시 매칭용)
        if (request.method === 'POST' && falRes.ok && chargeResult && chargeResult.charged > 0) {
          try {
            if (resContentType_p.includes('json') && bodyText_p) {
              const data_p = JSON.parse(bodyText_p);
              const reqId_p = data_p && data_p.request_id;
              if (reqId_p) {
                // 방금 삽입된 거래 (fal_request_id가 null인 가장 최근 usage)에 request_id update
                await fetch(
                  env.SUPABASE_URL + '/rest/v1/point_transactions?user_id=eq.' + user.id +
                  '&fal_endpoint=eq.' + encodeURIComponent(falPath) +
                  '&fal_request_id=is.null&type=eq.usage&order=created_at.desc&limit=1',
                  {
                    method: 'PATCH',
                    headers: {
                      'apikey': env.SUPABASE_SERVICE_KEY,
                      'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
                      'Content-Type': 'application/json',
                      'Prefer': 'return=minimal',
                    },
                    body: JSON.stringify({ fal_request_id: reqId_p }),
                  }
                );
              }
            }
          } catch (e) {
            // request_id 연결 실패시 무시 (차감/응답엔 영향 없음)
          }
        }

        const resHeaders = new Headers(corsHeaders);
        resHeaders.set('Content-Type', resContentType_p);
        if (chargeResult) {
          resHeaders.set('X-Points-Charged', String(chargeResult.charged));
          resHeaders.set('X-Points-Remaining', String(chargeResult.remaining));
          resHeaders.set('X-Unlimited', chargeResult.unlimited ? '1' : '0');
        }
        return new Response(bodyText_p, { status: falRes.status, headers: resHeaders });
      }

      // ─────────────────────────────────────────
      // 페이지 라우트
      // ─────────────────────────────────────────
      // 루트 / → community.html (홈 = 커뮤니티)
      if (url.pathname === '/' || url.pathname === '/index' || url.pathname === '/index.html') {
        const assetUrl = new URL('/community.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }
      if (url.pathname === '/community' || url.pathname === '/community/') {
        const assetUrl = new URL('/community.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }
      if (url.pathname === '/subscription' || url.pathname === '/subscription/' || url.pathname === '/pricing') {
        const assetUrl = new URL('/subscription.html', request.url);
        return await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }
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
  // 부동소수 오차 방지
  const refundAmount = Math.round(amount * 100) / 100;
  const newBalance = Math.round((profile.points + refundAmount) * 100) / 100;
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
  await insertTransaction(env, userId, 'refund', refundAmount, newBalance, description, null, null, null);
}

// ============================================
// request_id 기반 환불 — 해당 request의 차감 거래 찾아서 동일 금액 환불
// 동일 request_id에 이미 환불 거래 있으면 중복 환불 방지
// ============================================
async function refundForRequest(env, userId, requestId, reason) {
  if (!requestId) return;
  try {
    // 1) 해당 request_id의 거래 모두 조회
    const r = await fetch(
      env.SUPABASE_URL + '/rest/v1/point_transactions?user_id=eq.' + userId +
      '&fal_request_id=eq.' + requestId + '&order=created_at.asc',
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
        },
      }
    );
    if (!r.ok) return;
    const txs = await r.json();
    if (!Array.isArray(txs) || txs.length === 0) return;

    // 2) 사용 거래(usage, amount<0) 중 환불 안 된 것 찾기
    const usageTx = txs.find(t => t.type === 'usage' && Number(t.amount) < 0);
    if (!usageTx) return;
    const alreadyRefunded = txs.some(t => t.type === 'refund');
    if (alreadyRefunded) return;  // 중복 환불 방지

    // 3) 환불 (사용액의 절대값을 다시 더해줌)
    const amount = Math.abs(Number(usageTx.amount));
    if (amount > 0) {
      await refundPoints(env, userId, amount, '자동 환불 (' + reason + '): ' + requestId);
    }
  } catch (e) {
    // 환불 실패는 조용히 무시 (서비스 영향 없게)
  }
}
