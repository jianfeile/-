// Cloudflare Pages Function: /api/sales  (see server/sales-core.mjs)
import { handle } from '../../server/sales-core.mjs';

export const onRequest = (context) => handle(context.request, context.env);
