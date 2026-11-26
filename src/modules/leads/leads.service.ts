import { pool } from '../../config/database.js';
import { logger as defaultLogger, type AppLogger } from '../../config/logger.js';
import { AppError } from '../../errors/app-error.js';
import { authManager as defaultAuthManager, type AuthManagerLike } from '../../services/auth.service.js';
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

export type LeadsAuthManagerLike = Pick<
  AuthManagerLike,
  'getUnits' | 'hasUnit' | 'resolveUnit' | 'getClient'
>;

export interface PermittedUnitSummary {
  status: 'ok' | 'error';
  allowed_teams_count: number;
  allowed_locations_count: number;
  total: number;
  aptos_para_finalizar: number;
  live_check_errors: number;
  error?: string;
}

export interface LeadsServiceDeps {
  db?: DbPoolLike;
  authManager?: LeadsAuthManagerLike;
  auth?: AuthClientLike;
  liveCheckConcurrency?: number;
  maxMetadataPages?: number;
  logger?: Pick<AppLogger, 'warn' | 'error'>;
}

function createSingleUnitAuthManager(authClient: AuthClientLike): LeadsAuthManagerLike {
  return {
    getUnits: () => ['MT'],
    hasUnit: (unidade: string) => unidade.trim().toUpperCase() === 'MT',
    resolveUnit: (unidade?: string) => {
      const normalized = typeof unidade === 'string' ? unidade.trim().toUpperCase() : '';
      if (!normalized || normalized === 'MT') {
        return 'MT';
      }
      throw new AppError(
        400,
        `Unidade "${normalized}" não configurada. Unidades disponíveis: MT`,
        'INVALID_UNIT'
      );
    },
    getClient: (unidade: string) => {
      const normalized = unidade.trim().toUpperCase();
      if (normalized !== 'MT') {
        throw new AppError(
          400,
          `Unidade "${normalized}" não configurada. Unidades disponíveis: MT`,
          'INVALID_UNIT'
        );
      }
      return authClient as ReturnType<AuthManagerLike['getClient']>;
    },
  };
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
  private readonly authManager: LeadsAuthManagerLike;
  private readonly liveCheckConcurrency: number;
  private readonly maxMetadataPages: number;
  private readonly logger: Pick<AppLogger, 'warn' | 'error'>;
  private readonly finalizingLeads = new Set<number>();

  constructor(deps: LeadsServiceDeps = {}) {
    this.db = deps.db ?? pool;
    this.authManager =
      deps.authManager ??
      (deps.auth ? createSingleUnitAuthManager(deps.auth) : defaultAuthManager);
    this.liveCheckConcurrency = deps.liveCheckConcurrency ?? 5;
    this.maxMetadataPages = deps.maxMetadataPages ?? 20;
    this.logger = deps.logger ?? defaultLogger;
  }

  private async fetchAllAuthorizedIds(
    authClient: AuthClientLike,
    endpoint: string,
    resourceName: string,
    unidade: string
  ): Promise<number[]> {
    const ids = new Set<number>();
    let page = 1;
    let lastPage = 1;

    while (page <= lastPage) {
      const url = new URL(endpoint);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', '100');

      const res = await authClient.authenticatedFetch(url.toString());
      if (!res.ok) {
        throw new AppError(
          502,
          `Falha ao consultar ${resourceName} da unidade ${unidade} na Followize (HTTP ${res.status})`,
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

  assertUnitAvailable(leadId: number, unidade: string | null): string {
    const normalized = typeof unidade === 'string' ? unidade.trim().toUpperCase() : '';
    if (!normalized || !this.authManager.hasUnit(normalized)) {
      throw new AppError(
        422,
        `Lead ${leadId} pertence à unidade "${normalized || 'desconhecida'}", que não está configurada/disponível nesta instância.`,
        'LEAD_UNIT_UNAVAILABLE'
      );
    }
    return normalized;
  }

  /**
   * Lista os leads que os tokens configurados têm permissão para gerenciar/finalizar,
   * isolando erros por unidade e filtrando contratos pela regional da filial correspondente.
   */
  async getPermittedLeads(options?: {
    days?: number;
    onlyActionable?: boolean;
    liveCheck?: boolean;
    unidade?: string;
  }) {
    const days = options?.days ?? 30;
    const onlyActionable = options?.onlyActionable ?? false;
    const liveCheck = options?.liveCheck ?? true;

    const targetUnits = options?.unidade
      ? [this.authManager.resolveUnit(options.unidade, { allowSingleDefault: false })]
      : this.authManager.getUnits();

    const byUnit: Record<string, PermittedUnitSummary> = {};
    const collectedLeads: Array<{ createdAtMs: number; item: Record<string, any> }> = [];
    let totalAllowedTeams = 0;
    let totalAllowedLocations = 0;
    let totalLiveCheckErrors = 0;
    let succeededUnitsCount = 0;
    const unitErrors: Array<{ unidade: string; error: unknown; message: string }> = [];

    for (const unit of targetUnits) {
      try {
        const authClient = this.authManager.getClient(unit);

        const [allowedTeamIds, allowedLocationIds] = await Promise.all([
          this.fetchAllAuthorizedIds(
            authClient,
            'https://api.followize.com.br/v3/teams',
            'equipes',
            unit
          ),
          this.fetchAllAuthorizedIds(
            authClient,
            'https://api.followize.com.br/v3/locations',
            'lojas',
            unit
          ),
        ]);

        totalAllowedTeams += allowedTeamIds.length;
        totalAllowedLocations += allowedLocationIds.length;

        if (allowedTeamIds.length === 0 || allowedLocationIds.length === 0) {
          byUnit[unit] = {
            status: 'ok',
            allowed_teams_count: allowedTeamIds.length,
            allowed_locations_count: allowedLocationIds.length,
            total: 0,
            aptos_para_finalizar: 0,
            live_check_errors: 0,
          };
          succeededUnitsCount++;
          continue;
        }

        let query = `
          SELECT
              l.id AS lead_id,
              l.name AS lead_name,
              l.status AS lead_status,
              l.unidade AS unidade,
              l.created_at AS lead_created_at,
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
            LEFT JOIN filial fil
              ON UPPER(BTRIM(fil.codadicion)) = UPPER(BTRIM(cc.empresa))
            WHERE regexp_replace(COALESCE(cc.pessoacpfcnpj, ''), '\\D', '', 'g') =
                  regexp_replace(COALESCE(c.id_number, ''), '\\D', '', 'g')
              AND regexp_replace(COALESCE(c.id_number, ''), '\\D', '', 'g') <> ''
              AND (
                CASE fil.regional
                  WHEN 1 THEN 'MT'
                  WHEN 7 THEN 'PA'
                  WHEN 8 THEN 'AP'
                  ELSE NULL
                END = l.unidade
                OR l.unidade NOT IN ('MT', 'PA', 'AP')
              )
            ORDER BY cc.datainclusao DESC NULLS LAST, cc.id DESC
            LIMIT 1
          ) cc ON TRUE
          LEFT JOIN teams t ON t.id = l.team_id
          LEFT JOIN locations loc ON loc.id = l.location_id
          LEFT JOIN last_schedule ls ON ls.lead_id = l.id
          LEFT JOIN finalization f ON f.lead_id = l.id
          WHERE l.created_at >= NOW() - INTERVAL '1 day' * $1
            AND l.unidade = $2
            AND l.team_id = ANY($3::bigint[])
            AND l.location_id = ANY($4::bigint[])
        `;

        if (onlyActionable) {
          query += `
            AND f.id IS NULL
            AND (ls.status IS NULL OR ls.status != 'pending')
          `;
        }

        query += ` ORDER BY l.created_at DESC;`;

        const { rows } = await this.db.query(query, [
          days,
          unit,
          allowedTeamIds,
          allowedLocationIds,
        ]);

        let unitLiveCheckErrors = 0;

        const formattedRows = await mapWithConcurrency(
          rows,
          this.liveCheckConcurrency,
          async (r) => {
            const rowUnidade =
              typeof r.unidade === 'string' && r.unidade.trim()
                ? r.unidade.trim().toUpperCase()
                : unit;
            let isFinalized = Boolean(r.finalization_id) || r.lead_status === 'sale_performed';
            let leadStatus = r.lead_status;
            let scheduleStatus = r.schedule_status;
            let liveCheckOk = true;

            if (!isFinalized && liveCheck) {
              try {
                const liveClient = this.authManager.getClient(rowUnidade);
                const checkRes = await liveClient.authenticatedFetch(
                  `https://api.followize.com.br/v3/leads/${r.lead_id}`
                );

                if (!checkRes.ok) {
                  unitLiveCheckErrors++;
                  liveCheckOk = false;
                  this.logger.warn(
                    { unidade: rowUnidade, leadId: r.lead_id, status: checkRes.status },
                    'Falha na checagem em tempo real do lead na Followize'
                  );
                } else {
                  const checkJson = (await checkRes.json()) as any;
                  const liveLead = checkJson.data || checkJson;

                  if (liveLead.finalization || liveLead.status === 'sale_performed') {
                    isFinalized = true;
                    leadStatus = liveLead.status || 'sale_performed';

                    if (liveLead.finalization?.id) {
                      await this.syncFinalizationRecord(
                        this.db,
                        Number(r.lead_id),
                        liveLead.finalization
                      );
                    }

                    await this.db.query('UPDATE leads SET status = $1 WHERE id = $2;', [
                      leadStatus,
                      r.lead_id,
                    ]);
                  }

                  if (liveLead.last_schedule?.id) {
                    scheduleStatus = liveLead.last_schedule.status || scheduleStatus;
                    await this.syncScheduleRecord(
                      this.db,
                      Number(r.lead_id),
                      liveLead.last_schedule
                    );
                  } else if (liveLead.last_schedule?.status) {
                    scheduleStatus = liveLead.last_schedule.status;
                  }
                }
              } catch (err) {
                unitLiveCheckErrors++;
                liveCheckOk = false;
                this.logger.warn(
                  {
                    unidade: rowUnidade,
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

            const parsedCreatedAt = r.lead_created_at ? Date.parse(String(r.lead_created_at)) : 0;

            return {
              createdAtMs: Number.isNaN(parsedCreatedAt) ? 0 : parsedCreatedAt,
              item: {
                lead_id: r.lead_id,
                unidade: rowUnidade,
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
              },
            };
          }
        );

        const unitLeads = onlyActionable
          ? formattedRows.filter((entry) => entry.item.pode_finalizar)
          : formattedRows;

        totalLiveCheckErrors += unitLiveCheckErrors;
        collectedLeads.push(...unitLeads);

        byUnit[unit] = {
          status: 'ok',
          allowed_teams_count: allowedTeamIds.length,
          allowed_locations_count: allowedLocationIds.length,
          total: unitLeads.length,
          aptos_para_finalizar: unitLeads.filter((entry) => entry.item.pode_finalizar).length,
          live_check_errors: unitLiveCheckErrors,
        };
        succeededUnitsCount++;
      } catch (err) {
        if (targetUnits.length === 1) {
          throw err;
        }

        const errMsg = err instanceof Error ? err.message : String(err);
        unitErrors.push({ unidade: unit, error: err, message: errMsg });
        byUnit[unit] = {
          status: 'error',
          allowed_teams_count: 0,
          allowed_locations_count: 0,
          total: 0,
          aptos_para_finalizar: 0,
          live_check_errors: 0,
          error: errMsg,
        };
        this.logger.warn(
          { unidade: unit, err: errMsg },
          'Falha ao listar leads permitidos da unidade; isolando erro'
        );
      }
    }

    if (succeededUnitsCount === 0 && unitErrors.length > 0) {
      throw new AppError(
        502,
        `Falha ao consultar leads permitidos em todas as unidades: ${unitErrors
          .map((e) => `${e.unidade}: ${e.message}`)
          .join('; ')}`,
        'UPSTREAM_ERROR'
      );
    }

    if (targetUnits.length > 1) {
      collectedLeads.sort((a, b) => b.createdAtMs - a.createdAtMs);
    }

    const leads = collectedLeads.map((entry) => entry.item);

    return {
      allowed_teams_count: totalAllowedTeams,
      allowed_locations_count: totalAllowedLocations,
      total: leads.length,
      aptos_para_finalizar: leads.filter((l) => l.pode_finalizar).length,
      live_check_errors: totalLiveCheckErrors,
      by_unit: byUnit,
      leads,
    };
  }

  /**
   * Consulta os dados do Lead cruzando com checagemcontrato (CPF normalizado + regional via filial)
   * e monta o payload de finalização.
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
      LEFT JOIN filial fil
        ON UPPER(BTRIM(fil.codadicion)) = UPPER(BTRIM(cc.empresa))
      WHERE l.id = $1
        AND (
          CASE fil.regional
            WHEN 1 THEN 'MT'
            WHEN 7 THEN 'PA'
            WHEN 8 THEN 'AP'
            ELSE NULL
          END = l.unidade
          OR l.unidade NOT IN ('MT', 'PA', 'AP')
        )
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
   * Consulta o status atual de finalização e a unidade do lead no banco local.
   */
  async getFinalizationStatus(leadId: number) {
    const { rows } = await this.db.query(
      `SELECT l.status, l.unidade, f.id AS finalization_id
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
        unidade: null as string | null,
        finalizationId: null as number | null,
      };
    }

    const row = rows[0]!;
    const unidade =
      typeof row.unidade === 'string' && row.unidade.trim()
        ? row.unidade.trim().toUpperCase()
        : null;

    return {
      exists: true,
      alreadyFinalized: Boolean(row.finalization_id) || row.status === 'sale_performed',
      status: (row.status as string | null) ?? null,
      unidade,
      finalizationId: row.finalization_id ? Number(row.finalization_id) : null,
    };
  }

  /**
   * Cancela um agendamento pendente na Followize usando exclusivamente o token da unidade do lead.
   */
  async cancelSchedule(
    leadId: number,
    scheduleId: number,
    message = 'Cancelado automaticamente para fechamento de venda',
    unidade?: string
  ) {
    let resolvedUnit: string;
    if (unidade) {
      resolvedUnit = this.assertUnitAvailable(leadId, unidade);
    } else {
      const status = await this.getFinalizationStatus(leadId);
      if (!status.exists) {
        throw new AppError(404, `Lead ${leadId} não encontrado no banco local`, 'LEAD_NOT_FOUND');
      }
      resolvedUnit = this.assertUnitAvailable(leadId, status.unidade);
    }

    const authClient = this.authManager.getClient(resolvedUnit);
    const endpoint = `https://api.followize.com.br/v3/leads/${leadId}/schedules/${scheduleId}/cancel`;

    const res = await authClient.authenticatedFetch(endpoint, {
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
   * verificação de idempotência, roteamento de credencial pela unidade do lead
   * e sincronização do banco local em caso de sucesso.
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
      if (!status.exists) {
        throw new AppError(404, `Lead ${leadId} não encontrado no banco local`, 'LEAD_NOT_FOUND');
      }
      if (status.alreadyFinalized) {
        throw new AppError(
          409,
          `O lead ${leadId} já está finalizado no banco local`,
          'ALREADY_FINALIZED'
        );
      }

      const leadUnidade = this.assertUnitAvailable(leadId, status.unidade);
      const authClient = this.authManager.getClient(leadUnidade);

      const res = await authClient.authenticatedFetch(endpoint, {
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
            unidade: leadUnidade,
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
