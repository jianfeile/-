// Cloudflare Pages Function: /api/unlock  (see server/unlock-core.mjs)
import { handle } from '../../server/unlock-core.mjs';

export const onRequest = (context) => handle(context.request, context.env);
