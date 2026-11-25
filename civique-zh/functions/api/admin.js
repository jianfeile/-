// Cloudflare Pages Function: /api/admin  (see server/admin-core.mjs)
import { admin } from '../../server/admin-core.mjs';

export const onRequest = (context) => admin(context.request, context.env, context.request.cf);
