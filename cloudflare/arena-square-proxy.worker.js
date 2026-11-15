/**
 * LLM Chess Arena: independent frontend delivery and temporary backend bridge.
 * Frontend is always fetched from the canonical public GitHub repository.
 * /api and /events are forwarded to the existing ephemeral tunnel until
 * the stateful Node backend can be migrated to a permanent host.
 */
const FRONTEND = 'https://raw.githubusercontent.com/Parris-Tech-Services/llm-chess-arena/main/public';
const BACKEND = 'https://chem-containing-bios-arbitrary.trycloudflare.com';
const STATIC = new Set(['/style.css','/app.js','/favicon.svg']);
const CONTENT_TYPE = {'/style.css':'text/css; charset=utf-8','/app.js':'application/javascript; charset=utf-8','/favicon.svg':'image/svg+xml'};
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};
const FALLBACK_HTML = '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chess Arena temporarily offline</title><body style="background:#0b0e13;color:white;font:16px system-ui;padding:20px"><h1>Chess Arena temporarily unavailable</h1><p>The frontend source could not be loaded. Please reload later.</p></body></html>';
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/_edge-health') return Response.json({ok:true,frontend:'GitHub main',backend:'temporary Cloudflare tunnel',squareBoard:true},{headers:{'cache-control':'no-store'}});
    if (request.method === 'GET' && (path === '/' || path === '/index.html' || path.startsWith('/g/') || STATIC.has(path))) {
      const isHtml = path === '/' || path === '/index.html' || path.startsWith('/g/');
      const gitFile = isHtml ? 'index.html' : path.slice(1);
      try {
        const source = await fetch(FRONTEND + '/' + gitFile, {headers:{'accept':'text/plain'}, cf:{cacheTtl:0}});
        if (!source.ok) throw new Error('GitHub source returned ' + source.status);
        const headers = new Headers(isHtml ? HTML_HEADERS : {'content-type':CONTENT_TYPE[path],'cache-control':'no-store, max-age=0','x-content-type-options':'nosniff'});
        // Prevent any old rounded/cached styling from overriding the square board.
        if (path === '/style.css') {
          let css = await source.text();
          css += '\n/* Square chessboard enforcement for mobile and desktop */\n.board { aspect-ratio: 1 / 1 !important; height: auto !important; border-radius: 0 !important; display: grid !important; grid-template-columns: repeat(8,minmax(0,1fr)) !important; grid-template-rows: repeat(8,minmax(0,1fr)) !important; }\n.sq { min-width: 0; min-height: 0; aspect-ratio: 1 / 1; }\n@media (max-width: 860px) { .board { width: 100% !important; max-width: 620px !important; } }\n';
          return new Response(css,{status:200,headers});
        }
        return new Response(source.body,{status:200,headers});
      } catch (err) {
        return new Response(isHtml ? FALLBACK_HTML : 'Source temporarily unavailable',{status:503,headers:{'content-type':isHtml?'text/html':'text/plain','cache-control':'no-store'}});
      }
    }
    if (path === '/api' || path.startsWith('/api/') || path === '/health' || path === '/events') {
      const target = new URL(path + url.search, BACKEND);
      const reqHeaders = new Headers(request.headers);
      reqHeaders.delete('host');
      reqHeaders.delete('cf-connecting-ip');
      reqHeaders.delete('x-forwarded-for');
      reqHeaders.delete('x-real-ip');
      const upstream = new Request(target, {method:request.method,headers:reqHeaders,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'});
      try {
        const response = await fetch(upstream, {cf:{cacheTtl:0}});
        const headers = new Headers(response.headers);
        headers.set('cache-control','no-store');
        if(path === '/events') headers.set('x-accel-buffering','no');
        return new Response(response.body,{status:response.status,headers});
      } catch (err) {
        return Response.json({error:'Chess engine offline: the temporary phone tunnel is unreachable',frontendWorking:true},{status:503,headers:{'cache-control':'no-store'}});
      }
    }
    return new Response('Not found',{status:404});
  }
};
