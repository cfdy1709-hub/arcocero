#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Necesitas instalar Node.js 22.13 o superior: https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
(sleep 2; (command -v open >/dev/null && open http://localhost:3000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000)) &
npm start
