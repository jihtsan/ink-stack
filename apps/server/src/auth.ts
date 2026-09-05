import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function installAuth(app: FastifyInstance, password: string, origin: string, secure: boolean) {
  if (password.length < 16) throw new Error('Administrator password must contain at least 16 characters');
  const salt = randomBytes(16);
  const expected = scryptSync(password, salt, 32);
  const sessions = new Map<string, number>();
  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 10, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET','HEAD'].includes(request.method) && request.headers.origin !== origin) return reply.code(403).send({ error: 'origin_rejected' });
    if (request.url.split('?')[0] === '/api/session' && request.method === 'POST') return;
    const token = request.cookies.ink_session;
    if (!token || (sessions.get(digest(token)) ?? 0) < Date.now()) return reply.code(401).send({ error: 'authentication_required' });
  });
  app.post<{Body:{password:string}}>('/api/session', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: { type:'object', additionalProperties:false, required:['password'], properties:{password:{type:'string',maxLength:256}} } }
  }, async (request, reply) => {
    const actual = scryptSync(request.body.password, salt, 32);
    if (!timingSafeEqual(expected, actual)) return reply.code(401).send({error:'invalid_credentials'});
    const now = Date.now();
    for (const [id, expiry] of sessions) if (expiry < now) sessions.delete(id);
    if (sessions.size >= 50) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token), now + 12*3600_000);
    // OAuth returns through a top-level cross-site GET. Lax preserves that
    // callback cookie while the callback still relies on the session-bound
    // state, exact redirect URI, and Origin checks for state-changing APIs.
    reply.setCookie('ink_session',token,{httpOnly:true,sameSite:'lax',secure,path:'/',maxAge:12*3600});
    return {ok:true};
  });
  app.get('/api/session', async()=>({authenticated:true}));
  app.delete('/api/session', async(request,reply)=>{
    if (request.cookies.ink_session) sessions.delete(digest(request.cookies.ink_session));
    reply.clearCookie('ink_session',{path:'/'});
    return {ok:true};
  });
}
