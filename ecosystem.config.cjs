// pm2 process file for the Netcup ARM VPS.
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup
module.exports = {
  apps: [{
    name: 'omoggle-v2',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      PORT: '8080',
      HOST: '127.0.0.1',
    },
    out_file: './data/pm2.out.log',
    error_file: './data/pm2.err.log',
    merge_logs: true,
    time: true,
  }],
};
