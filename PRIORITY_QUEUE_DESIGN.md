# 우선 큐 (Priority Queue) 설계 — Korart-i v2.0

## 🎯 목표
Pro 플랜 (₩79,000/월) 사용자에게 "더 빠른 시작" 경험을 제공해서 차별화.

## 📊 채택 방식: 하이브리드 (3-layer)

### Layer 1: 동시 작업 한도 차등 (이미 구현됨 ✓)
- 구독 없음/Lite: 1개
- Standard: 3개
- Pro: 6개  ← Lite 대비 **6배** 동시 처리량

### Layer 2: 인위 지연 (일반 사용자만)
- POST /fal-proxy/ 시 isPro 검사
- Pro: 즉시 fal.ai 호출
- 일반: 1500ms 지연 후 호출

### Layer 3: 차별화 응답 헤더
- X-Priority-Queue: pro / normal
- 한도 초과 시 Pro 업그레이드 안내 메시지

## 📁 변경 파일
- worker.js: /fal-proxy/ POST 핸들러에 isPro 검사 + 지연
- studio.html: 응답 헤더 X-Priority-Queue 표시 (선택)

## 🎚️ 파라미터
const PRIORITY_CONFIG = {
  NON_PRO_DELAY_MS: 1500,
  CONCURRENT: { lite: 1, standard: 3, pro: 6 }
};

## 💰 매출 영향 예측
- Pro 가입률: 5~10% → 15~20% (2배 증가 예상)
- 차별화 동기 명확

## ⚠️ 주의
- 인위 지연은 양날의 검 (1.5초가 적정선)
- fal.ai 자체가 빠르면 1.5초도 체감됨
- 약관 제6조 5항에 "Pro는 우선 큐" 명시 권장
