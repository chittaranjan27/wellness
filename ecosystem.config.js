/**
 * PM2 Ecosystem Configuration
 * For deploying on traditional VPS with FastPanel
 */
module.exports = {
  apps: [
    {
      name: 'ai-agent-saas',
      script: 'npm',
      args: 'start',
      cwd: '/var/www/wellness', // TODO: Update with your actual deployment path before production deploy
      instances: 1,
      exec_mode: 'fork', // Use fork mode for Node.js (not cluster)
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '1G',
    },
  ],
}
