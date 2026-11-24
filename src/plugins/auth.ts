import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestHookHandler } from 'fastify';

function sha256Buffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function extractApiKey(headers: FastifyRequest['headers']): string | null {
  const rawApiKey = headers['x-api-key'];
  if (typeof rawApiKey === 'string') {
    const trimmed = rawApiKey.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const rawAuthorization = headers.authorization;
  if (typeof rawAuthorization === 'string') {
    const match = rawAuthorization.trim().match(/^Bearer\s+(\S+)$/i);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}

export function verifyApiKey(providedKey: string, validKeys: string[]): boolean {
  if (!providedKey || validKeys.length === 0) {
    return false;
  }

  const providedDigest = sha256Buffer(providedKey);
  let matched = false;

  for (const validKey of validKeys) {
    if (!validKey) continue;
    const validDigest = sha256Buffer(validKey);
    if (timingSafeEqual(providedDigest, validDigest)) {
      matched = true;
    }
  }

  return matched;
}

export function createApiKeyAuthHook(validKeys: string[]): onRequestHookHandler {
  return async (request, reply) => {
    if (request.method === 'OPTIONS') {
      return;
    }

    const providedKey = extractApiKey(request.headers);

    if (!providedKey) {
      reply.header('WWW-Authenticate', 'Bearer realm="leads-api"');
      return reply.status(401).send({
        success: false,
        error: 'Autenticação obrigatória. Envie Authorization: Bearer <API_KEY> ou X-API-Key.',
      });
    }

    if (!verifyApiKey(providedKey, validKeys)) {
      reply.header('WWW-Authenticate', 'Bearer realm="leads-api"');
      return reply.status(401).send({
        success: false,
        error: 'Chave de API inválida.',
      });
    }
  };
}
