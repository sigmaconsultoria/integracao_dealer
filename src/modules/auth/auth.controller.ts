import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authService } from '../../services/auth.service.js';

const authorizeUrlQuerySchema = z.object({
  redirect_uri: z.string().trim().url('redirect_uri deve ser uma URL válida').default('http://localhost'),
});

const updateRefreshTokenBodySchema = z
  .object({
    refresh_token: z.string().trim().min(10, 'refresh_token inválido'),
    access_token: z.string().trim().min(10, 'access_token inválido').optional(),
    expires_in: z.number().int().positive().max(31_536_000).optional(),
    validate_now: z.boolean().default(false),
  })
  .strict();

const exchangeCodeBodySchema = z
  .object({
    code: z.string().trim().min(4, 'code inválido'),
    redirect_uri: z.string().trim().url('redirect_uri deve ser uma URL válida').default('http://localhost'),
  })
  .strict();

/**
 * GET /auth/followize/status
 * Retorna metadados seguros do token armazenado (sem nunca expor tokens).
 */
export async function getFollowizeTokenStatus(_request: FastifyRequest, reply: FastifyReply) {
  const status = await authService.getTokenStatus();
  return reply.send({
    success: true,
    ...status,
  });
}

/**
 * GET /auth/followize/authorize-url
 * Gera a URL OAuth2 da Followize para autorizar e obter um novo code.
 */
export async function getFollowizeAuthorizeUrl(request: FastifyRequest, reply: FastifyReply) {
  const { redirect_uri } = authorizeUrlQuerySchema.parse(request.query);
  const authorizeUrl = authService.getAuthorizeUrl(redirect_uri);

  return reply.send({
    success: true,
    redirect_uri,
    authorize_url: authorizeUrl,
  });
}

/**
 * POST /auth/followize/refresh-token
 * Atualiza e persiste um novo refresh_token em runtime sem precisar alterar o .env.
 */
export async function updateFollowizeRefreshToken(request: FastifyRequest, reply: FastifyReply) {
  const body = updateRefreshTokenBodySchema.parse(request.body);

  const status = await authService.updateRefreshToken({
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    validateNow: body.validate_now,
  });

  return reply.send({
    success: true,
    message: 'Refresh token atualizado e salvo com segurança.',
    ...status,
  });
}

/**
 * POST /auth/followize/exchange
 * Troca o authorization code (ou URL completa de callback) por access_token e refresh_token.
 */
export async function exchangeFollowizeCode(request: FastifyRequest, reply: FastifyReply) {
  const body = exchangeCodeBodySchema.parse(request.body);
  const status = await authService.exchangeAuthorizationCode(body.code, body.redirect_uri);

  return reply.send({
    success: true,
    message: 'Tokens OAuth2 gerados e salvos com segurança.',
    ...status,
  });
}
