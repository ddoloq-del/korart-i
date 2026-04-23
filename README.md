# Korart-i

Korean Artistic Intelligence — K-드라마부터 K-먹방까지, 한 번에.

## 파일 구조

```
korart-i/
├── index.html          # 메인 랜딩페이지
├── studio.html         # 영상 제작 스튜디오
└── README.md           # 이 파일
```

## 로컬 실행

특별한 빌드 과정 없이 브라우저로 바로 열 수 있습니다.

```bash
# 방법 1: 더블클릭으로 index.html 열기
# 방법 2: 간단한 로컬 서버 실행
python3 -m http.server 8000
# → http://localhost:8000 접속
```

## 배포 방법 (Cloudflare Pages)

### 1. GitHub 저장소 생성
- [github.com](https://github.com)에서 새 저장소 생성 (이름: `korart-i`)
- Public 설정

### 2. 파일 업로드
```bash
git init
git add .
git commit -m "Initial Korart-i"
git branch -M main
git remote add origin https://github.com/[YOUR_USERNAME]/korart-i.git
git push -u origin main
```

### 3. Cloudflare Pages 연결
1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages
2. Create → Pages → Connect to Git
3. `korart-i` 저장소 선택
4. 빌드 설정:
   - Framework preset: **None**
   - Build command: (비워두기)
   - Build output directory: **/**
5. Save and Deploy

배포 완료 후 `https://korart-i.pages.dev` 같은 URL 생성됨.

### 4. 커스텀 도메인 연결 (korarti.ai.kr)
1. 가비아에서 `korarti.ai.kr` 구매
2. Cloudflare에 도메인 추가
3. 가비아에서 네임서버를 Cloudflare 것으로 변경
4. Pages 프로젝트 → Custom domains → `korarti.ai.kr` 추가

## 딥 링크 지원

랜딩페이지에서 카테고리 카드 클릭 시 해당 카테고리로 바로 진입합니다:
- `studio.html#drama` → K-드라마
- `studio.html#idol` → K-아이돌
- `studio.html#variety` → K-예능

## 다음 작업 예정

- [ ] 이용약관 페이지 (`terms.html`)
- [ ] 개인정보처리방침 (`privacy.html`)
- [ ] 환불규정 (`refund.html`)
- [ ] 회원가입/로그인 (Supabase)
- [ ] 결제 연동 (Toss Payments)
- [ ] AI 영상 생성 백엔드 (Next.js + fal.ai)

---

© 2026 Korart-i · Built in Seoul
