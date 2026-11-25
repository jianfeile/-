// Cloudflare Pages Function: /api/sync  (see server/admin-core.mjs)
import { sync } from '../../server/admin-core.mjs';

export const onRequest = (context) => sync(context.request, context.env, context.request.cf);
