FROM bitnami/node:18.12.1-debian-11-r12

COPY src/package.json /app/
RUN npm install

COPY src/app.js /app/app.js
COPY src/public /app/public
COPY src/miraco-007-V2-win.svg /app/miraco-007-V2-win.svg

CMD ["npm", "run", "app"]