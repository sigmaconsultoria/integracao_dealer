import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const DEFAULT_BASE_URL = process.env.API_URL?.trim() || 'http://localhost:3333';
const DEFAULT_REDIRECT_URI = 'http://localhost';
const REQUEST_TIMEOUT_MS = 20_000;
const UNIT_CODE_REGEX = /^[A-Z0-9_-]{2,10}$/;

function normalizeBaseUrl(raw) {
  const candidate = (raw.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('A URL base deve começar com http:// ou https://');
  }
  return candidate;
}

function parseYesDefault(raw) {
  const val = raw.trim().toLowerCase();
  if (!val) return true;
  return !['n', 'nao', 'não', 'no', 'false', '0'].includes(val);
}

function getSuggestedUnits() {
  const raw = process.env.FOLLOWIZE_UNITS?.trim();
  if (!raw) {
    return ['MT', 'PA', 'AP'];
  }
  const units = Array.from(
    new Set(
      raw
        .split(',')
        .map((u) => u.trim().toUpperCase())
        .filter((u) => UNIT_CODE_REGEX.test(u))
    )
  );
  return units.length > 0 ? units : ['MT', 'PA', 'AP'];
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const bodyText = await res.text();
  let json = null;
  try {
    json = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    json = null;
  }

  return { status: res.status, ok: res.ok, json, raw: bodyText };
}

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    console.log('===============================================================');
    console.log('  Atualizador de Token Followize (Multi-Unidade) -> Leads API');
    console.log('===============================================================\n');

    const rawUrl = await rl.question(`URL da API [${DEFAULT_BASE_URL}]: `);
    const baseUrl = normalizeBaseUrl(rawUrl);

    let apiKey = process.env.API_KEY?.trim() || '';
    if (apiKey) {
      console.log('API_KEY carregada automaticamente do .env local.');
    } else {
      apiKey = (await rl.question('API_KEY (X-API-Key): ')).trim();
      if (!apiKey) {
        throw new Error('API_KEY é obrigatória.');
      }
    }

    const suggestedUnits = getSuggestedUnits();
    const defaultUnit = suggestedUnits[0] || 'MT';
    const rawUnit = await rl.question(
      `\nQual unidade deseja atualizar (${suggestedUnits.join(', ')}) [${defaultUnit}]: `
    );
    const unidade = (rawUnit.trim() || defaultUnit).toUpperCase();
    if (!UNIT_CODE_REGEX.test(unidade)) {
      throw new Error(
        `Unidade inválida: "${unidade}". Use de 2 a 10 caracteres alfanuméricos, _ ou -.`
      );
    }

    console.log(`\nUnidade selecionada: ${unidade}`);
    console.log('Escolha o modo:');
    console.log('  [1] Enviar refresh_token diretamente (POST /auth/followize/refresh-token)');
    console.log('  [2] Gerar novo token pelo navegador via OAuth2 (GET authorize-url + POST exchange)');
    const rawMode = (await rl.question('Modo [1]: ')).trim() || '1';

    let result;

    if (rawMode === '1') {
      const refreshToken = (await rl.question('\nCole o novo refresh_token: ')).trim();
      if (refreshToken.length < 10) {
        throw new Error('refresh_token inválido (muito curto).');
      }

      const validateAnswer = await rl.question(
        'Validar imediatamente na Followize antes de salvar? (S/n) [S]: '
      );
      const validateNow = parseYesDefault(validateAnswer);

      console.log(`\nEnviando refresh_token da unidade ${unidade} para a API...`);
      result = await requestJson(`${baseUrl}/auth/followize/refresh-token`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          unidade,
          refresh_token: refreshToken,
          validate_now: validateNow,
        }),
      });
    } else if (rawMode === '2') {
      const rawRedirect = await rl.question(`\nRedirect URI [${DEFAULT_REDIRECT_URI}]: `);
      const redirectUri = rawRedirect.trim() || DEFAULT_REDIRECT_URI;

      console.log(`\nGerando URL de autorização para ${unidade} na API...`);
      const authUrlRes = await requestJson(
        `${baseUrl}/auth/followize/authorize-url?unidade=${encodeURIComponent(unidade)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
        {
          method: 'GET',
          headers: {
            'X-API-Key': apiKey,
            Accept: 'application/json',
          },
        }
      );

      if (!authUrlRes.ok || !authUrlRes.json?.authorize_url) {
        console.error(`\n[ERRO HTTP ${authUrlRes.status}] Falha ao gerar URL de autorização:`);
        console.error(authUrlRes.json ?? authUrlRes.raw);
        process.exitCode = 1;
        return;
      }

      console.log('\n---------------------------------------------------------------');
      console.log(`Abra esta URL no navegador para autorizar a unidade ${unidade}:`);
      console.log(authUrlRes.json.authorize_url);
      console.log('---------------------------------------------------------------\n');

      const code = (
        await rl.question('Cole o "code" (ou a URL inteira redirecionada pelo navegador): ')
      ).trim();
      if (code.length < 4) {
        throw new Error('Código de autorização inválido.');
      }

      console.log(`\nTrocando code pelos tokens da unidade ${unidade} e salvando na API...`);
      result = await requestJson(`${baseUrl}/auth/followize/exchange`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          unidade,
          code,
          redirect_uri: redirectUri,
        }),
      });
    } else {
      throw new Error(`Modo inválido: "${rawMode}". Escolha 1 ou 2.`);
    }

    if (!result.ok) {
      console.error(`\n[ERRO HTTP ${result.status}] A API rejeitou a atualização:`);
      console.error(result.json ?? result.raw);
      process.exitCode = 1;
      return;
    }

    console.log('\n[SUCESSO] Resposta da API:');
    console.log(JSON.stringify(result.json, null, 2));

    console.log(`\nConsultando lojas e equipes da credencial ${unidade} (GET /auth/followize/verify)...`);
    const verifyRes = await requestJson(
      `${baseUrl}/auth/followize/verify?unidade=${encodeURIComponent(unidade)}`,
      {
        method: 'GET',
        headers: {
          'X-API-Key': apiKey,
          Accept: 'application/json',
        },
      }
    );

    if (verifyRes.ok && verifyRes.json) {
      const locations = Array.isArray(verifyRes.json.locations) ? verifyRes.json.locations : [];
      const teams = Array.isArray(verifyRes.json.teams) ? verifyRes.json.teams : [];

      console.log(`\n=== Conferência da Conta (${verifyRes.json.unidade || unidade}) ===`);
      console.log(`Lojas (${locations.length}):`);
      for (const loc of locations) {
        console.log(`  - [${loc.id}] ${loc.name}`);
      }
      console.log(`Equipes (${teams.length}):`);
      for (const team of teams) {
        console.log(`  - [${team.id}] ${team.name}`);
      }
    } else {
      console.warn(
        `\n[AVISO HTTP ${verifyRes.status}] Não foi possível consultar /auth/followize/verify agora:`
      );
      console.warn(verifyRes.json ?? verifyRes.raw);
    }

    console.log('\nVerificando /ready...');
    const readyRes = await requestJson(`${baseUrl}/ready`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    console.log(`GET /ready -> HTTP ${readyRes.status}:`);
    const readyUnits = readyRes.json?.checks?.followize_units;
    if (readyUnits && typeof readyUnits === 'object') {
      console.log('Status por unidade:');
      for (const [unitName, info] of Object.entries(readyUnits)) {
        console.log(
          `  - ${unitName}: ${info.status} (refresh_token=${info.has_refresh_token}, access_token_valido=${info.has_valid_access_token})`
        );
      }
    }
    console.log(JSON.stringify(readyRes.json ?? readyRes.raw, null, 2));

    if (!readyRes.ok || readyRes.json?.status === 'not_ready') {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('\n[FALHA]', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

void main();
