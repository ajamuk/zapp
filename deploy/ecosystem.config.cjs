// PM2: pm2 start deploy/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [{
    name: 'metro-setter',
    script: 'src/index.js',
    cwd: __dirname + '/..',
    instances: 1, // una sola instancia: el bucle de respuestas no está pensado para varias
    autorestart: true,
    max_memory_restart: '400M',
    env: { NODE_ENV: 'production' },
  }],
};
