import { pool } from '../../config/database.js';
import { logger as defaultLogger, type AppLogger } from '../../config/logger.js';
import { AppError } from '../../errors/app-error.js';
import { authService } from '../../services/auth.service.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';

export interface FinalizationPayload {
  billed: boolean;
  billed_at?: string;
  order_number?: string;
  amount?: number;
  sale_id_number?: string;
  invoice_number?: string;
  invoice_date?: string;
  type_of_sale?:
    | 'cash'
    | 'internal_financing'
    | 'external_financing'
    | 'consortium'
    | 'consortium_letter'
    | 'vehicle_subscription'
    | 'other';
  message?: string;
  salesman_id?: number;
  card_number?: string;
}

export interface DbClientLike {
  query<T extends Record<string, any> = Record<string, any>>(
    text: string,
    values?: any[]
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  release?: () => void;
}

export interface DbPoolLike {
  query<T extends Record<string, any> = Record<string, any>>(
    text: string,
    values?: any[]
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  connect(): Promise<DbClientLike>;
}

export interface AuthClientLike {
  authenticatedFetch(url: string, options?: RequestInit): Promise<Response>;
}

export interface LeadsServiceDeps {
  db?: DbPoolLike;
  auth?: AuthClientLike;
  liveCheckConcurrency?: number;
  maxMetadataPages?: number;
  logger?: Pick<AppLogger, 'warn' | 'error'>;
}

export function formatDateOnly(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return undefined;
    }
    const year = String(value.getFullYear());
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1];
  }

  return undefined;
}

export class LeadsService {
  private readonly db: DbPoolLike;
  private readonly auth: AuthClientLike;
  private readonly liveCheckConcurrency: number;
  private readonly maxMetadataPages: number;
  private readonly logger: Pick<AppLogger, 'warn' | 'error'>;
  private readonly finalizingLeads = new Set<number>();

  constructor(deps: LeadsServiceDeps = {}) {
    this.db = deps.db ?? pool;
    this.auth = deps.auth ?? authService;
    this.liveCheckConcurrency = deps.liveCheckConcurrency ?? 5;
    this.maxMetadataPages = deps.maxMetadataPages ?? 20;
    this.logger = deps.logger ?? defaultLogger;
  }

  private async fetchAllAuthorizedIds(endpoint: string, resourceName: string): Promise<number[]> {
    const ids = new Set<number>();
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage) {
      const url = new URL(endpoint);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', '100');

      const res = await this.auth.authenticatedFetch(url.toString());
      if (!res.ok) {
        throw new AppError(
          502,
          `Falha ao consultar ${resourceName} na Followize (HTTP ${res.status})`,
          'UPSTREAM_ERROR'
        );
      }

      const json = (await res.json()) as {
        data?: Array<{ id?: unknown }>;
        meta?: { last_page?: unknown };
      };

      const items = Array.isArray(json?.data) ? json.data : [];
      for (const item of items) {
        const numericId = Number(item?.id);
        if (Number.isInteger(numericId) && numericId > 0) {
          ids.add(numericId);
        }
      }

      const parsedLastPage = Number(json?.meta?.last_page);
      lastPage =
        Number.isInteger(parsedLastPage) && parsedLastPage >= page
          ? Math.min(parsedLastPage, this.maxMetadataPages)
          : page;
      page++;
    }

