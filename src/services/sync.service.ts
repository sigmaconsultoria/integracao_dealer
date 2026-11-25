import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../config/database.js';
import { logger as defaultLogger, type AppLogger } from '../config/logger.js';
import { AppError } from '../errors/app-error.js';
import type { AuthClientLike, DbClientLike, DbPoolLike } from '../modules/leads/leads.service.js';
import { authService } from './auth.service.js';

const API_URL = 'https://api.followize.com.br/v3/leads';
const DEFAULT_FALLBACK_DATE = '2026-09-01 00:00:00';
const DEFAULT_STATE_PATH = path.resolve(process.cwd(), '.runtime/sync-state.json');
const PER_PAGE = 50;

export interface SyncResult {
  success: boolean;
  startDate: string;
  totalSynced: number;
  pagesProcessed: number;
  resumedFromPending: boolean;
  durationSeconds: number;
  message: string;
}

export interface SyncProgress {
  started_at: string;
  current_page: number;
  last_page: number | null;
  pages_processed: number;
  total_synced: number;
  total_records: number | null;
}

export interface SyncStatusSnapshot {
  in_progress: boolean;
  progress: SyncProgress | null;
  last_completed_at: string | null;
  last_start_date: string | null;
  last_result: SyncResult | null;
  last_error: string | null;
}

export interface SyncServiceDeps {
  db?: DbPoolLike;
  auth?: AuthClientLike;
  statePath?: string;
  maxPages?: number;
  pageDelayMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  logger?: AppLogger;
}

interface SyncStateFile {
  pending_start_date: string | null;
  last_completed_at: string | null;
  last_start_date: string | null;
}

function toNullableString(val: unknown): string | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  return String(val);
}

function toNullableNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

function toNullableBigInt(val: unknown, allowZero = true): number | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  const num = Number(val);
  if (!Number.isInteger(num)) {
    return null;
  }
  return allowZero ? (num >= 0 ? num : null) : num > 0 ? num : null;
}

function toNullableDate(val: unknown): string | null {
  if (typeof val !== 'string') {
    return null;
  }
  const match = val.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match?.[1]) {
    return null;
  }
  const [y, m, d] = match[1].split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m! - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return match[1];
}

function toNullableTimestamp(val: unknown): string | null {
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString();
  }
  if (typeof val !== 'string') {
    return null;
  }
  const trimmed = val.trim();
  if (!trimmed) {
    return null;
  }
  const normalized =
    trimmed.includes(' ') && !trimmed.includes('T') ? trimmed.replace(' ', 'T') : trimmed;
  return Number.isNaN(Date.parse(normalized)) ? null : trimmed;
}

