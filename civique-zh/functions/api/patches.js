// Cloudflare Pages Function: /api/patches  (see server/admin-core.mjs)
import { patches } from '../../server/admin-core.mjs';

export const onRequest = (context) => patches(context.request, context.env, context.request.cf);
