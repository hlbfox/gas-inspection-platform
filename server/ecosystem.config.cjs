module.exports = {
  apps: [
    {
      name: 'gasms-api',
      script: '/tmp/gasms-source/server/index.js',
      env: {
        PORT: 3001,
        JWT_SECRET: process.env.JWT_SECRET || 'gasmspoc_jwt_default',
        ADMIN_EMAIL: 'warm_sun@live.cn'
      }
    },
    {
      name: 'gasms-tunnel',
      script: '/tmp/gasms-source/server/tunnel-wrapper.mjs',
      env: {
        PATH: process.env.PATH
      }
    }
  ]
};
