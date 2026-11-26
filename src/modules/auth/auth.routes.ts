import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import {
  exchangeFollowizeCode,
  getFollowizeAuthorizeUrl,
  getFollowizeTokenStatus,
  updateFollowizeRefreshToken,
  verifyFollowizeAccount,
} from './auth.controller.js';

export interface AuthRoutesOptions {
  rateLimitMax?: number;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const globalMax = options.rateLimitMax ?? env.RATE_LIMIT_MAX;

  app.get('/followize/status', getFollowizeTokenStatus);

  app.get('/followize/authorize-url', getFollowizeAuthorizeUrl);

  app.post(
    '/followize/refresh-token',
    {
      config: {
        rateLimit: {
          max: Math.min(10, globalMax),
          timeWindow: '1 minute',
        },
      },
    },
    updateFollowizeRefreshToken
  );

  app.post(
    '/followize/exchange',
    {
      config: {
        rateLimit: {
          max: Math.min(10, globalMax),
          timeWindow: '1 minute',
        },
      },
    },
    exchangeFollowizeCode
  );

  app.get(
    '/followize/verify',
    {
      config: {
        rateLimit: {
          max: Math.min(10, globalMax),
          timeWindow: '1 minute',
        },
      },
    },
    verifyFollowizeAccount
  );
};
