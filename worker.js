export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /studio 또는 /studio/ → studio.html 서빙
    if (url.pathname === '/studio' || url.pathname === '/studio/') {
      const assetUrl = new URL('/studio.html', request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // /terms 또는 /terms/ → terms.html 서빙
    if (url.pathname === '/terms' || url.pathname === '/terms/') {
      const assetUrl = new URL('/terms.html', request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // /privacy 또는 /privacy/ → privacy.html 서빙
    if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
      const assetUrl = new URL('/privacy.html', request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    // 나머지 요청은 assets에서 처리
    return env.ASSETS.fetch(request);
  }
};
