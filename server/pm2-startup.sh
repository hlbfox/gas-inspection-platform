sudo env PATH=$PATH:/opt/homebrew/Cellar/node/25.9.0_2/bin /opt/homebrew/lib/node_modules/pm2/bin/pm2 startup launchd -u fox --hp /Users/fox
pm2 start /tmp/gasms-source/server/index.js --name gasms-api --update-env
pm2 start /tmp/gasms-source/server/tunnel-wrapper.mjs --name gasms-tunnel
pm2 save
