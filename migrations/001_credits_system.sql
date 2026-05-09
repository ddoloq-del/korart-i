-- ============================================================
-- Korart-i 신규 결제·크레딧 시스템 스키마 (v2.0)
-- 적용 시점: 비츄가 Supabase 콘솔에서 SQL Editor로 직접 실행
-- ============================================================
-- 변경 내역:
--   - 기존 포인트(P) 시스템 → 크레딧(Credit) 시스템 전환
--   - 구독제 (Lite/Standard/Pro) + 1회 패키지 병행
--   - 동시 작업 제한 추가 (1/3/6)
--   - 선불수단 회피 구조 (네이버페이 통과용)
-- ============================================================

-- ============================================================
-- 1. 구독 정보 (subscriptions)
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan          text NOT NULL CHECK (plan IN ('lite', 'standard', 'pro')),
  status        text NOT NULL CHECK (status IN ('active', 'canceled', 'past_due', 'expired')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  next_billing  timestamptz NOT NULL,
  canceled_at   timestamptz,
  toss_billing_key text,
  toss_customer_key text,
  amount        integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status 
  ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing 
  ON subscriptions(next_billing) WHERE status = 'active';

COMMENT ON TABLE subscriptions IS '월 자동결제 구독 정보';
COMMENT ON COLUMN subscriptions.plan IS 'lite=9,900원/100크레딧, standard=29,000/350, pro=79,000/1000';
COMMENT ON COLUMN subscriptions.toss_billing_key IS '토스페이먼츠 빌링키 (정기결제용)';

-- ============================================================
-- 2. 크레딧 잔액 (credit_balances)
-- ============================================================
CREATE TABLE IF NOT EXISTS credit_balances (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_credits numeric(10,2) NOT NULL DEFAULT 0,
  pack_credits         numeric(10,2) NOT NULL DEFAULT 0,
  subscription_reset_at timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE credit_balances IS '사용자별 크레딧 잔액 (캐시)';
COMMENT ON COLUMN credit_balances.subscription_credits IS '구독으로 발급된 크레딧 (월별 리셋)';
COMMENT ON COLUMN credit_balances.pack_credits IS '1회 패키지 크레딧 (30일 후 만료)';

-- ============================================================
-- 3. 1회 패키지 크레딧 (credit_packs)
-- ============================================================
CREATE TABLE IF NOT EXISTS credit_packs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credits       numeric(10,2) NOT NULL,
  used          numeric(10,2) NOT NULL DEFAULT 0,
  purchased_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'depleted', 'refunded')),
  toss_payment_key text,
  amount        integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_packs_user_status 
  ON credit_packs(user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_credit_packs_expires 
  ON credit_packs(expires_at) WHERE status = 'active';

COMMENT ON TABLE credit_packs IS '1회 패키지 결제 (30일 후 자동 소멸)';

-- ============================================================
-- 4. 크레딧 사용 내역 (credit_transactions)
-- ============================================================
CREATE TABLE IF NOT EXISTS credit_transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('charge', 'consume', 'refund', 'expire', 'adjust')),
  amount      numeric(10,2) NOT NULL,
  source      text CHECK (source IN ('subscription', 'pack', 'gift', 'refund')),
  ref_id      text,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_created 
  ON credit_transactions(user_id, created_at DESC);

COMMENT ON TABLE credit_transactions IS '크레딧 거래 내역 (충전/사용/환불/만료)';
COMMENT ON COLUMN credit_transactions.amount IS '+ 충전, - 차감 (NUMERIC 소수점 가능)';

-- ============================================================
-- 5. 동시 작업 추적 (active_jobs)
-- ============================================================
CREATE TABLE IF NOT EXISTS active_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_type    text NOT NULL CHECK (job_type IN ('image', 'video', 'avatar', 'sketch_upgrade')),
  model       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_active_jobs_user_expires 
  ON active_jobs(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_active_jobs_cleanup 
  ON active_jobs(expires_at);

COMMENT ON TABLE active_jobs IS '실행 중인 AI 생성 작업 (동시 작업 제한용)';
COMMENT ON COLUMN active_jobs.expires_at IS '안전 만료 (5분 후, 멈춘 작업 자동 정리)';

-- ============================================================
-- 6. 만료된 패키지 자동 정리 함수
-- ============================================================
CREATE OR REPLACE FUNCTION expire_old_packs() 
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE credit_packs
  SET status = 'expired'
  WHERE status = 'active' 
    AND expires_at < now();
  
  -- 만료된 잔액을 transactions에 기록
  INSERT INTO credit_transactions (user_id, type, amount, source, ref_id, description)
  SELECT user_id, 'expire', -(credits - used), 'pack', id::text, '1회 패키지 30일 만료'
  FROM credit_packs
  WHERE status = 'expired'
    AND (credits - used) > 0
    AND id NOT IN (SELECT ref_id::uuid FROM credit_transactions WHERE type = 'expire' AND ref_id IS NOT NULL);
END;
$$;

COMMENT ON FUNCTION expire_old_packs IS '만료된 1회 패키지 정리 (cron으로 일 1회 실행)';

-- ============================================================
-- 7. 죽은 active_jobs 정리 함수 (5분 이상 된 것)
-- ============================================================
CREATE OR REPLACE FUNCTION cleanup_stale_jobs()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM active_jobs WHERE expires_at < now();
END;
$$;

COMMENT ON FUNCTION cleanup_stale_jobs IS '멈춘 active_jobs 자동 정리 (cron으로 분당 1회 실행)';

-- ============================================================
-- 8. RLS (Row Level Security) 정책
-- ============================================================
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE active_jobs ENABLE ROW LEVEL SECURITY;

-- 본인 데이터만 조회 가능
CREATE POLICY "Users see own subscriptions" 
  ON subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users see own balance" 
  ON credit_balances FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users see own packs" 
  ON credit_packs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users see own transactions" 
  ON credit_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users see own active jobs" 
  ON active_jobs FOR SELECT USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE는 worker.js (service role)에서만 처리

-- ============================================================
-- 9. 초기 마이그레이션 (기존 사용자 → 빈 잔액 행 생성)
-- ============================================================
INSERT INTO credit_balances (user_id, subscription_credits, pack_credits)
SELECT id, 0, 0 FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- 끝
-- ============================================================