import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UNIT_CODE_REGEX } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { syncScheduler } from '../../services/scheduler.service.js';
import { syncService } from '../../services/sync.service.js';
import { leadsService, type FinalizationPayload } from './leads.service.js';

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

function queryBoolean(defaultValue: boolean) {
  return z.preprocess((val) => {
    if (val === undefined || val === null) return defaultValue;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const normalized = val.trim().toLowerCase();
      if (normalized === '') return defaultValue;
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
    }
    return val;
  }, z.boolean());
}

function isValidCalendarDateTime(value: string): boolean {
  const [datePart, timePart] = value.split(/[ T]/);
  if (!datePart) return false;

  const [yStr, mStr, dStr] = datePart.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const dt = new Date(Date.UTC(year, month - 1, day));

  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return false;
  }

  if (timePart) {
    const [hhStr, mmStr, ssStr] = timePart.split(':');
    const hh = Number(hhStr);
    const mm = Number(mmStr);
    const ss = Number(ssStr);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) {
      return false;
    }
  }

  return true;
}

const leadIdParamSchema = z.object({
  id: z.coerce.number().int().positive('O ID do lead informado deve ser um inteiro positivo'),
});

const permittedLeadsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  only_actionable: queryBoolean(false),
  live_check: queryBoolean(true),
  unidade: optionalUnitSchema,
});

const syncDateSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/,
    'custom_date deve estar no formato YYYY-MM-DD ou YYYY-MM-DD HH:mm:ss'
  )
  .refine(isValidCalendarDateTime, 'custom_date não representa uma data/hora válida')
  .transform((val) => val.replace('T', ' '));

const syncQuerySchema = z.object({
  custom_date: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    syncDateSchema.optional()
  ),
  full: queryBoolean(false),
  unidade: optionalUnitSchema,
});

const typeOfSaleEnum = z.enum([
  'cash',
  'internal_financing',
  'external_financing',
  'consortium',
  'consortium_letter',
  'vehicle_subscription',
  'other',
]);

const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de data deve ser YYYY-MM-DD')
  .refine(isValidCalendarDateTime, 'Data inválida no calendário');

const baseFinalizationObjectSchema = z
  .object({
    billed: z.boolean(),
    billed_at: isoDateString.optional(),
    order_number: z.string().min(1).max(100).optional(),
    amount: z.number().nonnegative().optional(),
    sale_id_number: z
      .string()
      .regex(/^\d{11,14}$/, 'CPF/CNPJ deve conter apenas dígitos (11 a 14 caracteres)')
      .optional(),
    invoice_number: z.string().min(1).max(100).optional(),
    invoice_date: isoDateString.optional(),
    type_of_sale: typeOfSaleEnum.optional(),
    message: z.string().max(1000).optional(),
    salesman_id: z.number().int().positive().optional(),
    card_number: z.string().max(100).optional(),
  })
  .strict();

const finalizationOverrideSchema = baseFinalizationObjectSchema.partial().strict();

const finalizationPayloadSchema = baseFinalizationObjectSchema.superRefine((data, ctx) => {
  if (data.billed) {
    if (!data.invoice_number) {
      ctx.addIssue({
        code: 'custom',
        path: ['invoice_number'],
        message: 'invoice_number é obrigatório quando billed=true',
      });
    }
    if (!data.invoice_date) {
      ctx.addIssue({
        code: 'custom',
        path: ['invoice_date'],
        message: 'invoice_date é obrigatório quando billed=true',
      });
    }
  } else if (!data.billed_at) {
    ctx.addIssue({
      code: 'custom',
      path: ['billed_at'],
      message: 'billed_at é obrigatório quando billed=false',
    });
  }
});