    return [...ids];
  }

  private async syncFinalizationRecord(
    client: DbClientLike,
    leadId: number,
    fin: Record<string, any>
  ): Promise<void> {
    if (!fin?.id) {
      return;
    }

    const uReason = fin.unrealized_sale_reason;
    if (uReason?.id) {
      await client.query(
        `INSERT INTO unrealized_sale_reasons (id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [uReason.id, uReason.name ?? null]
      );
    }

    await client.query(
      `INSERT INTO finalization (
         id, lead_id, amount, type_of_sale, invoice_date, order_number,
         invoice_number, sale_id_number, card_number, message, unrealized_sale_reason_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (lead_id) DO UPDATE SET
         id = EXCLUDED.id,
         amount = EXCLUDED.amount,
         type_of_sale = EXCLUDED.type_of_sale,
         invoice_date = EXCLUDED.invoice_date,
         order_number = EXCLUDED.order_number,
         invoice_number = EXCLUDED.invoice_number,
         sale_id_number = EXCLUDED.sale_id_number,
         card_number = EXCLUDED.card_number,
         message = EXCLUDED.message,
         unrealized_sale_reason_id = EXCLUDED.unrealized_sale_reason_id;`,
      [
        fin.id,
        leadId,
        fin.amount ?? null,
        fin.type_of_sale ?? null,
        fin.invoice_date ?? null,
        fin.order_number !== null && fin.order_number !== undefined ? String(fin.order_number) : null,
        fin.invoice_number !== null && fin.invoice_number !== undefined
          ? String(fin.invoice_number)
          : null,
        fin.sale_id_number ?? null,
        fin.card_number ?? null,
        fin.message ?? null,
        uReason?.id ?? null,
      ]
    );
  }

  private async syncScheduleRecord(
    client: DbClientLike,
    leadId: number,
    sched: Record<string, any>
  ): Promise<void> {
    if (!sched?.id) {
      return;
    }

    const reason = sched.reason;
    if (reason?.id) {
      await client.query(
        `INSERT INTO schedule_reasons (id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [reason.id, reason.name ?? null]
      );
    }

    await client.query(
      `INSERT INTO last_schedule (id, lead_id, date, status, reason_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lead_id) DO UPDATE SET
         id = EXCLUDED.id,
         date = EXCLUDED.date,
         status = EXCLUDED.status,
         reason_id = EXCLUDED.reason_id;`,
      [sched.id, leadId, sched.date ?? null, sched.status ?? null, reason?.id ?? null]
    );
  }

  /**
   * Lista os leads que o token atual tem permissão para gerenciar/finalizar
   * cruzando com as equipes e lojas autorizadas pela API da Followize.
   */
  async getPermittedLeads(options?: {
    days?: number;
    onlyActionable?: boolean;
    liveCheck?: boolean;
  }) {
    const days = options?.days ?? 30;
    const onlyActionable = options?.onlyActionable ?? false;
    const liveCheck = options?.liveCheck ?? true;

    // 1. Busca equipes e unidades autorizadas na Followize (com paginação e validação HTTP)
    const [allowedTeamIds, allowedLocationIds] = await Promise.all([
      this.fetchAllAuthorizedIds('https://api.followize.com.br/v3/teams', 'equipes'),
      this.fetchAllAuthorizedIds('https://api.followize.com.br/v3/locations', 'lojas'),
    ]);

    if (allowedTeamIds.length === 0 || allowedLocationIds.length === 0) {
      return {
        allowed_teams_count: allowedTeamIds.length,
        allowed_locations_count: allowedLocationIds.length,
        total: 0,
        aptos_para_finalizar: 0,
        live_check_errors: 0,
        leads: [],
      };
    }

    // 2. Consulta no PostgreSQL os leads desses times/locais cruzando com o contrato mais recente (CPF normalizado)
    let query = `
      SELECT
          l.id AS lead_id,
          l.name AS lead_name,
          l.status AS lead_status,
          t.name AS team_name,
          loc.name AS location_name,
          c.id_number AS cpf,
          cc.proposta,
          cc.data_contrato,
          cc.valorprimeiraparcela,
          cc.plano,
          cc.prazo,
          cc.modelo,
          ls.status AS schedule_status,
          f.id AS finalization_id
      FROM leads l
      INNER JOIN contacts c ON c.id = l.contact_id
      INNER JOIN LATERAL (
        SELECT
          cc.proposta,
          TO_CHAR(
            COALESCE(cc.datavenda, (cc.datainclusao AT TIME ZONE 'America/Sao_Paulo')::date),
            'YYYY-MM-DD'
          ) AS data_contrato,
          cc.valorprimeiraparcela,
          cc.plano,
          cc.prazo,
          cc.modelo
        FROM checagemcontrato cc
        WHERE regexp_replace(COALESCE(cc.pessoacpfcnpj, ''), '\\D', '', 'g') =
              regexp_replace(COALESCE(c.id_number, ''), '\\D', '', 'g')
          AND regexp_replace(COALESCE(c.id_number, ''), '\\D', '', 'g') <> ''
        ORDER BY cc.datainclusao DESC NULLS LAST, cc.id DESC
        LIMIT 1
      ) cc ON TRUE
      LEFT JOIN teams t ON t.id = l.team_id
      LEFT JOIN locations loc ON loc.id = l.location_id
      LEFT JOIN last_schedule ls ON ls.lead_id = l.id
      LEFT JOIN finalization f ON f.lead_id = l.id
      WHERE l.created_at >= NOW() - INTERVAL '1 day' * $1
        AND l.team_id = ANY($2::bigint[])
        AND l.location_id = ANY($3::bigint[])
    `;

    if (onlyActionable) {
      query += `
        AND f.id IS NULL
        AND (ls.status IS NULL OR ls.status != 'pending')
      `;
    }

    query += ` ORDER BY l.created_at DESC;`;

    const { rows } = await this.db.query(query, [days, allowedTeamIds, allowedLocationIds]);

    let liveCheckErrors = 0;

    // 3. Verificação em tempo real com concorrência limitada
    const formattedLeads = await mapWithConcurrency(
      rows,
      this.liveCheckConcurrency,
      async (r) => {
        let isFinalized = Boolean(r.finalization_id) || r.lead_status === 'sale_performed';
        let leadStatus = r.lead_status;
        let scheduleStatus = r.schedule_status;
        let liveCheckOk = true;

        if (!isFinalized && liveCheck) {
          try {
            const checkRes = await this.auth.authenticatedFetch(
              `https://api.followize.com.br/v3/leads/${r.lead_id}`
            );

            if (!checkRes.ok) {
              liveCheckErrors++;
              liveCheckOk = false;
              this.logger.warn(
                { leadId: r.lead_id, status: checkRes.status },
                'Falha na checagem em tempo real do lead na Followize'
              );
            } else {
              const checkJson = (await checkRes.json()) as any;
              const liveLead = checkJson.data || checkJson;

              if (liveLead.finalization || liveLead.status === 'sale_performed') {
                isFinalized = true;
                leadStatus = liveLead.status || 'sale_performed';

                if (liveLead.finalization?.id) {
                  await this.syncFinalizationRecord(this.db, Number(r.lead_id), liveLead.finalization);
                }

                await this.db.query('UPDATE leads SET status = $1 WHERE id = $2;', [
                  leadStatus,
                  r.lead_id,
                ]);
              }

              if (liveLead.last_schedule?.id) {
                scheduleStatus = liveLead.last_schedule.status || scheduleStatus;
                await this.syncScheduleRecord(this.db, Number(r.lead_id), liveLead.last_schedule);
              } else if (liveLead.last_schedule?.status) {
                scheduleStatus = liveLead.last_schedule.status;
              }
            }
          } catch (err) {
            liveCheckErrors++;
            liveCheckOk = false;
            this.logger.warn(
              {
                leadId: r.lead_id,
                err: err instanceof Error ? err.message : String(err),
              },
              'Erro transitório ao consultar lead na Followize'
            );
          }
        }

        const hasPendingSchedule = scheduleStatus === 'pending';
        const canFinalize = !isFinalized && !hasPendingSchedule;

        let statusReason = 'Pronto para finalizar';
        if (isFinalized) statusReason = 'Já finalizado anteriormente no CRM';
        else if (hasPendingSchedule) statusReason = 'Possui agendamento pendente';

        return {
          lead_id: r.lead_id,
          lead_name: r.lead_name,
          lead_status: leadStatus,
          cpf: r.cpf,
          proposta: r.proposta,
          data_contrato: r.data_contrato,
          valor: r.valorprimeiraparcela,
          plano: r.plano,
          prazo: r.prazo,
          modelo: r.modelo,
          equipe: r.team_name,
          loja: r.location_name,
          agendamento: scheduleStatus || 'nenhum',
          finalizado: isFinalized,
          pode_finalizar: canFinalize,
          motivo_status: statusReason,
          live_check_ok: liveCheckOk,
        };
      }
    );

    const leads = onlyActionable
      ? formattedLeads.filter((l) => l.pode_finalizar)
      : formattedLeads;

    return {
      allowed_teams_count: allowedTeamIds.length,
      allowed_locations_count: allowedLocationIds.length,
      total: leads.length,
      aptos_para_finalizar: leads.filter((l) => l.pode_finalizar).length,
      live_check_errors: liveCheckErrors,
      leads,
    };
  }

  /**
   * Consulta os dados do Lead cruzando com checagemcontrato (CPF normalizado) e monta o payload.
   */
  async buildFinalizationPayload(leadId: number): Promise<FinalizationPayload | null> {
    const query = `
      SELECT
          l.id AS lead_id,
          c.id_number AS cpf,
          cc.proposta,
          TO_CHAR(
            COALESCE(cc.datavenda, (cc.datainclusao AT TIME ZONE 'America/Sao_Paulo')::date),
            'YYYY-MM-DD'
          ) AS datavenda,
          cc.valorprimeiraparcela,
          cc.plano,
          cc.prazo,
          cc.modelo
      FROM leads l
      INNER JOIN contacts c ON c.id = l.contact_id
      INNER JOIN checagemcontrato cc
        ON regexp_replace(COALESCE(cc.pessoacpfcnpj, ''), '\\D', '', 'g') =
           regexp_replace(COALESCE(c.id_number, ''), '\\D', '', 'g')
       AND regexp_replace(COALESCE(c.id_number, ''), '\\D', '', 'g') <> ''
      WHERE l.id = $1
      ORDER BY cc.datainclusao DESC NULLS LAST, cc.id DESC
      LIMIT 1;
    `;

    const { rows } = await this.db.query(query, [leadId]);

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0]!;
    const dateStr = formatDateOnly(row.datavenda);
    const cleanedCpf = String(row.cpf || '').replace(/\D/g, '');

    const rawAmount =
      row.valorprimeiraparcela !== null && row.valorprimeiraparcela !== undefined
        ? Number(row.valorprimeiraparcela)
        : 0;
    const amount = Number.isFinite(rawAmount) ? rawAmount : 0;

    const messageParts = [`Nro Proposta: ${row.proposta}`];
    if (row.plano) messageParts.push(`Plano: ${row.plano}`);
    if (row.prazo) messageParts.push(`Prazo: ${row.prazo}`);

    return {
      billed: true,
      order_number: String(row.proposta),
      amount,
      ...(cleanedCpf ? { sale_id_number: cleanedCpf } : {}),
      invoice_number: String(row.proposta),
      ...(dateStr ? { invoice_date: dateStr } : {}),
      type_of_sale: 'consortium',
      message: messageParts.join(' \n '),
    };
  }

  /**
   * Consulta o status atual de finalização do lead no banco local.
   */
  async getFinalizationStatus(leadId: number) {
    const { rows } = await this.db.query(
      `SELECT l.status, f.id AS finalization_id
       FROM leads l
       LEFT JOIN finalization f ON f.lead_id = l.id
       WHERE l.id = $1
       LIMIT 1;`,
      [leadId]
    );

    if (rows.length === 0) {
      return {
        exists: false,
        alreadyFinalized: false,
        status: null as string | null,
        finalizationId: null as number | null,
      };
    }

    const row = rows[0]!;
    return {
      exists: true,
      alreadyFinalized: Boolean(row.finalization_id) || row.status === 'sale_performed',
      status: (row.status as string | null) ?? null,
      finalizationId: row.finalization_id ? Number(row.finalization_id) : null,
    };
  }

  /**
   * Cancela um agendamento pendente na Followize.
   */
  async cancelSchedule(
    leadId: number,
    scheduleId: number,
    message = 'Cancelado automaticamente para fechamento de venda'
  ) {
    const endpoint = `https://api.followize.com.br/v3/leads/${leadId}/schedules/${scheduleId}/cancel`;

    const res = await this.auth.authenticatedFetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      throw new AppError(
        res.status >= 400 && res.status < 600 ? res.status : 502,
        `Falha ao cancelar agendamento ${scheduleId} na Followize (HTTP ${res.status})`,
        'CANCEL_SCHEDULE_FAILED'
      );
    }

    await this.db.query(
      `UPDATE last_schedule SET status = 'unrealized' WHERE lead_id = $1 AND id = $2;`,
      [leadId, scheduleId]
    );

    return data;
  }

  /**
   * Busca agendamento pendente de um lead.
   */
  async getPendingSchedule(leadId: number) {
    const { rows } = await this.db.query(
      `SELECT id, status, date FROM last_schedule WHERE lead_id = $1 AND status = 'pending' LIMIT 1;`,
      [leadId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Executa a finalização real contra a API da Followize com trava de concorrência,
   * verificação de idempotência e sincronização do banco local em caso de sucesso.
   */
  async executeFinalization(leadId: number, payload: FinalizationPayload, simulate = false) {
    const endpoint = `https://api.followize.com.br/v3/leads/${leadId}/finalization/realized_sale`;

    if (simulate) {
      return {
        simulated: true,
        message: 'Modo simulação ativado. Nenhuma alteração foi realizada na Followize.',
        target_endpoint: endpoint,
        payload_ready: payload,
      };
    }

    if (this.finalizingLeads.has(leadId)) {
      throw new AppError(
        409,
        `Já existe uma finalização em andamento para o lead ${leadId}`,
        'FINALIZATION_IN_PROGRESS'
      );
    }

    this.finalizingLeads.add(leadId);
    try {
      const status = await this.getFinalizationStatus(leadId);
      if (status.alreadyFinalized) {
        throw new AppError(
          409,
          `O lead ${leadId} já está finalizado no banco local`,
          'ALREADY_FINALIZED'
        );
      }

      const res = await this.auth.authenticatedFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = (await res.json().catch(() => null)) as Record<string, any> | null;

      if (!res.ok) {
        return {
          simulated: false,
          status_code: res.status,
          success: false,
          local_db_synced: false,
          response_api: data,
        };
      }

      let localDbSynced = false;
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE leads SET status = 'sale_performed', updated_at = NOW() WHERE id = $1;`,
          [leadId]
        );

        const finContainer =
          data && typeof data === 'object' ? (data.data ?? data) : null;
        const finObj =
          finContainer && typeof finContainer === 'object'
            ? (finContainer.finalization ?? finContainer)
            : null;
        const finId = finObj?.id ?? finContainer?.id ?? null;

        if (finId) {
          await this.syncFinalizationRecord(client, leadId, {
            id: finId,
            amount: finObj?.amount ?? payload.amount ?? null,
            type_of_sale: finObj?.type_of_sale ?? payload.type_of_sale ?? null,
            invoice_date: finObj?.invoice_date ?? payload.invoice_date ?? null,
            order_number: finObj?.order_number ?? payload.order_number ?? null,
            invoice_number: finObj?.invoice_number ?? payload.invoice_number ?? null,
            sale_id_number: finObj?.sale_id_number ?? payload.sale_id_number ?? null,
            card_number: finObj?.card_number ?? payload.card_number ?? null,
            message: finObj?.message ?? payload.message ?? null,
            unrealized_sale_reason: finObj?.unrealized_sale_reason ?? null,
          });
        }

        await client.query('COMMIT');
        localDbSynced = true;
      } catch (dbErr) {
        await client.query('ROLLBACK').catch(() => undefined);
        this.logger.warn(
          {
            leadId,
            err: dbErr instanceof Error ? dbErr.message : String(dbErr),
          },
          'Finalização do lead teve sucesso na Followize, mas falhou ao atualizar o banco local'
        );
      } finally {
        client.release?.();
      }

      return {
        simulated: false,
        status_code: res.status,
        success: true,
        local_db_synced: localDbSynced,
        response_api: data,
      };
    } finally {
      this.finalizingLeads.delete(leadId);
    }
  }
}

export const leadsService = new LeadsService();
