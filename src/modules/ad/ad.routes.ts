import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { processAdSsvCallback } from './ad.service.js';

export async function adRoutes(app: FastifyInstance): Promise<void> {

  // ── GET /api/ad/admob-ssv ───────────────────────────────────────────────────
  // Called by AdMob servers — no auth. Must return 200 always (non-2xx = AdMob retries = duplicate grants).
  app.get('/admob-ssv', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as Record<string, string>;

      const {
        transaction_id,
        custom_data,
        reward_amount,
        reward_item,
        signature,
        key_id,
        ...rest
      } = query;

      if (!transaction_id || !custom_data || !reward_amount || !signature || !key_id) {
        console.warn('[AdSSV] Missing required params:', query);
        return reply.status(200).send('ok'); // Still 200 — don't trigger retry
      }

      // Reconstruct query string without the signature param (AdMob signs everything else)
      const paramsWithoutSig = new URLSearchParams();
      for (const [k, v] of Object.entries({ transaction_id, custom_data, reward_amount, reward_item, key_id, ...rest })) {
        if (v !== undefined) paramsWithoutSig.set(k, v);
      }
      // AdMob canonical order: sort by key
      const sortedParams = new URLSearchParams([...paramsWithoutSig.entries()].sort(([a], [b]) => a.localeCompare(b)));
      const rawQueryStringWithoutSignature = sortedParams.toString();

      await processAdSsvCallback({
        transaction_id,
        custom_data,
        reward_amount,
        reward_item,
        signature,
        key_id,
        rawQueryStringWithoutSignature,
      });
    } catch (err) {
      // Log but never propagate — AdMob must not retry
      console.error('[AdSSV] Error processing callback:', err);
    }

    return reply.status(200).send('ok');
  });
}
