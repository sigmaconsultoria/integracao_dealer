import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UNIT_CODE_REGEX } from '../../config/env.js';
import { authManager } from '../../services/auth.service.js';

const optionalUnitSchema = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z
    .string()
    .trim()
    .transform((val) => val.toUpperCase())
    .refine(
      (val) => UNIT_CODE_REGEX.test(val),
      'unidade deve conter de 2 a 10 caracteres alfanuméricos, _ ou -'
    )
    .optional()
);

const statusQuerySchema = z.object({
  unidade: optionalUnitSchema,
});

const authorizeUrlQuerySchema = z.object({
  unidade: optionalUnitSchema,
  redirect_uri: z.string().trim().url('redirect_uri deve ser uma URL válida').default('http://localhost'),
});

const verifyQuerySchema = z.object({
  unidade: optionalUnitSchema,
});

const updateRefreshTokenBodySchema = z
  .object({
    unidade: optionalUnitSchema,
    refresh_token: z.string().trim().min(10, 'refresh_token inválido'),
    access_token: z.string().trim().min(10, 'access_token inválido').optional(),
    expires_in: z.number().int().positive().max(31_536_000).optional(),
    validate_now: z.boolean().default(false),
  })
  .strict();

const exchangeCodeBodySchema = z
  .object({
    unidade: optionalUnitSchema,
    code: z.string().trim().min(4, 'code inválido'),
    redirect_uri: z.string().trim().url('redirect_uri deve ser uma URL válida').default('http://localhost'),
  })
  .strict();

/**
 * GET /auth/followize/status
 * Retorna metadados seguros dos tokens armazenados por unidade (ou de uma unidade específica).
 */
export async function getFollowizeTokenStatus(request: FastifyRequest, reply: FastifyReply) {
  const { unidade } = statusQuerySchema.parse(request.query);

  if (unidade) {
    const resolved = authManager.resolveUnit(unidade, { allowSingleDefault: false });
    const status = await authManager.getTokenStatus(resolved);
    return reply.send({
      success: true,
      ...status,
    });
  }

  const units = await authManager.getAllTokenStatuses();
  return reply.send({
    success: true,
    units,
  });
}

/**
 * GET /auth/followize/authorize-url
 * Gera a URL OAuth2 da Followize para autorizar uma unidade e obter um novo code.
 */
export async function getFollowizeAuthorizeUrl(request: FastifyRequest, reply: FastifyReply) {
  const { unidade, redirect_uri } = authorizeUrlQuerySchema.parse(request.query);
  const resolved = authManager.resolveUnit(unidade, { allowSingleDefault: true });
  const authorizeUrl = authManager.getClient(resolved).getAuthorizeUrl(redirect_uri);

  return reply.send({
    success: true,
    unidade: resolved,
    redirect_uri,
    authorize_url: authorizeUrl,
  });
}

/**
 * POST /auth/followize/refresh-token
 * Atualiza e persiste um novo refresh_token de uma unidade em runtime sem alterar o .env.
 */
export async function updateFollowizeRefreshToken(request: FastifyRequest, reply: FastifyReply) {
  const body = updateRefreshTokenBodySchema.parse(request.body);
  const resolved = authManager.resolveUnit(body.unidade, { allowSingleDefault: true });

  const status = await authManager.getClient(resolved).updateRefreshToken({
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
 * Troca o authorization code (ou URL de callback) por access_token e refresh_token de uma unidade.
 */
export async function exchangeFollowizeCode(request: FastifyRequest, reply: FastifyReply) {
  const body = exchangeCodeBodySchema.parse(request.body);
  const resolved = authManager.resolveUnit(body.unidade, { allowSingleDefault: true });

  const status = await authManager
    .getClient(resolved)
    .exchangeAuthorizationCode(body.code, body.redirect_uri);

  return reply.send({
    success: true,
    message: 'Tokens OAuth2 gerados e salvos com segurança.',
    ...status,
  });
}

/**
 * GET /auth/followize/verify
 * Lista lojas e equipes visíveis pela credencial OAuth2 da unidade informada
 * para conferência visual (ex.: confirmar qual conta é PA e qual é AP).
 */
export async function verifyFollowizeAccount(request: FastifyRequest, reply: FastifyReply) {
  const { unidade } = verifyQuerySchema.parse(request.query);
  const resolved = authManager.resolveUnit(unidade, { allowSingleDefault: true });
  const verification = await authManager.getClient(resolved).verifyAccount();

  return reply.send({
    success: true,
    ...verification,
  });
}
