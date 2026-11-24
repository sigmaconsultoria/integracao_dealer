import { buildApp } from './app.js';
import { pool } from './config/database.js';
import { env } from './config/env.js';
import { syncScheduler } from './services/scheduler.service.js';

async function main() {
  const app = buildApp();
  let isShuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info({ reason }, 'Encerrando servidor...');
    try {
      syncScheduler.stop();
      await app.close();
      await pool.end();
      process.exit(exitCode);
    } catch (err) {
      app.log.error({ err }, 'Erro durante graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'Uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  try {
    const address = await app.listen({
      port: env.PORT,
      host: env.HOST,
    });

    app.log.info(`Servidor Fastify rodando em: ${address}`);
    syncScheduler.start();
  } catch (err) {
    app.log.error({ err }, 'Falha ao iniciar servidor Fastify');
    syncScheduler.stop();
    await pool.end().catch(() => undefined);
    process.exit(1);
  }
}

main();