const finalizeBodySchema = z
  .object({
    payload: finalizationOverrideSchema.optional(),
    simulate: z.boolean().default(false),
    cancel_pending_schedule: z.boolean().default(false),
    cancel_message: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .optional()
  .default({
    simulate: false,
    cancel_pending_schedule: false,
  });

/**
 * GET /leads/permitidos
 * Lista os leads que o token atual tem permissão para finalizar,
 * indicando se está pronto para finalizar ou se tem bloqueios (agendamento pendente/já finalizado).
 */
export async function getPermittedLeads(request: FastifyRequest, reply: FastifyReply) {
  const { days, only_actionable, live_check, unidade } = permittedLeadsQuerySchema.parse(
    request.query
  );

  const result = await leadsService.getPermittedLeads({
    days,
    onlyActionable: only_actionable,
    liveCheck: live_check,
    ...(unidade ? { unidade } : {}),
  });

  return reply.send({
    success: true,
    ...result,
  });
}

/**
 * GET /leads/:id/finalize
 * Pré-visualização somente leitura do payload montado automaticamente.
 * Nunca executa cancelamento ou finalização na Followize.
 */
export async function previewFinalization(request: FastifyRequest, reply: FastifyReply) {
  const { id: leadId } = leadIdParamSchema.parse(request.params);

  const [basePayload, pendingSchedule, finStatus] = await Promise.all([
    leadsService.buildFinalizationPayload(leadId),
    leadsService.getPendingSchedule(leadId),
    leadsService.getFinalizationStatus(leadId),
  ]);

  if (!basePayload) {
    return reply.status(404).send({
      success: false,
      error: `Não foi encontrado contrato em checagemcontrato para o lead ${leadId}`,
    });
  }

  return reply.send({
    success: true,
    lead_id: leadId,
    unidade: finStatus.unidade,
    simulated: true,
    message: 'Pré-visualização somente leitura. Nenhuma alteração foi realizada na Followize.',
    target_endpoint: `https://api.followize.com.br/v3/leads/${leadId}/finalization/realized_sale`,
    already_finalized: finStatus.alreadyFinalized,
    has_pending_schedule: Boolean(pendingSchedule),
    pending_schedule: pendingSchedule,
    payload_ready: basePayload,
  });
}

/**
 * POST /leads/:id/finalize
 * Valida payload/parâmetros e executa a finalização na Followize (ou simula se simulate=true).
 */
export async function finalizeLead(request: FastifyRequest, reply: FastifyReply) {
  const { id: leadId } = leadIdParamSchema.parse(request.params);
  const body = finalizeBodySchema.parse(request.body);
  const isSimulation = body.simulate;

  let leadUnidade: string | undefined;
  if (!isSimulation) {
    const finStatus = await leadsService.getFinalizationStatus(leadId);
    if (!finStatus.exists) {
      throw new AppError(404, `Lead ${leadId} não encontrado no banco local`, 'LEAD_NOT_FOUND');
    }
    if (finStatus.alreadyFinalized) {
      throw new AppError(
        409,
        `O lead ${leadId} já está finalizado no banco local`,
        'ALREADY_FINALIZED'
      );
    }
    leadUnidade = leadsService.assertUnitAvailable(leadId, finStatus.unidade);
  }

  // 1. Gera o payload base a partir do banco de dados
  const basePayload = await leadsService.buildFinalizationPayload(leadId);

  if (!basePayload) {
    return reply.status(404).send({
      success: false,
      error: `Não foi encontrado contrato em checagemcontrato para o lead ${leadId}`,
    });
  }

  // 2. Mescla overrides customizados e valida o payload final completo
  const mergedPayload: FinalizationPayload = finalizationPayloadSchema.parse({
    ...basePayload,
    ...(body.payload || {}),
  });

  const cancelPending = body.cancel_pending_schedule;
  let scheduleCanceledInfo: Record<string, unknown> | null = null;

  // 3. Se solicitado, verifica e cancela agendamento pendente antes de finalizar
  if (cancelPending) {
    const pendingSched = await leadsService.getPendingSchedule(leadId);
    if (pendingSched) {
      if (isSimulation) {
        scheduleCanceledInfo = {
          simulated: true,
          schedule_id: pendingSched.id,
          action: 'cancel_schedule',
          target_endpoint: `https://api.followize.com.br/v3/leads/${leadId}/schedules/${pendingSched.id}/cancel`,
        };
      } else {
        const cancelMsg =
          body.cancel_message || 'Cancelado automaticamente para fechamento de venda';
        const cancelRes = await leadsService.cancelSchedule(
          leadId,
          pendingSched.id,
          cancelMsg,
          leadUnidade
        );
        scheduleCanceledInfo = {
          simulated: false,
          schedule_id: pendingSched.id,
          canceled: true,
          response: cancelRes,
        };
      }
    }
  }

  // 4. Executa a finalização (ou simulação)
  const result = await leadsService.executeFinalization(leadId, mergedPayload, isSimulation);

  if (!isSimulation && !result.success) {
    const upstreamStatus =
      typeof result.status_code === 'number' &&
      result.status_code >= 400 &&
      result.status_code < 600
        ? result.status_code
        : 502;

    return reply.status(upstreamStatus).send({
      success: false,
      lead_id: leadId,
      endpoint_destino: `https://api.followize.com.br/v3/leads/${leadId}/finalization/realized_sale`,
      schedule_canceled: scheduleCanceledInfo,
      ...result,
    });
  }

  return reply.send({
    success: true,
    lead_id: leadId,
    endpoint_destino: `https://api.followize.com.br/v3/leads/${leadId}/finalization/realized_sale`,
    schedule_canceled: scheduleCanceledInfo,
    ...result,
  });
}

/**
 * POST /leads/sync
 * Rota para atualizar e sincronizar novos leads do Followize para o PostgreSQL em segundo plano
 */
export async function syncDatabase(request: FastifyRequest, reply: FastifyReply) {
  const { custom_date, full, unidade } = syncQuerySchema.parse(request.query);

  syncService.startSyncInBackground(custom_date, full, unidade);

  return reply.status(202).send({
    success: true,
    accepted: true,
    message: 'Sincronização iniciada em segundo plano.',
    sync: await syncService.getSyncStatus(),
  });
}

/**
 * GET /leads/sync/status
 * Retorna status e próximas execuções do agendador cron e da sincronização
 */
export async function getSyncSchedulerStatus(_request: FastifyRequest, reply: FastifyReply) {
  return reply.send({
    success: true,
    scheduler: syncScheduler.getStatus(),
    sync: await syncService.getSyncStatus(),
  });
}
