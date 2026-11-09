import { Pool } from 'pg';
import { readConfig } from './config.js';
import { PayPal } from './paypal.js';
import { createApp } from './app.js';

const config = readConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
const server = createApp(pool, config, new PayPal(config)).listen(
  Number(process.env.PORT || 3000),
  '127.0.0.1',
  function () {
    console.log(
      'PayTrack API: http://127.0.0.1:' + (process.env.PORT || 3000) + ' (PayPal Sandbox only)'
    );
  }
);

async function shutdown() {
  server.close(async function () {
    await pool.end();
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