export function normalizeTimestampMs(val: unknown): number | null {
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.getTime();
  }
  if (typeof val !== 'string') {
    return null;
  }
  const trimmed = val.trim();
  if (!trimmed) {
    return null;
  }
  let iso = trimmed.includes(' ') && !trimmed.includes('T') ? trimmed.replace(' ', 'T') : trimmed;
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) {
    iso += '-03:00';
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SyncService {
  private readonly db: DbPoolLike;
  private readonly auth: AuthClientLike;
  private readonly statePath: string;
  private readonly maxPages: number;
  private readonly pageDelayMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly logger: AppLogger;

  private activeSyncStartedAt: string | null = null;
  private activeProgress: SyncProgress | null = null;
  private lastResult: SyncResult | null = null;
  private lastError: string | null = null;

  constructor(deps: SyncServiceDeps = {}) {
    this.db = deps.db ?? pool;
    this.auth = deps.auth ?? authService;
    this.statePath = deps.statePath ?? DEFAULT_STATE_PATH;
    this.maxPages = deps.maxPages ?? 1000;
    this.pageDelayMs = deps.pageDelayMs ?? 150;
    this.maxRetries = deps.maxRetries ?? 3;
    this.retryBaseDelayMs = deps.retryBaseDelayMs ?? 500;
    this.logger = deps.logger ?? defaultLogger;
  }

  private async readSyncState(): Promise<SyncStateFile | null> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<SyncStateFile>;
      return {
        pending_start_date:
          typeof parsed.pending_start_date === 'string' && parsed.pending_start_date.trim()
            ? parsed.pending_start_date.trim()
            : null,
        last_completed_at:
          typeof parsed.last_completed_at === 'string' ? parsed.last_completed_at : null,
        last_start_date:
          typeof parsed.last_start_date === 'string' ? parsed.last_start_date : null,
      };
    } catch {
      return null;
    }
  }

  private async writeSyncState(nextState: SyncStateFile): Promise<void> {
    const dir = path.dirname(this.statePath);
    const tmpPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(nextState, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await fs.rename(tmpPath, this.statePath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      this.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Falha ao persistir estado de watermark em disco'
      );
    }
  }

  /**
   * Obtém a data/hora inicial de sincronização no fuso 'America/Sao_Paulo'.
   * Se houver sync incremental anterior interrompido, retoma do pending_start_date.
   */
  async getIncrementalStartDate(customDate?: string, fullSync = false): Promise<string> {
    const resolved = await this.resolveStartDate(customDate, fullSync);
    return resolved.startDate;
  }

  private async resolveStartDate(
    customDate?: string,
    fullSync = false
  ): Promise<{ startDate: string; resumedFromPending: boolean; prevState: SyncStateFile | null }> {
    const prevState = await this.readSyncState();

    if (fullSync) {
      return { startDate: DEFAULT_FALLBACK_DATE, resumedFromPending: false, prevState };
    }

    if (customDate) {
      return {
        startDate: customDate.replace('T', ' ').substring(0, 19),
        resumedFromPending: false,
        prevState,
      };
    }

    if (prevState?.pending_start_date) {
      return {
        startDate: prevState.pending_start_date,
        resumedFromPending: true,
        prevState,
      };
    }

    const { rows } = await this.db.query(`
      SELECT TO_CHAR(
        (COALESCE(MAX(updated_at), '2026-09-01 00:00:00+00'::timestamptz) AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '3 minutes',
        'YYYY-MM-DD HH24:MI:SS'
      ) AS start_date
      FROM leads;
    `);

    return {
      startDate: rows[0]?.start_date || DEFAULT_FALLBACK_DATE,
      resumedFromPending: false,
      prevState,
    };
  }

  private async fetchPageWithRetry(startDate: string, page: number): Promise<any> {
    const url = new URL(API_URL);
    url.searchParams.set('date_from', startDate);
    url.searchParams.set('date_field', 'updated_at');
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(PER_PAGE));

    let lastStatus: number | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.auth.authenticatedFetch(url.toString(), {
          headers: {
            'User-Agent': 'FollowizeFastifySync/2.0',
          },
        });

        if (res.ok) {
          return await res.json();
        }

        lastStatus = res.status;
        const isRetryable = res.status === 429 || res.status >= 500;
        if (!isRetryable || attempt === this.maxRetries) {
          throw new AppError(
            502,
            `Erro na API Followize (HTTP ${res.status}) na página ${page}`,
            'UPSTREAM_ERROR'
          );
        }

        const retryAfterRaw = res.headers.get('retry-after');
        const retryAfterSec = retryAfterRaw && /^\d+$/.test(retryAfterRaw.trim())
          ? Number(retryAfterRaw.trim())
          : null;
        const delayMs =
          retryAfterSec !== null
            ? Math.min(retryAfterSec * 1000, 30_000)
            : this.retryBaseDelayMs * 2 ** attempt;

        this.logger.warn(
          { status: res.status, page, delayMs, attempt: attempt + 1, maxRetries: this.maxRetries },
          'Erro HTTP transitório ao buscar página na Followize; aguardando retry'
        );
        await sleep(delayMs);
      } catch (err) {
        if (err instanceof AppError) {
          throw err;
        }
        lastError = err;
        const isTransient =
          err instanceof Error &&
          (err.name === 'AbortError' ||
            err.name === 'TimeoutError' ||
            err.name === 'TypeError' ||
            /fetch failed|network|timeout|ECONNRESET|ETIMEDOUT/i.test(err.message));

        if (!isTransient || attempt === this.maxRetries) {
          throw err;
        }

        const delayMs = this.retryBaseDelayMs * 2 ** attempt;
        this.logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            page,
            delayMs,
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
          },
          'Erro de rede ao buscar página na Followize; aguardando retry'
        );
        await sleep(delayMs);
      }
    }

    throw new AppError(
      502,
      `Falha ao consultar página ${page} da Followize${lastStatus ? ` (HTTP ${lastStatus})` : ''}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
      'UPSTREAM_ERROR'
    );
  }

  /**
   * Executa a sincronização incremental completa nas 17 tabelas com lock anti-concorrência,
   * retry com backoff, watermark resiliente e UPSERT em lote via UNNEST.
   */
  async syncLeads(customDate?: string, fullSync = false): Promise<SyncResult> {
    if (this.activeSyncStartedAt) {
      throw new AppError(
        409,
        `Sincronização já está em andamento desde ${this.activeSyncStartedAt}`,
        'SYNC_IN_PROGRESS'
      );
    }

    this.activeSyncStartedAt = new Date().toISOString();
    this.activeProgress = {
      started_at: this.activeSyncStartedAt,
      current_page: 0,
      last_page: null,
      pages_processed: 0,
      total_synced: 0,
      total_records: null,
    };
    this.lastError = null;
    const startTime = Date.now();

    try {
      const { startDate, resumedFromPending, prevState } = await this.resolveStartDate(
        customDate,
        fullSync
      );
      const isIncremental = !customDate && !fullSync;
      const forceUpsert = Boolean(customDate) || fullSync || resumedFromPending;

      if (isIncremental) {
        await this.writeSyncState({
          pending_start_date: startDate,
          last_completed_at: prevState?.last_completed_at ?? null,
          last_start_date: prevState?.last_start_date ?? null,
        });
      }

      let currentPage = 1;
      let lastPage = 1;
      let totalSynced = 0;
      let pagesProcessed = 0;

      this.logger.info(
        { startDate, resumedFromPending },
        'Iniciando sincronização incremental de leads'
      );

      while (currentPage <= lastPage) {
        const json = await this.fetchPageWithRetry(startDate, currentPage);
        const leadsBatch = Array.isArray(json?.data) ? json.data : [];
        const meta = json?.meta || {};
        const parsedLastPage = Number(meta.last_page);
        lastPage =
          Number.isInteger(parsedLastPage) && parsedLastPage >= currentPage
            ? Math.min(parsedLastPage, this.maxPages)
            : currentPage;
        const totalRecords = Number(meta.total ?? leadsBatch.length);

        if (this.activeProgress) {
          this.activeProgress.current_page = currentPage;
          this.activeProgress.last_page = lastPage;
          this.activeProgress.total_records = Number.isFinite(totalRecords) ? totalRecords : null;
        }

        if (!leadsBatch.length || totalRecords === 0) {
          break;
        }

        const client = await this.db.connect();
        try {
          await client.query('BEGIN');
          const savedCount = await this.saveBatch(client, leadsBatch, forceUpsert);
          await client.query('COMMIT');
          totalSynced += savedCount;
          pagesProcessed++;
          if (this.activeProgress) {
            this.activeProgress.pages_processed = pagesProcessed;
            this.activeProgress.total_synced = totalSynced;
          }
          this.logger.info(
            {
              page: currentPage,
              lastPage,
              savedCount,
              totalSynced,
              totalRecords,
            },
            'Página de leads sincronizada'
          );
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw err;
        } finally {
          client.release?.();
        }

        currentPage++;
        if (currentPage <= lastPage) {
          await sleep(this.pageDelayMs);
        }
      }

      if (isIncremental || fullSync) {
        await this.writeSyncState({
          pending_start_date: null,
          last_completed_at: new Date().toISOString(),
          last_start_date: startDate,
        });
      }

      const durationSeconds = Math.round((Date.now() - startTime) / 1000);

      const result: SyncResult = {
        success: true,
        startDate,
        totalSynced,
        pagesProcessed,
        resumedFromPending,
        durationSeconds,
        message: `Sincronização concluída com sucesso. ${totalSynced} leads processados em ${durationSeconds}s.`,
      };

      this.lastResult = result;
      this.lastError = null;
      return result;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.activeSyncStartedAt = null;
      this.activeProgress = null;
    }
  }

  /**
   * Retorna o estado atual da sincronização (em memória + watermark persistido em disco).
   */
  async getSyncStatus(): Promise<SyncStatusSnapshot> {
    const state = await this.readSyncState();
    return {
      in_progress: Boolean(this.activeSyncStartedAt),
      progress: this.activeProgress ? { ...this.activeProgress } : null,
      last_completed_at: state?.last_completed_at ?? null,
      last_start_date: state?.last_start_date ?? null,
      last_result: this.lastResult,
      last_error: this.lastError,
    };
  }

  /**
   * Dispara a sincronização em segundo plano sem bloquear a resposta HTTP.
   */
  startSyncInBackground(customDate?: string, fullSync = false): void {
    if (this.activeSyncStartedAt) {
      throw new AppError(
        409,
        `Sincronização já está em andamento desde ${this.activeSyncStartedAt}`,
        'SYNC_IN_PROGRESS'
      );
    }

    void this.syncLeads(customDate, fullSync).catch((err) => {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Falha na sincronização assíncrona de leads'
      );
    });
  }

  /**
   * Salva o lote de leads nas 17 tabelas com UPSERT em lote via UNNEST.
   */
  private async saveBatch(
    client: DbClientLike,
    batch: any[],
    forceUpsert = false
  ): Promise<number> {
    if (!batch.length) return 0;

    const existingMap = new Map<number, number>();
    if (!forceUpsert) {
      const leadIds = batch
        .map((l) => toNullableBigInt(l?.id, false))
        .filter((id): id is number => id !== null);

      if (leadIds.length > 0) {
        const existingRes = await client.query(
          `SELECT id, updated_at FROM leads WHERE id = ANY($1::bigint[]);`,
          [leadIds]
        );
        for (const row of existingRes.rows) {
          const ms = normalizeTimestampMs(row.updated_at);
          if (ms !== null) {
            existingMap.set(Number(row.id), ms);
          }
        }
      }
    }

    const rawMap = new Map<number, { leadId: number; payloadJson: string }>();
    const attendantsMap = new Map<number, string | null>();
    const teamsMap = new Map<number, string | null>();
    const locationsMap = new Map<number, string | null>();
    const salesmenMap = new Map<number, string | null>();
    const contactsMap = new Map<
      number,
      {
        id: number;
        email: string | null;
        phone: string | null;
        cellphone: string | null;
        id_number: string | null;
        birthdate: string | null;
        attendant_id: number | null;
        team_id: number | null;
      }
    >();
    const addressesMap = new Map<
      number,
      {
        contact_id: number;
        address_line1: string | null;
        address_line2: string | null;
        address_number: string | null;
        neighborhood: string | null;
        city: string | null;
        state: string | null;
        country: string | null;
        zipcode: string | null;
      }
    >();
    const companiesMap = new Map<
      number,
      {
        contact_id: number;
        name: string | null;
        id_number: string | null;
        position: string | null;
        phone: string | null;
        email: string | null;
        website: string | null;
      }
    >();
    const leadsMap = new Map<
      number,
      {
        id: number;
        name: string | null;
        perception: string | null;
        status: string | null;
        conversion_goal: string | null;
        flow: string | null;
        message: string | null;
        integration_third_party_id: string | null;
        custom_key: string | null;
        fbclid: string | null;
        gclid: string | null;
        dsv_id: string | null;
        vehicle_price: string | null;
        contact_id: number | null;
        attendant_id: number | null;
        location_id: number | null;
        team_id: number | null;
        salesman_id: number | null;
        first_interaction_at: string | null;
        last_interaction_at: string | null;
        created_at: string | null;
        updated_at: string | null;
      }
    >();
    const interestsMap = new Map<
      string,
      {
        lead_id: number;
        level: string;
        item_id: number | null;
        name: string | null;
        required: string | null;
      }
    >();
    const scheduleReasonsMap = new Map<number, string | null>();
    const schedulesMap = new Map<
      number,
      {
        id: number;
        lead_id: number;
        date: string | null;
        status: string | null;
        reason_id: number | null;
      }
    >();
    const proposalsMap = new Map<
      number,
      {
        id: number;
        lead_id: number;
        amount: number | null;
      }
    >();
    const unrealizedReasonsMap = new Map<number, string | null>();
    const finalizationsMap = new Map<
      number,
      {
        id: number;
        lead_id: number;
        amount: number | null;
        type_of_sale: string | null;
        invoice_date: string | null;
        order_number: string | null;
        invoice_number: string | null;
        sale_id_number: string | null;
        card_number: string | null;
        message: string | null;
        unrealized_sale_reason_id: number | null;
      }
    >();
    const trackingMap = new Map<
      number,
      {
        lead_id: number;
        oem: string | null;
        source: string | null;
        medium: string | null;
        campaign: string | null;
        format: string | null;
      }
    >();
    const legalBasesMap = new Map<
      number,
      {
        lead_id: number;
        processing_id: number | null;
        processing_name: string | null;
        processing_opt_in: string | null;
        communication_id: number | null;
        communication_name: string | null;
        communication_opt_in: string | null;
      }
    >();

    let processedCount = 0;

    for (const lead of batch) {
      const leadId = toNullableBigInt(lead?.id, false);
      if (leadId === null) continue;

      if (!forceUpsert) {
        const currentDbMs = existingMap.get(leadId);
        const incomingMs = normalizeTimestampMs(lead.updated_at);
        if (currentDbMs !== undefined && incomingMs !== null && currentDbMs === incomingMs) {
          continue;
        }
      }

      processedCount++;

      // 1. Raw Payload
      rawMap.set(leadId, { leadId, payloadJson: JSON.stringify(lead) });

      // 2. Atendentes
      const att = lead.attendant;
      const attId = toNullableBigInt(att?.id, false);
      if (attId !== null) {
        attendantsMap.set(attId, toNullableString(att.name));
      }

      const contact = lead.contact || {};
      const cAtt = contact.attendant;
      const cAttId = toNullableBigInt(cAtt?.id, false);
      if (cAttId !== null) {
        attendantsMap.set(cAttId, toNullableString(cAtt.name));
      }

      // 3. Equipes
      const cTeam = contact.team;
      const cTeamId = toNullableBigInt(cTeam?.id, false);
      if (cTeamId !== null) {
        teamsMap.set(cTeamId, toNullableString(cTeam.name));
      }
      const lTeam = lead.team;
      const lTeamId = toNullableBigInt(lTeam?.id, false);
      if (lTeamId !== null) {
        teamsMap.set(lTeamId, toNullableString(lTeam.name));
      }

      // 4. Lojas / Unidades
      const loc = lead.location;
      const locId = toNullableBigInt(loc?.id, false);
      if (locId !== null) {
        locationsMap.set(locId, toNullableString(loc.name));
      }

      // 5. Vendedores
      const salesman = lead.salesman;
      const salesmanId = toNullableBigInt(salesman?.id, false);
      if (salesmanId !== null) {
        salesmenMap.set(salesmanId, toNullableString(salesman.name));
      }

      // 6. Contato, Endereço e Empresa
      const cId = toNullableBigInt(contact.id, false);
      if (cId !== null) {
        contactsMap.set(cId, {
          id: cId,
          email: toNullableString(contact.email),
          phone: toNullableString(contact.phone),
          cellphone: toNullableString(contact.cellphone),
          id_number: toNullableString(contact.id_number),
          birthdate: toNullableDate(contact.birthdate),
          attendant_id: cAttId,
          team_id: cTeamId,
        });

        const addr = contact.address || {};
        if (
          [
            addr.address_line1,
            addr.address_line2,
            addr.address_number,
            addr.neighborhood,
            addr.city,
            addr.state,
            addr.country,
            addr.zipcode,
          ].some(Boolean)
        ) {
          addressesMap.set(cId, {
            contact_id: cId,
            address_line1: toNullableString(addr.address_line1),
            address_line2: toNullableString(addr.address_line2),
            address_number: toNullableString(addr.address_number),
            neighborhood: toNullableString(addr.neighborhood),
            city: toNullableString(addr.city),
            state: toNullableString(addr.state),
            country: toNullableString(addr.country),
            zipcode: toNullableString(addr.zipcode),
          });
        }

        const comp = contact.company || {};
        if (
          [comp.name, comp.id_number, comp.position, comp.phone, comp.email, comp.website].some(
            Boolean
          )
        ) {
          companiesMap.set(cId, {
            contact_id: cId,
            name: toNullableString(comp.name),
            id_number: toNullableString(comp.id_number),
            position: toNullableString(comp.position),
            phone: toNullableString(comp.phone),
            email: toNullableString(comp.email),
            website: toNullableString(comp.website),
          });
        }
      }

      // 7. Lead Principal
      const ints = lead.interests && typeof lead.interests === 'object' ? lead.interests : null;
      const leadTeamId = toNullableBigInt(lead.team_id, false) ?? lTeamId ?? cTeamId;
      leadsMap.set(leadId, {
        id: leadId,
        name: toNullableString(lead.name),
        perception: toNullableString(lead.perception),
        status: toNullableString(lead.status),
        conversion_goal: toNullableString(lead.conversion_goal),
        flow: toNullableString(lead.flow),
        message: toNullableString(lead.message),
        integration_third_party_id: toNullableString(lead.integration_third_party_id),
        custom_key: toNullableString(lead.custom_key),
        fbclid: toNullableString(lead.fbclid),
        gclid: toNullableString(lead.gclid),
        dsv_id: toNullableString(lead.dsv_id ?? ints?.dsv_id),
        vehicle_price: toNullableString(lead.vehicle_price ?? ints?.vehicle_price),
        contact_id: cId,
        attendant_id: attId,
        location_id: locId,
        team_id: leadTeamId,
        salesman_id: salesmanId,
        first_interaction_at: toNullableTimestamp(lead.first_interaction_at),
        last_interaction_at: toNullableTimestamp(lead.last_interaction_at),
        created_at: toNullableTimestamp(lead.created_at),
        updated_at: toNullableTimestamp(lead.updated_at),
      });

      // 8. Interesses do Lead
      if (ints && !Array.isArray(ints)) {
        for (const key of Object.keys(ints).sort()) {
          if (!key.startsWith('interest_')) continue;
          const item = ints[key];
          if (item && typeof item === 'object' && (item.name || item.id !== undefined)) {
            const itemId = toNullableBigInt(item.id, true);
            const itemName = toNullableString(item.name);
            if (itemName !== null || itemId !== null) {
              interestsMap.set(`${leadId}:${key}`, {
                lead_id: leadId,
                level: key,
                item_id: itemId,
                name: itemName,
                required: toNullableString(item.required),
              });
            }
          }
        }
      }

      // 9. Agendamento
      const sched = lead.last_schedule;
      const schedId = toNullableBigInt(sched?.id, false);
      if (schedId !== null) {
        const reason = sched.reason;
        const reasonId = toNullableBigInt(reason?.id, false);
        if (reasonId !== null) {
          scheduleReasonsMap.set(reasonId, toNullableString(reason.name));
        }

        // Garante unicidade tanto por lead_id quanto por id no mesmo UNNEST
        for (const [existingLeadId, existingSched] of schedulesMap.entries()) {
          if (existingSched.id === schedId && existingLeadId !== leadId) {
            schedulesMap.delete(existingLeadId);
          }
        }
        schedulesMap.set(leadId, {
          id: schedId,
          lead_id: leadId,
          date: toNullableTimestamp(sched.date),
          status: toNullableString(sched.status),
          reason_id: reasonId,
        });
      }

      // 10. Proposta
      const prop = lead.last_proposal;
      const propId = toNullableBigInt(prop?.id, false);
      if (propId !== null) {
        for (const [existingLeadId, existingProp] of proposalsMap.entries()) {
          if (existingProp.id === propId && existingLeadId !== leadId) {
            proposalsMap.delete(existingLeadId);
          }
        }
        proposalsMap.set(leadId, {
          id: propId,
          lead_id: leadId,
          amount: toNullableNumber(prop.amount),
        });
      }

      // 11. Finalização
      const fin = lead.finalization;
      const finId = toNullableBigInt(fin?.id, false);
      if (finId !== null) {
        const uReason = fin.unrealized_sale_reason;
        const uReasonId = toNullableBigInt(uReason?.id, false);
        if (uReasonId !== null) {
          unrealizedReasonsMap.set(uReasonId, toNullableString(uReason.name));
        }

        for (const [existingLeadId, existingFin] of finalizationsMap.entries()) {
          if (existingFin.id === finId && existingLeadId !== leadId) {
            finalizationsMap.delete(existingLeadId);
          }
        }
        finalizationsMap.set(leadId, {
          id: finId,
          lead_id: leadId,
          amount: toNullableNumber(fin.amount),
          type_of_sale: toNullableString(fin.type_of_sale),
          invoice_date: toNullableTimestamp(fin.invoice_date),
          order_number: toNullableString(fin.order_number),
          invoice_number: toNullableString(fin.invoice_number),
          sale_id_number: toNullableString(fin.sale_id_number),
          card_number: toNullableString(fin.card_number),
          message: toNullableString(fin.message),
          unrealized_sale_reason_id: uReasonId,
        });
      }

      // 12. Marketing Tracking
      const track = lead.tracking;
      if (track && typeof track === 'object' && !Array.isArray(track)) {
        trackingMap.set(leadId, {
          lead_id: leadId,
          oem: toNullableString(track.oem),
          source: toNullableString(track.source),
          medium: toNullableString(track.medium),
          campaign: toNullableString(track.campaign),
          format: toNullableString(track.format),
        });
      }

      // 13. Bases Legais LGPD
      const lb = lead.legal_bases;
      if (lb && typeof lb === 'object' && !Array.isArray(lb)) {
        const proc = lb.processing && typeof lb.processing === 'object' ? lb.processing : {};
        const comm =
          lb.communication && typeof lb.communication === 'object' ? lb.communication : {};
        legalBasesMap.set(leadId, {
          lead_id: leadId,
          processing_id: toNullableBigInt(proc.id, true),
          processing_name: toNullableString(proc.name),
          processing_opt_in:
            proc.opt_in !== null && proc.opt_in !== undefined
              ? String(proc.opt_in).toLowerCase()
              : null,
          communication_id: toNullableBigInt(comm.id, true),
          communication_name: toNullableString(comm.name),
          communication_opt_in:
            comm.opt_in !== null && comm.opt_in !== undefined
              ? String(comm.opt_in).toLowerCase()
              : null,
        });
      }
    }

    if (processedCount === 0) {
      return 0;
    }

    // Execução em Lote (UNNEST) respeitando ordem das chaves estrangeiras
    if (rawMap.size > 0) {
      const items = [...rawMap.values()];
      await client.query(
        `INSERT INTO leads_raw (lead_id, payload, synced_at)
         SELECT lead_id, payload, NOW()
         FROM UNNEST($1::bigint[], $2::jsonb[]) AS t(lead_id, payload)
         ON CONFLICT (lead_id) DO UPDATE SET
           payload = EXCLUDED.payload,
           synced_at = EXCLUDED.synced_at;`,
        [items.map((i) => i.leadId), items.map((i) => i.payloadJson)]
      );
    }

    if (attendantsMap.size > 0) {
      const entries = [...attendantsMap.entries()];
      await client.query(
        `INSERT INTO attendants (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (teamsMap.size > 0) {
      const entries = [...teamsMap.entries()];
      await client.query(
        `INSERT INTO teams (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (locationsMap.size > 0) {
      const entries = [...locationsMap.entries()];
      await client.query(
        `INSERT INTO locations (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (salesmenMap.size > 0) {
      const entries = [...salesmenMap.entries()];
      await client.query(
        `INSERT INTO salesmen (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (contactsMap.size > 0) {
      const items = [...contactsMap.values()];
      await client.query(
        `INSERT INTO contacts (id, email, phone, cellphone, id_number, birthdate, attendant_id, team_id)
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::text[],
           $5::text[], $6::date[], $7::bigint[], $8::bigint[]
         )
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           cellphone = EXCLUDED.cellphone,
           id_number = EXCLUDED.id_number,
           birthdate = EXCLUDED.birthdate,
           attendant_id = EXCLUDED.attendant_id,
           team_id = EXCLUDED.team_id;`,
        [
          items.map((i) => i.id),
          items.map((i) => i.email),
          items.map((i) => i.phone),
          items.map((i) => i.cellphone),
          items.map((i) => i.id_number),
          items.map((i) => i.birthdate),
          items.map((i) => i.attendant_id),
          items.map((i) => i.team_id),
        ]
      );
    }

    if (addressesMap.size > 0) {
      const items = [...addressesMap.values()];
      await client.query(
        `INSERT INTO addresses (
           contact_id, address_line1, address_line2, address_number,
           neighborhood, city, state, country, zipcode
         )
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::text[],
           $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]
         )
         ON CONFLICT (contact_id) DO UPDATE SET
           address_line1 = EXCLUDED.address_line1,
           address_line2 = EXCLUDED.address_line2,
           address_number = EXCLUDED.address_number,
           neighborhood = EXCLUDED.neighborhood,
           city = EXCLUDED.city,
           state = EXCLUDED.state,
           country = EXCLUDED.country,
           zipcode = EXCLUDED.zipcode;`,
        [
          items.map((i) => i.contact_id),
          items.map((i) => i.address_line1),
          items.map((i) => i.address_line2),
          items.map((i) => i.address_number),
          items.map((i) => i.neighborhood),
          items.map((i) => i.city),
          items.map((i) => i.state),
          items.map((i) => i.country),
          items.map((i) => i.zipcode),
        ]
      );
    }

    if (companiesMap.size > 0) {
      const items = [...companiesMap.values()];
      await client.query(
        `INSERT INTO companies (contact_id, name, id_number, position, phone, email, website)
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::text[],
           $5::text[], $6::text[], $7::text[]
         )
         ON CONFLICT (contact_id) DO UPDATE SET
           name = EXCLUDED.name,
           id_number = EXCLUDED.id_number,
           position = EXCLUDED.position,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           website = EXCLUDED.website;`,
        [
          items.map((i) => i.contact_id),
          items.map((i) => i.name),
          items.map((i) => i.id_number),
          items.map((i) => i.position),
          items.map((i) => i.phone),
          items.map((i) => i.email),
          items.map((i) => i.website),
        ]
      );
    }

    if (leadsMap.size > 0) {
      const items = [...leadsMap.values()];
      await client.query(
        `INSERT INTO leads (
           id, name, perception, status, conversion_goal, flow, message,
           integration_third_party_id, custom_key, fbclid, gclid, dsv_id,
           vehicle_price, contact_id, attendant_id, location_id, team_id,
           salesman_id, first_interaction_at, last_interaction_at, created_at, updated_at
         )
         SELECT * FROM UNNEST(
           $1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
           $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
           $13::text[], $14::bigint[], $15::bigint[], $16::bigint[], $17::bigint[],
           $18::bigint[], $19::timestamptz[], $20::timestamptz[], $21::timestamptz[], $22::timestamptz[]
         )
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           perception = EXCLUDED.perception,
           status = EXCLUDED.status,
           conversion_goal = EXCLUDED.conversion_goal,
           flow = EXCLUDED.flow,
           message = EXCLUDED.message,
           integration_third_party_id = EXCLUDED.integration_third_party_id,
           custom_key = EXCLUDED.custom_key,
           fbclid = EXCLUDED.fbclid,
           gclid = EXCLUDED.gclid,
           dsv_id = EXCLUDED.dsv_id,
           vehicle_price = EXCLUDED.vehicle_price,
           contact_id = EXCLUDED.contact_id,
           attendant_id = EXCLUDED.attendant_id,
           location_id = EXCLUDED.location_id,
           team_id = EXCLUDED.team_id,
           salesman_id = EXCLUDED.salesman_id,
           first_interaction_at = EXCLUDED.first_interaction_at,
           last_interaction_at = EXCLUDED.last_interaction_at,
           created_at = COALESCE(EXCLUDED.created_at, leads.created_at),
           updated_at = EXCLUDED.updated_at;`,
        [
          items.map((i) => i.id),
          items.map((i) => i.name),
          items.map((i) => i.perception),
          items.map((i) => i.status),
          items.map((i) => i.conversion_goal),
          items.map((i) => i.flow),
          items.map((i) => i.message),
          items.map((i) => i.integration_third_party_id),
          items.map((i) => i.custom_key),
          items.map((i) => i.fbclid),
          items.map((i) => i.gclid),
          items.map((i) => i.dsv_id),
          items.map((i) => i.vehicle_price),
          items.map((i) => i.contact_id),
          items.map((i) => i.attendant_id),
          items.map((i) => i.location_id),
          items.map((i) => i.team_id),
          items.map((i) => i.salesman_id),
          items.map((i) => i.first_interaction_at),
          items.map((i) => i.last_interaction_at),
          items.map((i) => i.created_at),
          items.map((i) => i.updated_at),
        ]
      );
    }

    if (interestsMap.size > 0) {
      const items = [...interestsMap.values()];
      await client.query(
        `INSERT INTO lead_interests (lead_id, level, item_id, name, required)
         SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::bigint[], $4::text[], $5::text[])
         ON CONFLICT (lead_id, level) DO UPDATE SET
           item_id = EXCLUDED.item_id,
           name = EXCLUDED.name,
           required = EXCLUDED.required;`,
        [
          items.map((i) => i.lead_id),
          items.map((i) => i.level),
          items.map((i) => i.item_id),
          items.map((i) => i.name),
          items.map((i) => i.required),
        ]
      );
    }

    if (scheduleReasonsMap.size > 0) {
      const entries = [...scheduleReasonsMap.entries()];
      await client.query(
        `INSERT INTO schedule_reasons (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (schedulesMap.size > 0) {
      const items = [...schedulesMap.values()];
      await client.query(
        `INSERT INTO last_schedule (id, lead_id, date, status, reason_id)
         SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::timestamptz[], $4::text[], $5::bigint[])
         ON CONFLICT (lead_id) DO UPDATE SET
           id = EXCLUDED.id,
           date = EXCLUDED.date,
           status = EXCLUDED.status,
           reason_id = EXCLUDED.reason_id;`,
        [
          items.map((i) => i.id),
          items.map((i) => i.lead_id),
          items.map((i) => i.date),
          items.map((i) => i.status),
          items.map((i) => i.reason_id),
        ]
      );
    }

    if (proposalsMap.size > 0) {
      const items = [...proposalsMap.values()];
      await client.query(
        `INSERT INTO last_proposal (id, lead_id, amount)
         SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::numeric[])
         ON CONFLICT (lead_id) DO UPDATE SET
           id = EXCLUDED.id,
           amount = EXCLUDED.amount;`,
        [items.map((i) => i.id), items.map((i) => i.lead_id), items.map((i) => i.amount)]
      );
    }

    if (unrealizedReasonsMap.size > 0) {
      const entries = [...unrealizedReasonsMap.entries()];
      await client.query(
        `INSERT INTO unrealized_sale_reasons (id, name)
         SELECT * FROM UNNEST($1::bigint[], $2::text[])
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
        [entries.map(([id]) => id), entries.map(([, name]) => name)]
      );
    }

    if (finalizationsMap.size > 0) {
      const items = [...finalizationsMap.values()];
      await client.query(
        `INSERT INTO finalization (
           id, lead_id, amount, type_of_sale, invoice_date, order_number,
           invoice_number, sale_id_number, card_number, message, unrealized_sale_reason_id
         )
         SELECT * FROM UNNEST(
           $1::bigint[], $2::bigint[], $3::numeric[], $4::text[], $5::timestamptz[],
           $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::bigint[]
         )
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
          items.map((i) => i.id),
          items.map((i) => i.lead_id),
          items.map((i) => i.amount),
          items.map((i) => i.type_of_sale),
          items.map((i) => i.invoice_date),
          items.map((i) => i.order_number),
          items.map((i) => i.invoice_number),
          items.map((i) => i.sale_id_number),
          items.map((i) => i.card_number),
          items.map((i) => i.message),
          items.map((i) => i.unrealized_sale_reason_id),
        ]
      );
    }

    if (trackingMap.size > 0) {
      const items = [...trackingMap.values()];
      await client.query(
        `INSERT INTO tracking (lead_id, oem, source, medium, campaign, format)
         SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         ON CONFLICT (lead_id) DO UPDATE SET
           oem = EXCLUDED.oem,
           source = EXCLUDED.source,
           medium = EXCLUDED.medium,
           campaign = EXCLUDED.campaign,
           format = EXCLUDED.format;`,
        [
          items.map((i) => i.lead_id),
          items.map((i) => i.oem),
          items.map((i) => i.source),
          items.map((i) => i.medium),
          items.map((i) => i.campaign),
          items.map((i) => i.format),
        ]
      );
    }

    if (legalBasesMap.size > 0) {
      const items = [...legalBasesMap.values()];
      await client.query(
        `INSERT INTO legal_bases (
           lead_id, processing_id, processing_name, processing_opt_in,
           communication_id, communication_name, communication_opt_in
         )
         SELECT * FROM UNNEST(
           $1::bigint[], $2::bigint[], $3::text[], $4::text[],
           $5::bigint[], $6::text[], $7::text[]
         )
         ON CONFLICT (lead_id) DO UPDATE SET
           processing_id = EXCLUDED.processing_id,
           processing_name = EXCLUDED.processing_name,
           processing_opt_in = EXCLUDED.processing_opt_in,
           communication_id = EXCLUDED.communication_id,
           communication_name = EXCLUDED.communication_name,
           communication_opt_in = EXCLUDED.communication_opt_in;`,
        [
          items.map((i) => i.lead_id),
          items.map((i) => i.processing_id),
          items.map((i) => i.processing_name),
          items.map((i) => i.processing_opt_in),
          items.map((i) => i.communication_id),
          items.map((i) => i.communication_name),
          items.map((i) => i.communication_opt_in),
        ]
      );
    }

    return processedCount;
  }
}

export const syncService = new SyncService();
