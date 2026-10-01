FROM node:20-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm install
COPY web ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY db ./db
COPY --from=web /public ./public
ENV NODE_ENV=production
# código da versão (a hospedagem preenche); aparece na Administração
ARG SOURCE_COMMIT
ENV SOURCE_COMMIT=${SOURCE_COMMIT}
EXPOSE 3000
CMD ["sh", "-c", "node src/migrate.js && node src/index.js"]
