-- ============================================================
-- community_posts 삭제 RLS 에러 해결
-- 실행 위치: Supabase 대시보드 → SQL Editor → New query
-- ============================================================

-- 1. 현재 정책 진단 (실행해서 결과 확인)
SELECT policyname, cmd, qual::text as USING_CLAUSE, with_check::text as CHECK_CLAUSE, roles
FROM pg_policies
WHERE tablename = 'community_posts'
ORDER BY cmd;

-- 2. 모든 community_posts 정책 삭제
DROP POLICY IF EXISTS "anyone_can_read_posts" ON public.community_posts;
DROP POLICY IF EXISTS "users_can_insert_own_post" ON public.community_posts;
DROP POLICY IF EXISTS "users_can_update_own_post" ON public.community_posts;
DROP POLICY IF EXISTS "users_can_delete_own_post" ON public.community_posts;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.community_posts;
DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.community_posts;

-- 3. RLS 재설정 — authenticated 역할에 명시적으로
ALTER TABLE public.community_posts ENABLE ROW LEVEL SECURITY;

-- 4. SELECT — 모두 (anon + authenticated) 읽기
CREATE POLICY "select_visible" ON public.community_posts
  FOR SELECT
  TO public
  USING (is_deleted = FALSE);

-- 5. INSERT — 본인만
CREATE POLICY "insert_own" ON public.community_posts
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- 6. UPDATE — 본인 게시물만 (USING + WITH CHECK 모두 동일 조건)
CREATE POLICY "update_own" ON public.community_posts
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 7. DELETE — 본인만
CREATE POLICY "delete_own" ON public.community_posts
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- 8. 결과 확인
SELECT policyname, cmd, roles, qual::text as USING_CLAUSE, with_check::text as CHECK_CLAUSE
FROM pg_policies
WHERE tablename = 'community_posts'
ORDER BY cmd;

SELECT '✅ RLS 정책 재설정 완료. 이제 게시물 삭제가 가능합니다.' AS message;
