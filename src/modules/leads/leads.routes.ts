import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import {
  finalizeLead,
  getPermittedLeads,
  getSyncSchedulerStatus,
  previewFinalization,
  syncDatabase,
} from './leads.controller.js';

export interface LeadsRoutesOptions {
  rateLimitMax?: number;
}

export const leadsRoutes: FastifyPluginAsync<LeadsRoutesOptions> = async (app, options) => {
  const globalMax = options.rateLimitMax ?? env.RATE_LIMIT_MAX;

  // Sincronização do banco de dados a partir da API da Followize
  app.post(
    '/sync',
    {
      config: {
        rateLimit: {
          max: Math.min(5, globalMax),
          timeWindow: '1 minute',
        },
      },
    },
    syncDatabase
  );

  // Status e próximas execuções do agendador cron de sincronização
  app.get('/sync/status', getSyncSchedulerStatus);

  // Lista leads que o token atual tem permissão para gerenciar/finalizar
  app.get('/permitidos', getPermittedLeads);

  // Pré-visualização somente leitura do payload montado automaticamente (nunca dispara na Followize)
  app.get('/:id/finalize', previewFinalization);

  // Valida overrides e executa finalização (ou simulação quando simulate=true)
  app.post(
    '/:id/finalize',
    {
      config: {
        rateLimit: {
          max: Math.min(20, globalMax),
          timeWindow: '1 minute',
        },
      },
    },
    finalizeLead
  );
};
