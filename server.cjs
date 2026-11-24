'use strict';

import('./dist/server.js').catch((err) => {
  console.error('Falha ao iniciar servidor ESM via Passenger bridge:', err);
  process.exit(1);
});
