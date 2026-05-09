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
    const tx = await insertTransaction(env, userId, 'usage', 0, profile.points, description, falEndpoint, requestId, metadata);
    return { ok: true, charged: 0, remaining: profile.points, unlimited: true, transactionId: tx ? tx.id : null };
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
  const tx = await insertTransaction(env, userId, 'usage', -chargedAmount, newBalance, description, falEndpoint, requestId, metadata);

  return { ok: true, charged: chargedAmount, remaining: newBalance, unlimited: false, transactionId: tx ? tx.id : null };
}

async function insertTransaction(env, userId, type, amount, balanceAfter, description, falEndpoint, requestId, metadata) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/point_transactions', {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',  // 삽입된 row 반환 (id 추출에 필요)
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
  if (!r.ok) return null;
  try {
    const arr = await r.json();
    return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
  } catch (e) {
    return null;
  }
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
      // ─────────────────────────────────────────
      // /api/community-post-reward — 폐지됨 (v2.0 크레딧 시스템)
      // 자체 화폐 발행 위험 회피를 위해 보상 시스템 제거
      // 옛 클라이언트가 호출해도 안전하게 응답 (글 작성은 정상 처리됨)
      // ─────────────────────────────────────────
      if (url.pathname === '/api/community-post-reward') {
        return j({ ok: false, error: 'reward_system_deprecated', message: '글 작성 보상은 폐지되었습니다.' }, 200);
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
      // /api/credits — 신규: 크레딧 잔액 + 구독 + 패키지 통합 조회
      // ─────────────────────────────────────────
      if (url.pathname === '/api/credits') {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);

        // 만료된 패키지 자동 정리
        await expireOldPacks(env, user.id);
        // 죽은 작업 정리
        await cleanupStaleJobs(env, user.id);

        const balance = await getCreditBalance(env, user.id);
        const sub = await getActiveSubscription(env, user.id);
        const packs = await getActivePacks(env, user.id);

        // 동시 작업 한도
        const limit = sub ? (PLAN_LIMITS[sub.plan] || 1) : NO_SUB_LIMIT;
        const nowIso = new Date().toISOString();
        const jobsResp = await fetch(
          env.SUPABASE_URL + '/rest/v1/active_jobs?user_id=eq.' + user.id +
          '&expires_at=gt.' + encodeURIComponent(nowIso),
          { headers: sbHeaders(env) }
        );
        const activeJobs = jobsResp.ok ? (await jobsResp.json()) : [];

        return j({
          user_id: user.id,
          email: user.email,
          balance: {
            subscription: Number(balance.subscription_credits) || 0,
            pack: Number(balance.pack_credits) || 0,
            total: Math.round((Number(balance.subscription_credits) + Number(balance.pack_credits)) * 10) / 10,
          },
          subscription: sub ? {
            plan: sub.plan,
            status: sub.status,
            next_billing: sub.next_billing,
            started_at: sub.started_at,
            amount: sub.amount,
          } : null,
          packs: packs.map(p => ({
            id: p.id,
            credits: Number(p.credits),
            used: Number(p.used || 0),
            remaining: Math.round((Number(p.credits) - Number(p.used || 0)) * 10) / 10,
            expires_at: p.expires_at,
            purchased_at: p.purchased_at,
          })),
          concurrent: {
            active: Array.isArray(activeJobs) ? activeJobs.length : 0,
            limit: limit,
          },
        });
      }

      // ─────────────────────────────────────────
      // /api/job/start — 동시 작업 시작 (락 획득)
      // POST { job_type, model }
      // ─────────────────────────────────────────
      if (url.pathname === '/api/job/start') {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);
        if (request.method !== 'POST') return j({ error: 'method' }, 405);

        const body = await request.json().catch(() => ({}));
        const jobType = body.job_type || 'image';
        const model = body.model || null;

        // 죽은 작업 먼저 정리
        await cleanupStaleJobs(env, user.id);

        const result = await startActiveJob(env, user.id, jobType, model);
        if (!result.ok) {
          return j(result, result.error === 'concurrent_limit_reached' ? 429 : 500);
        }
        return j(result);
      }

      // ─────────────────────────────────────────
      // /api/job/end — 동시 작업 종료 (락 해제)
      // POST { job_id }
      // ─────────────────────────────────────────
      if (url.pathname === '/api/job/end') {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);
        if (request.method !== 'POST') return j({ error: 'method' }, 405);

        const body = await request.json().catch(() => ({}));
        const jobId = body.job_id;

        await endActiveJob(env, jobId);
        return j({ ok: true });
      }

      // ─────────────────────────────────────────
      // /api/credits/consume — 크레딧 차감 (개발/테스트용)
      // POST { amount, description, ref_id }
      // ─────────────────────────────────────────
      if (url.pathname === '/api/credits/consume') {
        const user = await getUserFromJWT(request, env);
        if (!user) return j({ error: 'unauthorized' }, 401);
        if (request.method !== 'POST') return j({ error: 'method' }, 405);

        const body = await request.json().catch(() => ({}));
        const amount = Number(body.amount);
        if (!amount || amount <= 0) return j({ error: 'invalid_amount' }, 400);

        const result = await consumeCredits(env, user.id, amount, body.description || '', body.ref_id || null);
        if (!result.ok) {
          return j(result, result.error === 'insufficient_credits' ? 402 : 500);
        }
        return j(result);
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

        // request_id 추출 (URL에서 먼저 — 422 응답에도 항상 가능)
        const _reqIdFromUrl = (() => {
          const m = targetUrl.match(/\/requests\/([^/?]+)/);
          return m ? m[1] : null;
        })();

        let _shouldRefund = false;
        let _refundReason = '';

        // ① HTTP 상태 자체가 성공 아닌지 (4xx/5xx) — 환불 의심
        if (!falRes.ok) {
          _shouldRefund = true;
          _refundReason = 'http ' + falRes.status;
        }

        try {
          // JSON일 때만 파싱 시도
          if (resContentType.includes('json') && bodyText) {
            const data = JSON.parse(bodyText);
            const statusVal = data && data.status;
            const reqId = (data && data.request_id) || _reqIdFromUrl;

            // detail 배열에서 content_policy_violation 감지
            let detailViolation = null;
            if (Array.isArray(data.detail)) {
              const v = data.detail.find(x => x && (x.type === 'content_policy_violation' || x.type === 'violation' || (x.msg && /content|moderation|policy|violation|flagged/i.test(x.msg))));
              if (v) detailViolation = v.type || v.msg || 'violation';
            } else if (typeof data.detail === 'string') {
              if (/content|moderation|policy|violation|flagged/i.test(data.detail)) detailViolation = data.detail;
            }

            console.log('[refund-check]', { httpStatus: falRes.status, statusVal, reqId, hasError: !!data.error, detailViolation });

            // ② FAILED / ERROR 상태 또는 error 필드 또는 detail 안 violation
            if (statusVal === 'FAILED' || statusVal === 'ERROR' || data.error || detailViolation) {
              _shouldRefund = true;
              _refundReason = data.error || detailViolation || statusVal || 'error';
            }
            // ③ COMPLETED인데 결과 URL이 없는 경우
            else if (!statusVal && (data.images || data.video || data.url || data.image)) {
              const hasResult = !!(
                (data.images && data.images.length > 0 && data.images[0].url) ||
                (data.image && data.image.url) ||
                (data.video && data.video.url) ||
                data.url
              );
              if (!hasResult) {
                _shouldRefund = true;
                _refundReason = 'completed but no result';
              }
            }

            if (_shouldRefund && reqId) {
              await refundForRequest(env, user.id, reqId, 'fal: ' + String(_refundReason).substring(0, 100));
            }
          } else if (_shouldRefund && _reqIdFromUrl) {
            // JSON 아니지만 HTTP 에러 — reqId는 URL에서 추출
            await refundForRequest(env, user.id, _reqIdFromUrl, 'fal: ' + _refundReason);
          }
        } catch (e) {
          // 파싱 실패지만 HTTP 에러이면 환불 도전
          console.log('[refund-check parse fail]', e.message);
          if (_shouldRefund && _reqIdFromUrl) {
            await refundForRequest(env, user.id, _reqIdFromUrl, 'fal: ' + _refundReason + ' (parse failed)');
          }
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

        // POST 성공 + 차감했으면 fal request_id를 거래에 연결 (정확한 거래 ID로만 매칭)
        if (request.method === 'POST' && falRes.ok && chargeResult && chargeResult.charged > 0 && chargeResult.transactionId) {
          try {
            if (resContentType_p.includes('json') && bodyText_p) {
              const data_p = JSON.parse(bodyText_p);
              const reqId_p = data_p && data_p.request_id;
              if (reqId_p) {
                // 정확한 거래 ID로만 PATCH — 다른 거래 덮어쓰기 방지
                await fetch(
                  env.SUPABASE_URL + '/rest/v1/point_transactions?id=eq.' + chargeResult.transactionId,
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

// ============================================================
// 신규 크레딧 시스템 (v2.0) — 구독 · 패키지 · 동시작업
// 독립적으로 설계 (기존 chargePoints/profile 시스템과 병행)
// ============================================================

// PostgREST 공통 헤더
function sbHeaders(env, extra) {
  return Object.assign({
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}

// 1) 활성 구독 조회 (active or null)
async function getActiveSubscription(env, userId) {
  const r = await fetch(
    env.SUPABASE_URL + '/rest/v1/subscriptions?user_id=eq.' + userId +
    '&status=eq.active&order=started_at.desc&limit=1',
    { headers: sbHeaders(env) }
  );
  if (!r.ok) return null;
  const arr = await r.json();
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

// 2) 크레딧 잔액 조회 (구독 + 패키지 통합)
async function getCreditBalance(env, userId) {
  const r = await fetch(
    env.SUPABASE_URL + '/rest/v1/credit_balances?user_id=eq.' + userId,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length === 0) {
    // 잔액 row 없으면 생성
    await fetch(env.SUPABASE_URL + '/rest/v1/credit_balances', {
      method: 'POST',
      headers: sbHeaders(env, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ user_id: userId, subscription_credits: 0, pack_credits: 0 }),
    });
    return { user_id: userId, subscription_credits: 0, pack_credits: 0, subscription_reset_at: null };
  }
  return arr[0];
}

// 3) 유효한 패키지 조회 (만료 안 됐고 잔액 있는 것)
async function getActivePacks(env, userId) {
  const nowIso = new Date().toISOString();
  const r = await fetch(
    env.SUPABASE_URL + '/rest/v1/credit_packs?user_id=eq.' + userId +
    '&status=eq.active&expires_at=gt.' + encodeURIComponent(nowIso) +
    '&order=expires_at.asc',
    { headers: sbHeaders(env) }
  );
  if (!r.ok) return [];
  const arr = await r.json();
  return Array.isArray(arr) ? arr : [];
}

// 4) 크레딧 사용 (구독 우선, 부족하면 패키지에서, 패키지는 만료 임박 우선)
async function consumeCredits(env, userId, amount, description, refId) {
  const balance = await getCreditBalance(env, userId);
  if (!balance) return { ok: false, error: 'balance_not_found' };

  const subAvail = Number(balance.subscription_credits) || 0;
  const packAvail = Number(balance.pack_credits) || 0;
  const total = subAvail + packAvail;
  const need = Math.round(amount * 10) / 10;

  if (total < need) {
    return { ok: false, error: 'insufficient_credits', balance: total, required: need };
  }

  let fromSub = Math.min(subAvail, need);
  let fromPack = Math.round((need - fromSub) * 10) / 10;
  let newSub = Math.round((subAvail - fromSub) * 10) / 10;
  let newPack = Math.round((packAvail - fromPack) * 10) / 10;

  // 1) credit_balances 갱신
  const upd = await fetch(
    env.SUPABASE_URL + '/rest/v1/credit_balances?user_id=eq.' + userId,
    {
      method: 'PATCH',
      headers: sbHeaders(env, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        subscription_credits: newSub,
        pack_credits: newPack,
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!upd.ok) return { ok: false, error: 'update_failed' };

  // 2) 패키지에서 차감했으면 개별 패키지의 used 도 갱신 (오래된 게 먼저)
  if (fromPack > 0) {
    const packs = await getActivePacks(env, userId);
    let remaining = fromPack;
    for (const p of packs) {
      if (remaining <= 0) break;
      const avail = Math.round((Number(p.credits) - Number(p.used || 0)) * 10) / 10;
      const take = Math.min(avail, remaining);
      if (take > 0) {
        const newUsed = Math.round((Number(p.used || 0) + take) * 10) / 10;
        const isDepleted = (newUsed >= Number(p.credits));
        await fetch(
          env.SUPABASE_URL + '/rest/v1/credit_packs?id=eq.' + p.id,
          {
            method: 'PATCH',
            headers: sbHeaders(env, { 'Prefer': 'return=minimal' }),
            body: JSON.stringify({
              used: newUsed,
              status: isDepleted ? 'depleted' : 'active',
            }),
          }
        );
        remaining = Math.round((remaining - take) * 10) / 10;
      }
    }
  }

  // 3) 트랜잭션 기록
  await fetch(env.SUPABASE_URL + '/rest/v1/credit_transactions', {
    method: 'POST',
    headers: sbHeaders(env, { 'Prefer': 'return=minimal' }),
    body: JSON.stringify({
      user_id: userId,
      type: 'consume',
      amount: -need,
      source: fromPack > 0 ? (fromSub > 0 ? 'subscription' : 'pack') : 'subscription',
      ref_id: refId || null,
      description: description || null,
    }),
  });

  return {
    ok: true,
    consumed: need,
    fromSub,
    fromPack,
    remaining_sub: newSub,
    remaining_pack: newPack,
    remaining_total: Math.round((newSub + newPack) * 10) / 10,
  };
}

// 5) 동시 작업 시작 (플랜별 한도 검사 포함)
const PLAN_LIMITS = { lite: 1, standard: 3, pro: 6 };
const NO_SUB_LIMIT = 1;

async function startActiveJob(env, userId, jobType, model) {
  const nowIso = new Date().toISOString();
  // 1) 만료 안 된 활성 작업 조회
  const r = await fetch(
    env.SUPABASE_URL + '/rest/v1/active_jobs?user_id=eq.' + userId +
    '&expires_at=gt.' + encodeURIComponent(nowIso),
    { headers: sbHeaders(env) }
  );
  const jobs = r.ok ? (await r.json()) : [];
  const activeCount = Array.isArray(jobs) ? jobs.length : 0;

  // 2) 한도 계산 (구독 플랜 기반)
  const sub = await getActiveSubscription(env, userId);
  const limit = sub ? (PLAN_LIMITS[sub.plan] || 1) : NO_SUB_LIMIT;

  if (activeCount >= limit) {
    return { ok: false, error: 'concurrent_limit_reached', active: activeCount, limit };
  }

  // 3) 새 작업 등록 (5분 후 자동 만료)
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const ins = await fetch(env.SUPABASE_URL + '/rest/v1/active_jobs', {
    method: 'POST',
    headers: sbHeaders(env, { 'Prefer': 'return=representation' }),
    body: JSON.stringify({
      user_id: userId,
      job_type: jobType,
      model: model || null,
      expires_at: expiresAt,
    }),
  });
  if (!ins.ok) return { ok: false, error: 'job_insert_failed' };
  const data = await ins.json();
  const jobId = Array.isArray(data) && data.length > 0 ? data[0].id : null;

  return { ok: true, job_id: jobId, active: activeCount + 1, limit };
}

// 6) 동시 작업 종료
async function endActiveJob(env, jobId) {
  if (!jobId) return { ok: true };
  await fetch(
    env.SUPABASE_URL + '/rest/v1/active_jobs?id=eq.' + jobId,
    { method: 'DELETE', headers: sbHeaders(env) }
  );
  return { ok: true };
}

// 7) 죽은 active_jobs 정리 (5분 이상 된 것 삭제)
async function cleanupStaleJobs(env, userId) {
  const nowIso = new Date().toISOString();
  await fetch(
    env.SUPABASE_URL + '/rest/v1/active_jobs?user_id=eq.' + userId +
    '&expires_at=lt.' + encodeURIComponent(nowIso),
    { method: 'DELETE', headers: sbHeaders(env) }
  );
}

// 8) 패키지 만료 정리 (사용자별 시도)
async function expireOldPacks(env, userId) {
  const nowIso = new Date().toISOString();
  const r = await fetch(
    env.SUPABASE_URL + '/rest/v1/credit_packs?user_id=eq.' + userId +
    '&status=eq.active&expires_at=lt.' + encodeURIComponent(nowIso),
    { headers: sbHeaders(env) }
  );
  if (!r.ok) return;
  const expired = await r.json();
  if (!Array.isArray(expired) || expired.length === 0) return;

  let totalExpired = 0;
  for (const p of expired) {
    const remaining = Math.round((Number(p.credits) - Number(p.used || 0)) * 10) / 10;
    if (remaining > 0) totalExpired += remaining;
    await fetch(
      env.SUPABASE_URL + '/rest/v1/credit_packs?id=eq.' + p.id,
      {
        method: 'PATCH',
        headers: sbHeaders(env, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ status: 'expired' }),
      }
    );
  }

  if (totalExpired > 0) {
    const balance = await getCreditBalance(env, userId);
    if (balance) {
      const newPack = Math.max(0, Math.round((Number(balance.pack_credits) - totalExpired) * 10) / 10);
      await fetch(
        env.SUPABASE_URL + '/rest/v1/credit_balances?user_id=eq.' + userId,
        {
          method: 'PATCH',
          headers: sbHeaders(env, { 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ pack_credits: newPack, updated_at: new Date().toISOString() }),
        }
      );
    }
  }
}

