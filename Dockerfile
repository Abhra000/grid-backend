# Grid Matrix Portal API — runs as its own container, separate from the CRM
FROM node:20-alpine
WORKDIR /app
COPY api/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY api/ ./
COPY db/ /db/
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server.js"]
