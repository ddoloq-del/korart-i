-- ============================================================
-- 좋아요 + 댓글 + 운영자 삭제 권한 SQL
-- 실행 위치: Supabase 대시보드 → SQL Editor → New query
-- ============================================================

-- ============================================================
-- 1. 좋아요 테이블 (이미 있을 수 있음 - IF NOT EXISTS)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.community_likes (
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id    UUID NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

ALTER TABLE public.community_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_likes" ON public.community_likes;
DROP POLICY IF EXISTS "anyone_can_read_likes" ON public.community_likes;
DROP POLICY IF EXISTS "users_can_insert_own_like" ON public.community_likes;
DROP POLICY IF EXISTS "users_can_delete_own_like" ON public.community_likes;

CREATE POLICY "select_likes" ON public.community_likes
  FOR SELECT TO public USING (TRUE);

CREATE POLICY "insert_own_like" ON public.community_likes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "delete_own_like" ON public.community_likes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ============================================================
-- 2. 댓글 테이블
-- ============================================================
CREATE TABLE IF NOT EXISTS public.community_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       UUID NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content       TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
  user_nickname TEXT,
  user_avatar   TEXT,
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ccomments_post ON public.community_comments (post_id, created_at DESC);

ALTER TABLE public.community_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_comments" ON public.community_comments;
DROP POLICY IF EXISTS "insert_comment" ON public.community_comments;
DROP POLICY IF EXISTS "delete_comment" ON public.community_comments;

CREATE POLICY "select_comments" ON public.community_comments
  FOR SELECT TO public USING (is_deleted = FALSE);

CREATE POLICY "insert_comment" ON public.community_comments
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- 댓글 삭제: 본인 OR 게시물 작성자 OR 운영자
-- 운영자는 ddoloq@gmail.com (auth.users 테이블의 email로 체크)
CREATE POLICY "delete_comment" ON public.community_comments
  FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id
    OR auth.uid() IN (SELECT user_id FROM public.community_posts WHERE id = post_id)
    OR (SELECT email FROM auth.users WHERE id = auth.uid()) = 'ddoloq@gmail.com'
  );

-- ============================================================
-- 3. community_posts에 운영자 삭제 정책 추가
-- ============================================================
DROP POLICY IF EXISTS "admin_can_delete_any_post" ON public.community_posts;

CREATE POLICY "admin_can_delete_any_post" ON public.community_posts
  FOR DELETE TO authenticated
  USING ((SELECT email FROM auth.users WHERE id = auth.uid()) = 'ddoloq@gmail.com');

-- 기존 본인 삭제 정책 유지 — 합집합으로 작동 (둘 중 하나만 통과해도 OK)

-- ============================================================
-- 4. likes_count 캐시 컬럼은 community_posts.likes 그대로 사용
-- count는 client 측에서 community_likes count로 갱신
-- ============================================================

-- ============================================================
-- 5. 결과 확인
-- ============================================================
SELECT 'community_likes' AS table_name, COUNT(*) FROM public.community_likes
UNION ALL
SELECT 'community_comments', COUNT(*) FROM public.community_comments;

SELECT '✅ 좋아요/댓글 테이블 + 운영자 삭제 권한 설정 완료!' AS message;

-- 정책 확인
SELECT tablename, policyname, cmd, roles
FROM pg_policies
WHERE tablename IN ('community_posts', 'community_likes', 'community_comments')
ORDER BY tablename, cmd, policyname;
